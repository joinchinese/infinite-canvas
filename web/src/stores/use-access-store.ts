/**
 * 登录态与角色。
 *
 * 这份 store **不持久化**：身份来自 httpOnly Cookie，每次启动都问一次 `/api/auth/me`。
 * 这样管理员删号、停用、改角色后，对方刷新页面即刻失效，不存在"本地还留着一个旧角色"。
 *
 * ## 五种状态
 *
 * | status | 含义 | 界面 |
 * |---|---|---|
 * | `loading` | 正在问服务端"我是谁" | 启动占位 |
 * | `unauthenticated` | 未登录（或会话已失效） | 登录页 / 首次初始化 |
 * | `authenticated` | 已登录 | 正常应用 |
 * | `degraded` | 服务端还没配置好（缺 `AUTH_SECRET` 或 D1 绑定） | **放行** + 顶部提示 |
 * | `error` | 网络失败或其它异常 | 错误页 + 重试 |
 *
 * ## `degraded` 为什么放行（刻意的取舍）
 *
 * 服务端返回 `server_not_configured`(500) / `database_unavailable`(503) 只可能出现在
 * "代码已部署、但 `wrangler d1 create` 与 `wrangler secret put AUTH_SECRET` 还没执行"这个窗口里。
 * 这个状态**攻击者无法制造**（他不能把 D1 解绑），因此放行不会削弱门禁：
 * 一旦后端配置齐备，这两个错误码再也不会出现，门禁自动进入关闭状态，不需要改代码或改开关。
 *
 * 反过来说：如果这里选择"宁死不放行"，那么部署到 D1 配好之间的这段时间站点是完全打不开的，
 * 而这段时间恰好是配置期——把管理员自己锁在门外，是更糟的结果。
 *
 * 其它失败（网络错误、非预期的 5xx）一律 `error`，不放行。
 */

import { create } from "zustand";

import { AccessApiError, fetchMe, loginRequest, logoutRequest, setupRequest, type AccessUser } from "@/services/api/auth";
import { applySharedConfig, fetchSharedConfig, type SharedConfigResponse } from "@/services/api/shared-config";
import { resetSyncState } from "@/stores/use-shared-config-sync-store";

export type AccessStatus = "loading" | "unauthenticated" | "authenticated" | "degraded" | "error";

type AccessStore = {
    status: AccessStatus;
    user: AccessUser | null;
    /** `users` 表为空，需要先创建首位管理员。 */
    needsSetup: boolean;
    /** 服务端共享配置的更新时间；null 表示管理员还没发布过。 */
    sharedConfigUpdatedAt: number | null;
    /** 服务端有配置、但没有真实 Key 的渠道 id（普通用户侧通常用不上，管理端页会提示）。 */
    sharedConfigMissingSecrets: string[];
    errorCode: string | null;
    errorMessage: string | null;
};

export const useAccessStore = create<AccessStore>(() => ({
    status: "loading",
    user: null,
    needsSetup: false,
    sharedConfigUpdatedAt: null,
    sharedConfigMissingSecrets: [],
    errorCode: null,
    errorMessage: null,
}));

/** 已登录且是管理员。非管理员一律 false（包括未登录）。 */
export function useIsAdmin(): boolean {
    return useAccessStore((state) => state.user?.role === "admin");
}

/**
 * 是否允许打开「配置与用户偏好」界面（渠道、本地代理、偏好设置、提示词来源、WebDAV、本地存储）。
 *
 * 这三个界面里含 API Key、上游地址、系统提示词这类"高级设置"，按需求只对管理员开放，
 * 普通用户完全看不到入口、也打不开——他的配置由管理员发布后统一下发（见 `shared-config.ts`），
 * 而且 `applySharedConfig` 是**整体替换**，普通用户就算改了偏好，下次刷新也会被服务端盖回去。
 *
 * 规则：
 * - 管理员 → 可以
 * - `degraded`（服务端还没配好）→ 可以。这里的取舍与 `AccessGate` 一致：那是"代码已部署、
 *   D1/AUTH_SECRET 还没配"的窗口期，把正在配置的管理员锁在门外是更糟的结果。
 *   该状态攻击者无法制造，所以放行不会削弱门禁，后端一配齐这个分支就再也不会走到。
 * - 其它（普通用户、未登录、启动中、错误）→ 不可以
 *
 * 注意这只是**界面层**的开关。真正的门禁在服务端：`PUT /api/config` 与 `/api/admin/*`
 * 都走 `requireAdmin`，普通用户即使绕过界面也改不动任何东西。
 */
export function useCanOpenConfig(): boolean {
    const status = useAccessStore((state) => state.status);
    const isAdmin = useIsAdmin();
    return status === "degraded" || isAdmin;
}

