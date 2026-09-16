/**
 * 共享配置的自动同步。挂在 `AccessGate` 的已登录分支里，对整个应用生效。
 *
 * ## 为什么需要它（这是踩过的坑）
 *
 * 原来的设计是"管理员改完配置，再去成员管理页点一下发布"。实测证明这个设计会失效：
 * 管理员在配置弹窗里改了渠道和偏好，线上 `app_config` 表却一直是空的——
 * 他只改了**自己浏览器的 localStorage**，成员拉到的仍然是 `config: null`，于是用出厂默认值。
 * 两个界面离得太远，中间那一步没人会记得。
 *
 * 所以改成：
 *
 * | 角色 | 行为 |
 * |---|---|
 * | 管理员 | 本地配置一变 → 防抖 1.2s → 自动 `PUT /api/config` |
 * | 成员 | 每 60s + 页面重新可见时 `GET /api/config`，`updatedAt` 变了就覆盖本地 |
 *
 * 成员那一半是必须的：否则管理员改完，成员要手动刷新页面才看得到，
 * 现象上仍然是"我改了但他们还是旧的"。
 *
 * ## 三道护栏
 *
 * 1. **挂载不推送**。第一次渲染只记基线。管理员的本地配置可能来自一台干净设备，
 *    直接推上去会把线上覆盖成默认值。
 * 2. **没有凭据不推送**。所有渠道的 apiKey 都是空的时候不下发——`writeSharedConfig`
 *    遇到空渠道会 `DELETE FROM channel_secrets`，那是**把全员的真实 Key 一起清掉**。
 *    这种情况下界面会说明原因，而不是静默做一次破坏性写入。
 * 3. **写操作串行**。拖滑块会让 `config` 几十次变化，防抖压到一次；万一请求还在飞的时候
 *    又来了新的，就排队（只保留最后一次），避免并发 PUT 乱序把旧配置写在后面。
 *
 * 手动发布按钮（成员管理页的「共享配置」tab）仍然保留：它是唯一能绕过护栏的入口，
 * 用于"我确实要清空所有渠道"这种明确意图。
 */

import { useCallback, useEffect, useRef } from "react";
import { App, Tooltip } from "antd";
import dayjs from "dayjs";
import { CircleCheck, CloudUpload, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { applySharedConfig, fetchSharedConfig, publishSharedConfig } from "@/services/api/shared-config";
import { noteSharedConfigPublished, useAccessStore, useIsAdmin } from "@/stores/use-access-store";
import { useConfigStore } from "@/stores/use-config-store";
import { markSyncError, markSyncPending, markSyncSkipped, markSynced, markSyncing, useSharedConfigSyncStore, type SharedConfigSyncPhase } from "@/stores/use-shared-config-sync-store";

/** 管理员侧的防抖窗口。拖滑块、连续打字都会落进同一个窗口，只发一次。 */
const ADMIN_DEBOUNCE_MS = 1200;
/** 成员侧的轮询间隔。加上 `visibilitychange`，正常使用下感知延迟通常远小于这个值。 */
const MEMBER_POLL_MS = 60_000;

export function SharedConfigSync() {
    const isAdmin = useIsAdmin();
    return isAdmin ? <AdminAutoPublish /> : <MemberAutoRefresh />;
}

// ---------------------------------------------------------------------------
// 管理员：本地改动 → 自动下发
// ---------------------------------------------------------------------------

function AdminAutoPublish() {
    const config = useConfigStore((state) => state.config);
    /** 已经同步给服务端的那份配置（JSON 串）。`null` 表示还没记过基线。 */
    const baseline = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushing = useRef(false);
    const queued = useRef<string | null>(null);

    const flush = useCallback(async (snapshot: string) => {
        // 读最新值而不是闭包里的 config：防抖窗口里配置可能又变过。
        const latest = useConfigStore.getState().config;
        if (!latest.channels.some((channel) => channel.apiKey.trim())) {
            markSyncSkipped("no-credentials");
            baseline.current = snapshot;
            return;
        }
        if (flushing.current) {
            queued.current = snapshot;
            return;
        }

        flushing.current = true;
        markSyncing();
        try {
            const result = await publishSharedConfig(latest);
            noteSharedConfigPublished(result.updatedAt, result.missingSecrets);
            baseline.current = snapshot;
            markSynced();
        } catch (error) {
            // 刻意**不**更新 baseline：这份改动还没进服务端，状态就应该是"没同步"，
            // 下一次任何改动都会重新尝试。界面上会显示红色状态。
            markSyncError(error instanceof Error ? error.message : String(error));
        } finally {
            flushing.current = false;
            const pending = queued.current;
            queued.current = null;
            if (pending) void flush(pending);
        }
    }, []);

    useEffect(() => {
        const snapshot = JSON.stringify(config);

        // 护栏 1：挂载时的第一份配置只作基线，不推送。
        if (baseline.current === null) {
            baseline.current = snapshot;
            return;
        }
        if (snapshot === baseline.current) return;

        markSyncPending();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(snapshot), ADMIN_DEBOUNCE_MS);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [config, flush]);

    // 补推：服务端还什么都没有，但本机已经配好了。
    //
    // 这个分支专门救"升级前就配好了、但从来没发布过"的情形——最典型的就是这次改造本身：
    // 管理员在本机早就配好了渠道，只是当时还没有自动同步，服务端一直是空的。
    // 没有这一步的话，他只要不去动任何设置，本地这份配置就永远不会被下发出去
    // （基线机制决定了"挂载时的第一份配置不推送"），问题会原样复现。
    //
    // 只在挂载时读一次服务端状态，之后完全由本地改动驱动——刻意不做轮询，
    // 免得管理员的浏览器每隔一会儿就对服务端发一次 GET。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const shared = await fetchSharedConfig();
                if (cancelled || shared.config) return;
                const local = useConfigStore.getState().config;
                if (!local.channels.some((channel) => channel.apiKey.trim())) return;
                const snapshot = JSON.stringify(local);
                baseline.current = snapshot;
                await flush(snapshot);
            } catch {
                // 读不到就算了：不能因为一次 GET 失败就停摆，本地改动照样会触发下发。
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [flush]);

    return null;
}

