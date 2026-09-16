/**
 * 共享配置的同步状态。**只用于界面显示**，不参与任何业务判断。
 *
 * ## 为什么单独开一个 store
 *
 * `use-access-store` 管的是"我是谁"，这里管的是"配置有没有同步过去"。混在一起会让两边都变难读，
 * 而且这个状态会以很高的频率变化（管理员每敲一个字都可能进入 `pending`），
 * 放进门禁 store 会让所有订阅门禁的组件跟着重渲染。
 *
 * ## 两个方向共用一份状态
 *
 * 同一个浏览器里只会走其中一条（由身份决定，见 `components/access/shared-config-sync.tsx`）：
 *
 * - **管理员**：本地改配置 → 防抖后自动 `PUT /api/config`
 * - **普通成员**：定时 / 页面重新可见时 `GET /api/config`，发现新版本就覆盖本地
 *
 * 所以不需要按方向分成两套字段——同一时刻只会有一个写入方。
 */

import { create } from "zustand";

/**
 * `idle`    还没发生过任何同步（刚挂载）
 * `pending` 本地已改动，正在等防抖到期（管理员侧）
 * `syncing` 请求在飞
 * `synced`  最近一次成功
 * `skipped` 有改动但**刻意没有下发**，见 `skippedReason`
 * `error`   最近一次失败
 */
export type SharedConfigSyncPhase = "idle" | "pending" | "syncing" | "synced" | "skipped" | "error";

/**
 * 跳过下发的原因。
 *
 * `no-credentials`：本地所有渠道的 apiKey 都是空的。这几乎只会出现在"管理员换了一台干净设备 /
 * 清了浏览器数据"的时候——他本地是出厂默认配置，一个能用的渠道都没有。
 * 此时如果照常下发，`writeSharedConfig` 会把 set 到的渠道写空、并
 * `DELETE FROM channel_secrets` 清掉线上所有真实 Key，**把全员的配置一起打掉**。
 * 所以这种情况必须拦住：不发，并且在界面上说清楚。
 */
export type SharedConfigSkipReason = "no-credentials";

type SharedConfigSyncStore = {
    phase: SharedConfigSyncPhase;
    /** 最近一次成功同步的时间戳。管理员侧是推送成功，成员侧是拉取并应用成功。 */
    lastSyncedAt: number | null;
    /** 失败原因（仅 `phase === "error"` 时有值）。 */
    lastError: string | null;
    /** 跳过原因（仅 `phase === "skipped"` 时有值）。 */
    skippedReason: SharedConfigSkipReason | null;
};

export const useSharedConfigSyncStore = create<SharedConfigSyncStore>(() => ({
    phase: "idle",
    lastSyncedAt: null,
    lastError: null,
    skippedReason: null,
}));

export function markSyncPending(): void {
    useSharedConfigSyncStore.setState({ phase: "pending", lastError: null, skippedReason: null });
}

export function markSyncing(): void {
    useSharedConfigSyncStore.setState({ phase: "syncing", lastError: null, skippedReason: null });
}

export function markSynced(at: number = Date.now()): void {
    useSharedConfigSyncStore.setState({ phase: "synced", lastSyncedAt: at, lastError: null, skippedReason: null });
}

export function markSyncSkipped(reason: SharedConfigSkipReason): void {
    useSharedConfigSyncStore.setState({ phase: "skipped", skippedReason: reason, lastError: null });
}

export function markSyncError(message: string): void {
    useSharedConfigSyncStore.setState({ phase: "error", lastError: message, skippedReason: null });
}

/** 退出登录时清掉，避免下一个登录的人看到上一个人的同步状态。 */
export function resetSyncState(): void {
    useSharedConfigSyncStore.setState({ phase: "idle", lastSyncedAt: null, lastError: null, skippedReason: null });
}
