/**
 * 静默同步引擎的挂载点与状态指示器。
 *
 * 挂在 `AccessGate` 的已登录分支（与 `SharedConfigSync` 同级），这样：
 * - 只有登录后才跑同步（未登录时本地数据属于"无主"，不该往管理员的 WebDAV 里写）；
 * - 登出时随组件卸载自动停引擎。
 */

import { useEffect, useState } from "react";
import { Modal, Tooltip } from "antd";
import dayjs from "dayjs";
import { CloudOff, CloudUpload, HardDrive, LoaderCircle, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { runAutoSync, startAutoSyncEngine, subscribeAutoSync } from "@/services/auto-sync-engine";
import { formatBytes } from "@/lib/image-utils";
import { useAutoSyncStore, type AutoSyncPhase } from "@/stores/use-auto-sync-store";
import { resolveWebdavSyncDirectory, useConfigStore } from "@/stores/use-config-store";

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
 * 一行同步状态。
 *
 * 挂在**顶栏**（所有登录用户可见）而不是配置弹窗里——因为普通成员打不开配置菜单，
 * 而"我的东西有没有在备份"恰恰是成员最需要知道的信息。
 *
 * 点一下展开详情面板：顶栏宽度有限，只放得下一句话，但成员真正会追问的是
 * "备份到哪了 / 上次什么时候成功的 / 上次传了多少 / 自动备份到底开没开"。
 * 失败态则直接把整行变成「重试」按钮——静默退避意味着用户可能等很久才自然恢复，
 * 提供一个随手可点的重试入口比让他干等更合理（但依然不弹窗打断）。
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
    const [retrying, setRetrying] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);

    if (!url?.trim()) {
        // 未配置时也允许点开：成员需要知道"为什么没有备份"，而不是只有一个灰字。
        return (
            <>
                <button
                    type="button"
                    onClick={() => setDetailsOpen(true)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-stone-400 transition-colors hover:bg-black/5 dark:text-stone-500 dark:hover:bg-white/10"
                >
                    <CloudOff className="size-3.5" />
                    <span>{t("access.autoSync.notConfigured")}</span>
                </button>
                <AutoSyncDetailModal open={detailsOpen} onClose={() => setDetailsOpen(false)} />
            </>
        );
    }

    const retry = async () => {
        setRetrying(true);
        try {
            await runAutoSync({ force: true });
        } finally {
            setRetrying(false);
        }
    };

    const time = lastSyncedAt ? dayjs(lastSyncedAt).format("HH:mm:ss") : "";
    const view = PHASE_VIEW[phase];
    const Icon = view.icon;
    const text = t(view.labelKey, { time });

    // 失败态：整行变成"重试"按钮，鼠标悬浮给出具体错误原因。
    if (phase === "failed") {
        return (
            <>
                <Tooltip title={t("access.autoSync.failedDetail", { message: lastError || "" })}>
                    <button
                        type="button"
                        disabled={retrying}
                        onClick={() => void retry()}
                        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-red-500/10 disabled:cursor-wait ${view.tone}`}
                    >
                        <Icon className={`size-3.5 ${retrying ? "animate-spin" : ""}`} />
                        <span>{retrying ? t("access.autoSync.syncing") : t("access.autoSync.retry")}</span>
                    </button>
                </Tooltip>
                <AutoSyncDetailModal open={detailsOpen} onClose={() => setDetailsOpen(false)} />
            </>
        );
    }

    return (
        <>
            <Tooltip
                title={
                    phase === "syncing"
                        ? t("access.autoSync.syncingDetail", { stage: stage || t("access.autoSync.syncing") })
                        : t("access.autoSync.detail", { directory: directory || "(根目录)" })
                }
            >
                <button
                    type="button"
                    onClick={() => setDetailsOpen(true)}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${view.tone}`}
                >
                    <Icon className={`size-3.5 ${phase === "syncing" ? "animate-spin" : ""}`} />
                    <span>{autoSync === false ? t("access.autoSync.disabled") : text}</span>
                </button>
            </Tooltip>
            <AutoSyncDetailModal open={detailsOpen} onClose={() => setDetailsOpen(false)} />
        </>
    );
}