// ---------------------------------------------------------------------------
// 成员：服务端有新版本 → 覆盖本地
// ---------------------------------------------------------------------------

function MemberAutoRefresh() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    /** 当前已生效的版本号。用 ref 而不是 store 值，避免"应用配置 → 更新 store → 再触发检查"的自激循环。 */
    const known = useRef<number | null>(useAccessStore.getState().sharedConfigUpdatedAt);
    const checking = useRef(false);

    const check = useCallback(async () => {
        if (checking.current) return;
        checking.current = true;
        try {
            const shared = await fetchSharedConfig();
            if (!shared.config || !shared.updatedAt || shared.updatedAt === known.current) return;
            applySharedConfig(shared.config);
            noteSharedConfigPublished(shared.updatedAt, shared.missingSecrets);
            known.current = shared.updatedAt;
            markSynced(shared.updatedAt);
            message.info(t("access.sync.memberUpdated"));
        } catch {
            // 轮询失败不值得打扰用户：没网络、会话过期都会走到这里，下一次会自己再试。
            // 真正需要用户知道的失败是"登录态没了"，那由 AccessGate 负责。
        } finally {
            checking.current = false;
        }
    }, [message, t]);

    useEffect(() => {
        const interval = setInterval(() => void check(), MEMBER_POLL_MS);
        const onVisibilityChange = () => {
            // 切走再切回来是最常见的"该更新了"的时刻，比等下一次轮询体验好得多。
            if (document.visibilityState === "visible") void check();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            clearInterval(interval);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [check]);

    return null;
}

// ---------------------------------------------------------------------------
// 界面反馈（只在配置弹窗里用，所以按管理员语义写文案）
// ---------------------------------------------------------------------------

/**
 * 一行同步状态，放在配置弹窗顶部那排按钮旁边。
 *
 * 存在的意义就是"让沉默的失败变成看得见的失败"——原来的手动发布按钮不点，
 * 界面不会有任何异常表现，管理员只会发现成员那边没生效。
 */
const PHASE_VIEW: Record<SharedConfigSyncPhase, { icon: LucideIcon; labelKey: string; tone: string }> = {
    idle: { icon: CloudUpload, labelKey: "access.sync.adminIdle", tone: "text-stone-500" },
    pending: { icon: LoaderCircle, labelKey: "access.sync.pending", tone: "text-stone-500" },
    syncing: { icon: LoaderCircle, labelKey: "access.sync.syncing", tone: "text-stone-500" },
    synced: { icon: CircleCheck, labelKey: "access.sync.adminSynced", tone: "text-emerald-600 dark:text-emerald-500" },
    skipped: { icon: TriangleAlert, labelKey: "access.sync.skipped", tone: "text-amber-600 dark:text-amber-500" },
    error: { icon: TriangleAlert, labelKey: "access.sync.failed", tone: "text-red-600 dark:text-red-500" },
};

export function SharedConfigSyncStatus() {
    const { t } = useTranslation();
    const phase = useSharedConfigSyncStore((state) => state.phase);
    const lastSyncedAt = useSharedConfigSyncStore((state) => state.lastSyncedAt);
    const lastError = useSharedConfigSyncStore((state) => state.lastError);

    const time = lastSyncedAt ? dayjs(lastSyncedAt).format("HH:mm:ss") : "";
    const view = PHASE_VIEW[phase];
    const Icon = view.icon;
    const text = t(view.labelKey, { time });

    return (
        <Tooltip
            title={
                lastError
                    ? t("access.sync.failedDetail", { message: lastError })
                    : phase === "skipped"
                      ? t("access.sync.skippedDetail")
                      : t("access.sync.autoHint")
            }
        >
            <span className={`inline-flex cursor-default items-center gap-1.5 text-xs ${view.tone}`}>
                <Icon className={`size-3.5 ${phase === "syncing" || phase === "pending" ? "animate-spin" : ""}`} />
                <span>{text}</span>
            </span>
        </Tooltip>
    );
}
