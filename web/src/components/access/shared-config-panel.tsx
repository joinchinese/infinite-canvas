/**
 * 共享配置面板（仅管理员可见，挂在成员管理页的第二个 tab 上）。
 *
 * ## 为什么不开在配置弹窗里
 *
 * "把配置发布到服务端"这个动作，最自然的位置是上游的配置弹窗（`app-config-modal.tsx`），
 * 但那是个 475 行、上游高频修改的文件。把它做成独立组件、挂在自建的成员管理页上，
 * 就完全不需要动上游那个文件——这正是"新增文件为主"的取舍：**少一个缝合点，代价是多一次点击**。
 *
 * 阶段 4 如果觉得别扭，可以把它作为一行组件塞进配置弹窗，届时只是移动挂载点，组件本身不用改。
 */

import { useCallback, useEffect, useState } from "react";
import { App, Button, Tag, Tooltip } from "antd";
import { AlertTriangle, Info, RefreshCw, Upload } from "lucide-react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { AccessApiError } from "@/services/api/auth";
import { fetchSharedConfig, publishSharedConfig } from "@/services/api/shared-config";
import { useConfigStore } from "@/stores/use-config-store";
import { noteSharedConfigPublished, useAccessStore } from "@/stores/use-access-store";

export function SharedConfigPanel() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const lastPublishedAt = useAccessStore((state) => state.sharedConfigUpdatedAt);
    const [publishing, setPublishing] = useState(false);
    const [loading, setLoading] = useState(true);

    // 进面板时读一次服务端状态，这样"最后发布时间"在刷新页面后依然正确。
    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const shared = await fetchSharedConfig();
            noteSharedConfigPublished(shared.updatedAt, shared.missingSecrets);
        } catch {
            // 读不到就保持本地已知状态，不打断发布操作。
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadStatus();
    }, [loadStatus]);

    const publish = async () => {
        setPublishing(true);
        try {
            const result = await publishSharedConfig(config);
            noteSharedConfigPublished(result.updatedAt, result.missingSecrets);
            message.success(t("access.sharedConfig.published", { count: result.channels }));
        } catch (error) {
            const detail = error instanceof AccessApiError ? error.message : "";
            message.error(detail || t("access.sharedConfig.publishFailed"));
        } finally {
            setPublishing(false);
        }
    };

    const modelCount = config.channels.reduce((total, channel) => total + channel.models.length, 0);
    const keylessChannels = config.channels.filter((channel) => !channel.apiKey.trim()).map((channel) => channel.name || channel.id);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">{t("access.sharedConfig.title")}</div>
                    <p className="mt-1 max-w-2xl text-xs text-stone-500">{t("access.sharedConfig.description")}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadStatus()}>
                        {t("members.refresh", { defaultValue: "" }) === "" ? t("access.members.refresh") : t("access.members.refresh")}
                    </Button>
                    <Button type="primary" icon={<Upload className="size-4" />} loading={publishing} onClick={() => void publish()}>
                        {publishing ? t("access.sharedConfig.publishing") : t("access.sharedConfig.publish")}
                    </Button>
                </div>
            </div>

            <section className="rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                <div className="text-xs text-stone-500">
                    {lastPublishedAt
                        ? t("access.sharedConfig.lastPublished", { time: dayjs(lastPublishedAt).format("YYYY-MM-DD HH:mm:ss") })
                        : t("access.sharedConfig.neverPublished")}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Tag color={config.channels.length ? "blue" : "default"}>
                        {t("access.sharedConfig.previewChannels", { channels: config.channels.length, models: modelCount })}
                    </Tag>
                    <Tag>{t("access.sharedConfig.previewKey")}</Tag>
                    <Tooltip title={window.location.origin}>
                        <Tag color="green">{t("access.sharedConfig.previewProxy")}</Tag>
                    </Tooltip>
                </div>
                {config.channels.length ? null : <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">{t("access.sharedConfig.previewEmpty")}</p>}
            </section>

            {keylessChannels.length ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{t("access.sharedConfig.missingSecrets", { channels: keylessChannels.join("、") })}</span>
                </div>
            ) : null}

            <div className="flex items-start gap-2 rounded-lg border border-stone-200 px-4 py-3 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-400">
                <Info className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-1">
                    <p>{t("access.sharedConfig.secretNotice")}</p>
                    <p>{t("access.sharedConfig.channelIdNotice")}</p>
                </div>
            </div>
        </div>
    );
}
