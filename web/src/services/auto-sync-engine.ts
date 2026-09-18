/**
 * 无感静默同步引擎。
 *
 * ## 它解决什么
 *
 * 原来 WebDAV 备份是纯手动的：管理员在配置弹窗里点「立即同步」，普通成员根本没有入口。
 * 结果是"服务器上只有管理员点过那一次的快照"，成员画的画、传的图全在本机浏览器里，
 * 换设备就没了。
 *
 * 现在的目标是：**用户什么都不用点**，空闲时自动增量备份到管理员配置的 WebDAV。
 *
 * ## 触发时机（三个，全部是"用户已经停下来了"的时刻）
 *
 * | 触发 | 说明 |
 * |---|---|
 * | 定时巡检 | 每 `POLL_INTERVAL_MS` 检查一次，距离上次成功同步超过 `MIN_SYNC_GAP_MS` 才真正跑 |
 * | 页面重新可见 | `visibilitychange` —— 用户切回标签页，最自然的"该备份了"信号 |
 * | 生成任务全部结束 | 生成完 8 秒静默期后跑一次（经 `use-generation-activity-store` 判定） |
 *
 * ## 与生成中的冲突：不会撞
 *
 * `isGenerationSettled()` 同时要求「没有进行中的生成」且「距上次生成结束已过静默期」。
 * 静默期（8s）用来吸收"生成完成 → blob 落盘 → store 更新 → 清单写入"之间的异步间隙，
 * 避免把一份缺图或半张图的清单推上远端。
 *
 * ## 多人同步不会堵：串行队列
 *
 * 引擎内部用 `running` 标志做**互斥**，任何时刻只有一个同步在跑；
 * 期间到达的请求只置一个 `pending` 标记，跑完立刻补跑一次（合并成一次）。
 * 再叠加 WebDAV 配置里已有的 `syncMode`（默认串行上传），多人同时在线也不会把带宽打满
 * ——真正决定并发度的是每个成员的 `syncMode`，而不是在线人数。
 *
 * ## 失败怎么办：退避重试，不打扰用户
 *
 * 失败静默（不弹 toast、不打断操作），只把状态写进 `use-auto-sync-store`，
 * 并让退避时间指数增长（`RETRY_BACKOFF_MS`）：1 分钟 → 2 → 4 → 8 → 封顶 30 分钟。
 * 下一次巡检或用户切回页面时会自然重试；成功后重置退避。
 *
 * 这是刻意的取舍：备份是**后台保障**，不该因为它失败就反复弹窗。管理员在配置弹窗里
 * 能看到最后一次成功的状态和错误原因（见 `AutoSyncStatusLine`），排查有据可依。
 */

import { syncAppDataToWebdav, type AppSyncProgressEvent } from "@/services/app-sync";
import { useAccessStore } from "@/stores/use-access-store";
import { resolveWebdavSyncDirectory, useConfigStore, type WebdavSyncConfig } from "@/stores/use-config-store";
import { isGenerationSettled, IDLE_SETTLE_MS, useGenerationActivityStore } from "@/stores/use-generation-activity-store";

/** 定时巡检间隔。 */
const POLL_INTERVAL_MS = 60_000;
/** 两次成功同步之间的最小间隔，防止切标签页来回切把同步打得太密。 */
const MIN_SYNC_GAP_MS = 3 * 60_000;
/** 失败退避序列（毫秒），用完后一直用最后一个值。 */
const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** 互斥：任何时刻只允许一个同步在跑。 */
let running = false;
/** 跑的过程中又触发了：只记一个标记，跑完补跑一次。 */
let pending = false;
/** 连续失败次数，用于退避。 */
let failureCount = 0;
/** 上次失败的时间戳，用于判断退避是否已经过完。 */
let lastFailureAt = 0;

type Listener = (event: AutoSyncEvent) => void;
const listeners = new Set<Listener>();

export type AutoSyncEvent =
    | { type: "start" }
    | { type: "progress"; event: AppSyncProgressEvent }
    | { type: "success"; syncedAt: string; uploadedFiles: number; uploadedBytes: number }
    | { type: "failure"; message: string }
    | { type: "skipped"; reason: AutoSyncSkipReason };

export type AutoSyncSkipReason = "disabled" | "not-configured" | "generating" | "too-soon" | "backoff" | "unauthorized";

