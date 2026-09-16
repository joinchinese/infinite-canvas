import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { accessResources } from "@/i18n/access";
import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";

i18n.use(initReactI18next).init({
    resources: {
        // 门禁文案放在独立文件里合并，让 locales/ 下两个高活跃语言包保持零改动（见 i18n/access.ts）。
        "zh-CN": { translation: { ...zhCN, access: accessResources["zh-CN"] } },
        "en-US": { translation: { ...enUS, access: accessResources["en-US"] } },
    },
    lng: (localStorage.getItem(LOCALE_STORAGE_KEY) as AppLocale) || "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    return i18n.changeLanguage(locale);
}

export default i18n;
