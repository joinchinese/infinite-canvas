import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { useCanOpenConfig } from "@/stores/use-access-store";

export default function ConfigPage() {
    const { t } = useTranslation();
    const canOpenConfig = useCanOpenConfig();

    // 门禁叠加层：配置页属于"高级设置"，仅管理员可用。普通用户即使直接敲 URL
    // 也进不来——与 `/admin/members` 一致，弹回首页。
    // 这只是体验层，真正的门禁在服务端（`PUT /api/config` 走 requireAdmin）。
    if (!canOpenConfig) return <Navigate to="/" replace />;

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-5">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("config.title")}</h1>
                    <p className="mt-1 text-sm text-stone-500">{t("config.description")}</p>
                </div>
                <AppConfigPanel />
            </div>
        </main>
    );
}