/**
 * 备份详情面板。
 *
 * 成员侧的完整信息出口：只有一行状态文字时，"备份到哪了""上次什么时候成功的"
 * 这些真正会被追问的问题都没有答案，而成员又没有配置弹窗可以查。
 */
function AutoSyncDetailModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const phase = useAutoSyncStore((state) => state.phase);
    const lastSyncedAt = useAutoSyncStore((state) => state.lastSyncedAt);
    const lastError = useAutoSyncStore((state) => state.lastError);
    const lastUploadedFiles = useAutoSyncStore((state) => state.lastUploadedFiles);
    const lastUploadedBytes = useAutoSyncStore((state) => state.lastUploadedBytes);
    const stage = useAutoSyncStore((state) => state.stage);
    const webdav = useConfigStore((state) => state.webdav);
    const [retrying, setRetrying] = useState(false);

    const configured = Boolean(webdav.url?.trim());
    const directory = resolveWebdavSyncDirectory(webdav);
    const view = PHASE_VIEW[phase];
    const Icon = view.icon;
    const statusText = t(view.labelKey, { time: lastSyncedAt ? dayjs(lastSyncedAt).format("HH:mm:ss") : "" });

    const retry = async () => {
        setRetrying(true);
        try {
            await runAutoSync({ force: true });
        } finally {
            setRetrying(false);
        }
    };

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            width={420}
            title={
                <span className="flex items-center gap-2">
                    <CloudUpload className="size-4" />
                    {t("access.autoSync.detailPanel.title")}
                </span>
            }
        >
            <div className="space-y-3 pt-1 text-sm">
                <DetailRow label={t("access.autoSync.detailPanel.target")} icon={<HardDrive className="size-3.5" />}>
                    <code className="break-all rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-200">{configured ? directory || "/" : t("access.autoSync.notConfigured")}</code>
                </DetailRow>
                <DetailRow label={t("access.autoSync.detailPanel.status")}>
                    <span className={`inline-flex items-center gap-1.5 ${view.tone}`}>
                        <Icon className={`size-3.5 ${phase === "syncing" ? "animate-spin" : ""}`} />
                        <span>{phase === "syncing" ? t("access.autoSync.syncingDetail", { stage: stage || t("access.autoSync.syncing") }) : statusText}</span>
                    </span>
                </DetailRow>
                <DetailRow label={t("access.autoSync.detailPanel.lastSuccess")}>
                    <span className="text-stone-700 dark:text-stone-200">{lastSyncedAt ? dayjs(lastSyncedAt).format("YYYY-MM-DD HH:mm:ss") : t("access.autoSync.detailPanel.never")}</span>
                </DetailRow>
                <DetailRow label={t("access.autoSync.detailPanel.uploaded")}>
                    <span className="text-stone-700 dark:text-stone-200">
                        {lastSyncedAt ? `${lastUploadedFiles} · ${formatBytes(lastUploadedBytes)}` : t("access.autoSync.detailPanel.never")}
                    </span>
                </DetailRow>
                <DetailRow label={t("access.autoSync.detailPanel.autoBackup")}>
                    <span className="text-stone-700 dark:text-stone-200">{webdav.autoSync === false ? t("access.autoSync.detailPanel.off") : t("access.autoSync.detailPanel.on")}</span>
                </DetailRow>
                {phase === "failed" && lastError ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{t("access.autoSync.failedDetail", { message: lastError })}</div>
                ) : null}
                <p className="text-xs text-stone-500">{t("access.autoSync.detail", { directory: directory || t("access.autoSync.detailPanel.target") })}</p>
                {configured ? (
                    <div className="flex justify-end">
                        <button
                            type="button"
                            disabled={retrying || phase === "syncing"}
                            onClick={() => void retry()}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-wait disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
                        >
                            <RefreshCw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} />
                            <span>{retrying || phase === "syncing" ? t("access.autoSync.manualRunning") : t("access.autoSync.manualNow")}</span>
                        </button>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

function DetailRow({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-stone-500">
                {icon}
                {label}
            </span>
            <span className="min-w-0 text-right text-xs">{children}</span>
        </div>
    );
}

/** 供配置弹窗的「立即同步」按钮复用：强制跑一次，不等静默期。 */
export function triggerManualAutoSync(): Promise<void> {
    return runAutoSync({ force: true });
}