export function subscribeAutoSync(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function emit(event: AutoSyncEvent) {
    listeners.forEach((listener) => {
        try {
            listener(event);
        } catch {
            // 单个订阅者抛错不该影响引擎本身。
        }
    });
}

/** 静默同步开关 + 是否具备执行条件。管理员未下发或本地未配置时不启动。 */
function resolveActiveConfig(): WebdavSyncConfig | null {
    const user = useAccessStore.getState().user;
    if (!user) return null;
    const webdav = useConfigStore.getState().webdav;
    if (!webdav.url?.trim()) return null;
    if (webdav.autoSync === false) return null;
    return webdav;
}

function backoffRemaining(now: number): number {
    if (!failureCount) return 0;
    const wait = RETRY_BACKOFF_MS[Math.min(failureCount - 1, RETRY_BACKOFF_MS.length - 1)];
    return Math.max(0, lastFailureAt + wait - now);
}

/**
 * 跑一次静默同步。`force = true` 跳过"距上次成功太近"的检查（用户手动点同步时用）。
 */
export async function runAutoSync(options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const config = resolveActiveConfig();
    if (!config) {
        emit({ type: "skipped", reason: useConfigStore.getState().webdav.url?.trim() ? "disabled" : "not-configured" });
        return;
    }
    if (running) {
        pending = true;
        return;
    }
    if (!options.force) {
        if (!isGenerationSettled(now)) {
            emit({ type: "skipped", reason: "generating" });
            return;
        }
        const lastSyncedAt = useConfigStore.getState().webdav.lastSyncedAt;
        const lastMs = lastSyncedAt ? Date.parse(lastSyncedAt) || 0 : 0;
        if (lastMs && now - lastMs < MIN_SYNC_GAP_MS) {
            emit({ type: "skipped", reason: "too-soon" });
            return;
        }
        if (backoffRemaining(now) > 0) {
            emit({ type: "skipped", reason: "backoff" });
            return;
        }
    }

    running = true;
    emit({ type: "start" });
    try {
        const result = await syncAppDataToWebdav(config, (event) => emit({ type: "progress", event }));
        useConfigStore.getState().updateWebdavConfig("lastSyncedAt", result.syncedAt);
        failureCount = 0;
        lastFailureAt = 0;
        emit({ type: "success", syncedAt: result.syncedAt, uploadedFiles: result.uploadedFiles, uploadedBytes: result.uploadedBytes });
    } catch (error) {
        failureCount += 1;
        lastFailureAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "failure", message });
    } finally {
        running = false;
        if (pending) {
            pending = false;
            // 补跑：让出当前微任务队列，避免递归过深。
            void Promise.resolve().then(() => runAutoSync(options));
        }
    }
}

/**
 * 启动引擎。幂等：重复调用只会有一个定时器。
 * 应当在已登录之后调用（`AutoSyncEngine` 组件挂在门禁的登录分支里）。
 */
export function startAutoSyncEngine(): () => void {
    if (started) return stopAutoSyncEngine;
    started = true;

    // 首次延迟启动：等画布/资产 store 完成 hydration，否则第一次合并会拿不到本地数据。
    const initialTimer = setTimeout(() => void runAutoSync(), 15_000);

    timer = setInterval(() => void runAutoSync(), POLL_INTERVAL_MS);

    const onVisible = () => {
        if (document.visibilityState === "visible") void runAutoSync();
    };
    document.addEventListener("visibilitychange", onVisible);

    // 生成结束（计数器回到 0）时，静默期一过就补一次。轮询本身也能覆盖，
    // 但这里显式订阅能让"刚生成完就切走页面"的场景更快落盘。
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let previousActive = useGenerationActivityStore.getState().activeCount;
    const unsubscribeGeneration = useGenerationActivityStore.subscribe((state) => {
        if (state.activeCount === previousActive) return;
        const wasBusy = previousActive > 0;
        previousActive = state.activeCount;
        // 只在"全部结束"（>0 → 0）时排定补跑，避免每个任务结束都触发。
        if (!wasBusy || state.activeCount !== 0) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => void runAutoSync(), IDLE_SETTLE_MS + 1_000);
    });

    return () => {
        clearTimeout(initialTimer);
        if (settleTimer) clearTimeout(settleTimer);
        unsubscribeGeneration();
        document.removeEventListener("visibilitychange", onVisible);
        stopAutoSyncEngine();
    };
}

export function stopAutoSyncEngine(): void {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    pending = false;
    failureCount = 0;
    lastFailureAt = 0;
}

/** 登出时清理：计数器与退避都是"上一个登录者"的。 */
export function resetAutoSyncEngine(): void {
    stopAutoSyncEngine();
    listeners.clear();
}

/** 给界面读的只读快照：是否正在同步。 */
export function isAutoSyncRunning(): boolean {
    return running;
}

/** 成员专属目录的可读描述，用于界面提示"你的数据存在哪"。 */
export function describeSyncTarget(): string {
    const config = useConfigStore.getState().webdav;
    const directory = resolveWebdavSyncDirectory(config);
    return directory || "(根目录)";
}
