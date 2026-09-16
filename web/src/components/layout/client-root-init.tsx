import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useCanOpenConfig } from "@/stores/use-access-store";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { AccessGate } from "@/components/access/access-gate";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canOpenConfig = useCanOpenConfig();

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        // 门禁叠加层：这两个参数是"扫码/分享链接把渠道凭据带进本机配置"的用法。
        // 对普通用户没有意义——他的渠道与 Key 由管理员发布后覆盖，真 Key 也只在服务端；
        // 让他写进本地反而会短暂偏离共享配置。所以只把地址栏擦干净，不碰配置、也不弹配置框。
        if (!canOpenConfig) return;
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [canOpenConfig, importChannelCredentials, message, openConfigDialog, t]);

    // 门禁：未登录时 AccessGate 渲染登录页，已登录才渲染 children。
    // 放在这里（而不是 router 的路由守卫）是因为本组件已经是包裹全应用的壳，少动一个文件。
    return <AccessGate>{children}</AccessGate>;
}
