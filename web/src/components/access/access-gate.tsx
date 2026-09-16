/**
 * 全局门禁：包裹整个应用，决定"渲染登录页"还是"渲染应用"。
 *
 * ## 接入方式（上游缝合点）
 *
 * 只有两行：`client-root-init.tsx` 里加一个 import，并把 `return <>{children}</>` 换成
 * `return <AccessGate>{children}</AccessGate>`。之所以放在 `ClientRootInit` 内部而不是
 * 改 `router.tsx` 加路由守卫，是因为它本来就是包裹全应用的壳，放这里可以少动一个文件。
 *
 * 但要注意一个前提：`ClientRootInit` 位于 `RouterProvider` **外部**，所以本组件及其子组件
 * （尤其是登录页）都不能使用 react-router 的 hook。真正由路由渲染的页面（如成员管理页）
 * 在 `RouterProvider` 内部，不受此限制。
 *
 * ## `degraded` 是"放行"而不是"拦截"
 *
 * 原因见 `use-access-store.ts` 文件头：这个状态只可能出现在"代码已部署、D1/AUTH_SECRET 还没配"
 * 的窗口期，且攻击者无法制造。选择放行是为了不把管理员锁在自家门外；后端一旦配好，
 * 这个状态就再也不会出现，门禁自动生效。
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, Button, Spin } from "antd";
import { OctagonAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import LoginPage from "@/pages/login";
import { SharedConfigSync } from "@/components/access/shared-config-sync";
import { bootstrapAccess, reloadAccess, useAccessStore } from "@/stores/use-access-store";

export function AccessGate({ children }: { children: ReactNode }) {
    const status = useAccessStore((state) => state.status);
    const errorCode = useAccessStore((state) => state.errorCode);
    const errorMessage = useAccessStore((state) => state.errorMessage);

    useEffect(() => {
        // 同一个会话内只会真正执行一次（store 内部缓存了 Promise）。
        void bootstrapAccess();
    }, []);

    if (status === "loading") return <GateLoading />;
    if (status === "unauthenticated") return <LoginPage />;
    if (status === "degraded") return <DegradedNotice code={errorCode} hintKey={`access.gate.hint${errorCode === "database_unavailable" ? "DatabaseUnavailable" : "ServerNotConfigured"}`}>{children}</DegradedNotice>;
    if (status === "error") return <GateError code={errorCode} message={errorMessage} />;
    // `SharedConfigSync` 只在已登录时挂载：管理员侧负责把本地改动自动下发给成员，
    // 成员侧负责在管理员更新后自动取回。它渲染成 null，不占布局。
    return (
        <>
            <SharedConfigSync />
            {children}
        </>
    );
}

function GateLoading() {
    const { t } = useTranslation();
    return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
            <Spin size="large" />
            <p className="text-sm text-stone-500">{t("access.loading")}</p>
        </div>
    );
}

/**
 * 服务端还没配置好：正常渲染应用，只在底部挂一条可关闭的提示。
 *
 * 刻意用 `fixed` 而不是插进布局流里——应用根节点是 `h-dvh`，任何插入都会挤掉画布高度。
 */
function DegradedNotice({ code, hintKey, children }: { code: string | null; hintKey: string; children: ReactNode }) {
    const { t } = useTranslation();
    const [dismissed, setDismissed] = useState(false);

    return (
        <>
            {children}
            {dismissed ? null : (
                <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
                    <Alert
                        type="warning"
                        showIcon
                        closable
                        onClose={() => setDismissed(true)}
                        className="pointer-events-auto max-w-xl shadow-lg"
                        message={t("access.gate.degradedTitle")}
                        description={
                            <div className="space-y-1">
                                <p>{t("access.gate.degradedBody", { code: code || "?" })}</p>
                                <p className="text-xs text-stone-500">{t("access.gate.degradedHint")}</p>
                                <p className="text-xs text-stone-500">{t(hintKey)}</p>
                            </div>
                        }
                    />
                </div>
            )}
        </>
    );
}

function GateError({ code, message }: { code: string | null; message: string | null }) {
    const { t } = useTranslation();
    const [retrying, setRetrying] = useState(false);

    const retry = async () => {
        setRetrying(true);
        try {
            await reloadAccess();
        } finally {
            setRetrying(false);
        }
    };

    return (
        <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
            <div className="w-full max-w-md rounded-xl border border-stone-200 p-6 dark:border-stone-800">
                <div className="flex items-center gap-2 text-stone-950 dark:text-stone-100">
                    <OctagonAlert className="size-5" />
                    <h1 className="text-base font-semibold">{t("access.gate.errorTitle")}</h1>
                </div>
                <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">{message || t("access.gate.errorBody")}</p>
                <p className="mt-1 font-mono text-xs text-stone-400">{t("access.gate.errorCode", { code: code || "unknown" })}</p>
                <Button type="primary" className="mt-5" loading={retrying} onClick={() => void retry()}>
                    {t("access.gate.retry")}
                </Button>
            </div>
        </div>
    );
}
