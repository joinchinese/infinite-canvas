/**
 * 静默同步引擎的挂载点与状态指示器。
 *
 * 挂在 `AccessGate` 的已登录分支（与 `SharedConfigSync` 同级），这样：
 * - 只有登录后才跑同步（未登录时本地数据属于"无主"，不该往管理员的 WebDAV 里写）；
 * - 登出时随组件卸载自动停引擎。
 */

import { useEffect } from "react";
import { Tooltip } from "antd";
import dayjs from "dayjs";
import { CloudOff, CloudUpload, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { runAutoSync, startAutoSyncEngine, subscribeAutoSync } from "@/services/auto-sync-engine";
import { useAutoSyncStore, type AutoSyncPhase } from "@/stores/use-auto-sync-store";
import { useConfigStore } from "@/stores/use-config-store";

/** 引擎挂载。渲染 `null`，纯粹是生命周期宿主。 */
export function AutoSyncEngine() {
    const url = useConfigStore((state) => state.webdav.url);
    const autoSync = useConfigStore((state) => state.webdav.autoSync);

    useEffect(() => {
        // 未配置或关掉开关时不起定时器：省电、也避免无意义的失败状态。
        if (!url?.trim() || autoSync === false) return;
        const stop = startAutoSyncEngine();
        const unsubscribe = subscribeAutoSync((event) => {
            const store = useAutoSyncStore.getState();
            if (event.type === "start") store.setSyncing();
            else if (event.type === "progress") store.setStage(event.event.stage);
            else if (event.type === "success") store.setSynced(event.syncedAt, event.uploadedFiles, event.uploadedBytes);
            else if (event.type === "failure") store.setFailed(event.message);
        });
        return () => {
            unsubscribe();
            stop();
        };
    }, [url, autoSync]);

    return null;
}

const PHASE_VIEW: Record<AutoSyncPhase, { icon: LucideIcon; tone: string; labelKey: string }> = {
    idle: { icon: CloudUpload, tone: "text-stone-400 dark:text-stone-500", labelKey: "access.autoSync.idle" },
    syncing: { icon: LoaderCircle, tone: "text-sky-600 dark:text-sky-400", labelKey: "access.autoSync.syncing" },
    synced: { icon: CloudUpload, tone: "text-emerald-600 dark:text-emerald-500", labelKey: "access.autoSync.synced" },
    failed: { icon: TriangleAlert, tone: "text-red-600 dark:text-red-500", labelKey: "access.autoSync.failed" },
};

/**
 * 顶部一行同步状态。管理员和成员都能看到——成员最需要知道"我的东西有没有在存"。
 * 未配置 WebDAV 时显示一个灰色的"未启用"，而不是把自己藏起来。
 */
export function AutoSyncStatusLine() {
    const { t } = useTranslation();
    const phase = useAutoSyncStore((state) => state.phase);
    const lastSyncedAt = useAutoSyncStore((state) => state.lastSyncedAt);
    const lastError = useAutoSyncStore((state) => state.lastError);
    const stage = useAutoSyncStore((state) => state.stage);
    const url = useConfigStore((state) => state.webdav.url);
    const autoSync = useConfigStore((state) => state.webdav.autoSync);
    const directory = useConfigStore((state) => state.webdav.directory);

    if (!url?.trim()) {
        return (
            <Tooltip title={t("access.autoSync.notConfiguredHint")}>
                <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-stone-400 dark:text-stone-500">
                    <CloudOff className="size-3.5" />
                    <span>{t("access.autoSync.notConfigured")}</span>
                </span>
            </Tooltip>
        );
    }

    const time = lastSyncedAt ? dayjs(lastSyncedAt).format("HH:mm:ss") : "";
    const view = PHASE_VIEW[phase];
    const Icon = view.icon;
    const text = t(view.labelKey, { time });

    return (
        <Tooltip
            title={
                lastError
                    ? t("access.autoSync.failedDetail", { message: lastError })
                    : phase === "syncing"
                      ? t("access.autoSync.syncingDetail", { stage: stage || t("access.autoSync.syncing") })
                      : t("access.autoSync.detail", { directory: directory || "(根目录)" })
            }
        >
            <span className={`inline-flex cursor-default items-center gap-1.5 text-xs ${view.tone}`}>
                <Icon className={`size-3.5 ${phase === "syncing" ? "animate-spin" : ""}`} />
                <span>{autoSync === false ? t("access.autoSync.disabled") : text}</span>
            </span>
        </Tooltip>
    );
}

/** 供配置弹窗的「立即同步」按钮复用：强制跑一次，不等静默期。 */
export function triggerManualAutoSync(): Promise<void> {
    return runAutoSync({ force: true });
}