const DEGRADED_CODES = ["server_not_configured", "database_unavailable"];

function toErrorInfo(error: unknown): { code: string; message: string } {
    if (error instanceof AccessApiError) return { code: error.code, message: error.message };
    if (error instanceof Error) return { code: "unknown", message: error.message };
    return { code: "unknown", message: "" };
}

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------

let bootstrapTask: Promise<void> | null = null;

/**
 * 启动时调用一次。
 *
 * 同一个会话内多次调用只会真正跑一次（`AccessGate` 与可能的其它调用方共用同一个 Promise），
 * 需要重新跑就用 `reloadAccess()`。
 */
export function bootstrapAccess(): Promise<void> {
    if (!bootstrapTask) bootstrapTask = runBootstrap();
    return bootstrapTask;
}

/** 丢弃缓存的启动结果并重新拉一次（错误页的"重试"用）。 */
export function reloadAccess(): Promise<void> {
    bootstrapTask = null;
    return bootstrapAccess();
}

async function runBootstrap(): Promise<void> {
    useAccessStore.setState({ status: "loading", errorCode: null, errorMessage: null });
    try {
        const me = await fetchMe();
        if (!me.authenticated || !me.user) {
            useAccessStore.setState({ status: "unauthenticated", user: null, needsSetup: Boolean(me.needsSetup) });
            return;
        }
        await finishAuthentication(me.user);
    } catch (error) {
        failAccess(error);
    }
}

/**
 * 登录成功后的收尾：把云端共享配置同步落到本地，**再**把状态切成已登录。
 *
 * 顺序很重要——配置没落地就渲染应用的话，页面会先按默认配置闪一下（模型列表为空）。
 * 无论普通用户还是管理员换新设备登录，都需要从云端拉取共享配置，使两端配置保持一致。
 */
async function finishAuthentication(user: AccessUser): Promise<void> {
    let sharedConfigUpdatedAt: number | null = null;
    let sharedConfigMissingSecrets: string[] = [];

    const shared = await loadSharedConfigQuietly();
    if (shared?.config) {
        applySharedConfig(shared.config);
        sharedConfigUpdatedAt = shared.updatedAt;
        sharedConfigMissingSecrets = shared.missingSecrets;
    }

    useAccessStore.setState({
        status: "authenticated",
        user,
        needsSetup: false,
        sharedConfigUpdatedAt,
        sharedConfigMissingSecrets,
        errorCode: null,
        errorMessage: null,
    });
}

/** 共享配置拉取失败不应阻塞登录：拿不到就用本地现有配置，至少让人先进得去。 */
async function loadSharedConfigQuietly(): Promise<SharedConfigResponse | null> {
    try {
        return await fetchSharedConfig();
    } catch {
        return null;
    }
}

function failAccess(error: unknown): void {
    const { code, message } = toErrorInfo(error);
    useAccessStore.setState({
        status: DEGRADED_CODES.includes(code) ? "degraded" : "error",
        user: null,
        errorCode: code,
        errorMessage: message,
    });
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 登录。失败时抛 `AccessApiError`，由登录页翻译成提示文案。 */
export async function signIn(username: string, password: string): Promise<void> {
    const { user } = await loginRequest(username, password);
    await finishAuthentication(user);
}

/** 首次初始化：创建首位管理员并直接进入已登录状态。 */
export async function completeSetup(username: string, password: string): Promise<void> {
    const { user } = await setupRequest(username, password);
    await finishAuthentication(user);
}

/** 登出。即使请求失败也在本地切成未登录，避免"点了没反应"。 */
export async function signOut(): Promise<void> {
    try {
        await logoutRequest();
    } catch {
        // 服务端可能已经失效，本地照样清干净。
    }
    bootstrapTask = Promise.resolve();
    // 同步状态是"上一个登录者"的，别让它跨会话留着。
    resetSyncState();
    useAccessStore.setState({
        status: "unauthenticated",
        user: null,
        needsSetup: false,
        sharedConfigUpdatedAt: null,
        sharedConfigMissingSecrets: [],
        errorCode: null,
        errorMessage: null,
    });
}

/**
 * 管理端发布共享配置后调用，把"最后发布时间"同步给本地状态。
 * 普通用户侧的共享配置不在这里刷新——他的配置只在启动时拉一次，刷新页面即可拿到新的。
 */
export function noteSharedConfigPublished(updatedAt: number | null, missingSecrets: string[]): void {
    useAccessStore.setState({ sharedConfigUpdatedAt: updatedAt, sharedConfigMissingSecrets: missingSecrets });
}
