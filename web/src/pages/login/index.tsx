/**
 * 登录页 / 首次初始化页。
 *
 * ## 为什么这个页面不能使用 react-router 的 hook
 *
 * 它由 `AccessGate` 渲染，而 `AccessGate` 位于 `AppProviders` 内部、`RouterProvider` **外部**
 * （见 `main.tsx` 的嵌套顺序）。所以这里没有 Router 上下文，`useNavigate` / `Link` 都会抛错。
 * 与路由相关的跳转一律靠"登录成功后 AccessGate 直接渲染 children"来完成，不需要导航。
 *
 * ## 密码强度只在浏览器校验
 *
 * 服务端拿到的是派生值，看不到明文，也就无法校验长度或复杂度——所以这里的校验不是"体验优化"，
 * 而是**唯一的密码策略执行点**。改这里等于改策略。
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { Languages, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AccessApiError } from "@/services/api/auth";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { accessErrorCode, accessErrorMessage } from "@/lib/access-error";
import { completeSetup, reloadAccess, signIn, useAccessStore } from "@/stores/use-access-store";

/** 与 Worker 侧 `USERNAME_PATTERN`（worker/auth.ts）保持一致。 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;

type LoginFields = {
    username: string;
    password: string;
    confirm?: string;
};

export default function LoginPage() {
    const { i18n, t } = useTranslation();
    const [form] = Form.useForm<LoginFields>();
    // 由启动流程判定：`users` 表为空时进入初始化模式（创建首位管理员）。
    const needsSetup = useAccessStore((state) => state.needsSetup);
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [lockedSeconds, setLockedSeconds] = useState(0);

    useEffect(() => {
        if (!lockedSeconds) return;
        const timer = window.setInterval(() => setLockedSeconds((value) => (value > 0 ? value - 1 : 0)), 1000);
        return () => window.clearInterval(timer);
    }, [lockedSeconds]);

    const submit = useCallback(
        async (values: LoginFields) => {
            setSubmitting(true);
            setErrorMessage("");
            try {
                if (needsSetup) await completeSetup(values.username, values.password);
                else await signIn(values.username, values.password);
            } catch (error) {
                if (accessErrorCode(error) === "locked") setLockedSeconds(error instanceof AccessApiError ? (error.retryAfter ?? 300) : 300);
                // 别处已经把首位管理员建好了：重新启动一次，让页面切回登录模式。
                if (accessErrorCode(error) === "already_initialized") void reloadAccess();
                setErrorMessage(accessErrorMessage(error, { fallbackLockedSeconds: lockedSeconds }));
            } finally {
                setSubmitting(false);
            }
        },
        [lockedSeconds, needsSetup],
    );

    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const setupMode = needsSetup;

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
            <button
                type="button"
                onClick={() => void changeAppLocale(nextLocale)}
                className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-stone-500 transition hover:bg-black/5 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100"
                aria-label={t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") })}
            >
                <Languages className="size-4" />
                {locale === "zh-CN" ? "EN" : "中"}
            </button>

            <div className="w-full max-w-sm">
                <div className="mb-7 flex flex-col items-center text-center">
                    <span
                        className="size-9 bg-stone-900 dark:bg-stone-100"
                        style={{
                            mask: "url(/logo.svg) center / contain no-repeat",
                            WebkitMask: "url(/logo.svg) center / contain no-repeat",
                        }}
                    />
                    <h1 className="mt-4 text-lg font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("meta.title")}</h1>
                    <p className="mt-1 text-sm text-stone-500">{t(setupMode ? "access.setup.description" : "access.login.description")}</p>
                    {setupMode ? (
                        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                            <ShieldCheck className="size-3.5" />
                            {t("access.setup.badge")}
                        </span>
                    ) : null}
                </div>

                {errorMessage ? <Alert type="error" showIcon message={t("access.errors.title")} description={errorMessage} className="mb-4" /> : null}

                <Form form={form} layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)} disabled={submitting}>
                    <Form.Item
                        name="username"
                        label={t("access.login.username")}
                        rules={[
                            { required: true, message: t("access.login.usernameRequired") },
                            ...(setupMode ? [{ pattern: USERNAME_PATTERN, message: t("access.setup.usernamePattern") }] : []),
                        ]}
                    >
                        <Input size="large" prefix={<UserOutlined className="text-stone-400" />} placeholder={t("access.login.usernamePlaceholder")} autoComplete="username" autoFocus />
                    </Form.Item>

                    <Form.Item
                        name="password"
                        label={t("access.login.password")}
                        rules={[
                            { required: true, message: t("access.login.passwordRequired") },
                            ...(setupMode ? [{ min: MIN_PASSWORD_LENGTH, message: t("access.setup.passwordMinLength") }] : []),
                        ]}
                    >
                        <Input.Password size="large" prefix={<LockOutlined className="text-stone-400" />} placeholder={t("access.login.passwordPlaceholder")} autoComplete={setupMode ? "new-password" : "current-password"} />
                    </Form.Item>

                    {setupMode ? (
                        <Form.Item
                            name="confirm"
                            label={t("access.setup.confirm")}
                            dependencies={["password"]}
                            rules={[
                                { required: true, message: t("access.setup.confirmRequired") },
                                ({ getFieldValue }) => ({
                                    validator: (_rule, value) =>
                                        !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("access.setup.passwordMismatch"))),
                                }),
                            ]}
                        >
                            <Input.Password size="large" prefix={<LockOutlined className="text-stone-400" />} placeholder={t("access.setup.confirmPlaceholder")} autoComplete="new-password" />
                        </Form.Item>
                    ) : null}

                    <Button type="primary" size="large" htmlType="submit" block loading={submitting} disabled={lockedSeconds > 0} className="mt-1">
                        {submitting ? t(setupMode ? "access.setup.submitting" : "access.login.submitting") : t(setupMode ? "access.setup.submit" : "access.login.submit")}
                    </Button>
                </Form>
            </div>
        </div>
    );
}
