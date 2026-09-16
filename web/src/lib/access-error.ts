/**
 * 把门禁接口的错误翻成当前语言下的文案。
 *
 * 放在 `lib/` 而不是某个页面里，是因为登录页和成员管理页都要用；两份实现一旦漂移，
 * 同一个错误码在两个页面会显示不同文案。
 *
 * 兜底策略：语言包里有对应键就用语言包，没有就回退服务端返回的 `message`，
 * 再没有就回退到通用文案——服务端将来新增错误码时不会显示成 `access.errors.xxx` 这种键名。
 */

import i18n from "@/i18n";
import { AccessApiError } from "@/services/api/auth";

export function accessErrorCode(error: unknown): string {
    return error instanceof AccessApiError ? error.code : "unknown";
}

export function accessErrorMessage(error: unknown, options: { fallbackLockedSeconds?: number } = {}): string {
    if (error instanceof AccessApiError) {
        if (error.code === "locked") {
            return i18n.t("access.errors.locked", { seconds: error.retryAfter ?? options.fallbackLockedSeconds ?? 300 });
        }
        const key = `access.errors.${error.code}`;
        const translated = i18n.t(key, { message: error.message });
        if (translated !== key) return translated;
        return error.message || i18n.t("access.errors.unknown", { message: error.message });
    }
    return error instanceof Error ? error.message : i18n.t("access.errors.unknown", { message: "" });
}
