/**
 * 静默同步的界面状态。**只用于显示**，不参与业务判断（判断在 `services/auto-sync-engine.ts` 里）。
 *
 * 与 `use-shared-config-sync-store` 分开：那个管的是"配置有没有下发到成员"，
 * 这个管的是"我的画布和资产有没有备份到 WebDAV"。两件事的成败互不相关，
 * 混在一个 store 里会出现"配置同步成功了，但备份一直失败"时状态被互相覆盖。
 */

import { create } from "zustand";

export type AutoSyncPhase = "idle" | "syncing" | "synced" | "failed";

type AutoSyncStore = {
    phase: AutoSyncPhase;
    /** 最近一次成功的 ISO 时间串。 */
    lastSyncedAt: string | null;
    /** 最近一次成功的上传统计。 */
    lastUploadedFiles: number;
    lastUploadedBytes: number;
    /** 最近一次失败原因。 */
    lastError: string | null;
    /** 当前阶段的粗粒度描述（如"上传新增媒体"），用于悬浮提示。 */
    stage: string;
    setSyncing: () => void;
    setStage: (stage: string) => void;
    setSynced: (syncedAt: string, files: number, bytes: number) => void;
    setFailed: (message: string) => void;
    reset: () => void;
};

export const useAutoSyncStore = create<AutoSyncStore>((set) => ({
    phase: "idle",
    lastSyncedAt: null,
    lastUploadedFiles: 0,
    lastUploadedBytes: 0,
    lastError: null,
    stage: "",
    setSyncing: () => set({ phase: "syncing", lastError: null }),
    setStage: (stage) => set({ stage }),
    setSynced: (syncedAt, files, bytes) => set({ phase: "synced", lastSyncedAt: syncedAt, lastUploadedFiles: files, lastUploadedBytes: bytes, lastError: null, stage: "" }),
    setFailed: (message) => set({ phase: "failed", lastError: message, stage: "" }),
    reset: () => set({ phase: "idle", lastSyncedAt: null, lastUploadedFiles: 0, lastUploadedBytes: 0, lastError: null, stage: "" }),
}));
