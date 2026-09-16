/**
 * 共享配置：管理员发布 → 服务端保存 → 普通用户启动时拉取并覆盖本地配置。
 *
 * ## 两个方向
 *
 * ```
 *   管理员浏览器 ── PUT /api/config（含真实 Key）──▶ Worker
 *                                                    ├─ 真实 Key → channel_secrets 表
 *                                                    └─ 其余配置 → app_config 表（Key 已换成占位符）
 *   普通用户浏览器 ◀── GET /api/config（Key 是占位符）──┘
 * ```
 *
 * ## baseUrl 保持真实地址，proxyUrl 才是本站
 *
 * 请求最终拼成 `${proxyUrl}/${baseUrl}/v1/...`（见 `use-config-store.ts` 的 `withLocalProxy`），
 * 代理要能从路径里解析出**真实目标地址**，所以：
 *
 * - `channels[].baseUrl` = 真实上游（如 `https://api.openai.com`）**不能改**
 * - `channels[].apiKey` = 占位符 `via-proxy:<channelId>`，真 Key 由 Worker 注入。
 *   占位符**非空**才通过前端那批"Key 不能为空"的校验，请求才会真的发出去；
 *   带上渠道 id 是为了让代理层知道该注入哪个渠道的 Key（同一 baseUrl 可能配多个 Key）。
 *   前端不需要自己拼这个值——服务端下发什么就用什么。
 * - `proxyEnabled` / `proxyUrl` = 由 `applySharedConfig` 强制改成"本站 origin"
 *
 * 早期文档里写的"baseUrl 填成代理地址"是错的，会让请求变成
 * `${proxyUrl}/${proxyUrl}/v1/...`，代理解析出错误目标——这里按正确语义实现。
 *
 * ## 强制开启代理而不是沿用管理员的值
 *
 * 管理员本机可能在用 `http://127.0.0.1:23210` 那个本地代理（`@basketikun/canvas-proxy`）。
 * 那个地址对普通用户毫无意义，所以应用时一律覆盖成本站 origin —— 也只有前端才确切知道
 * 用户实际访问的域名（自定义域名 / workers.dev 预览域 / 本地 dev 端口）。
 */

import { requestJson } from "@/services/api/auth";
import {
    createModelChannel,
    defaultConfig,
    modelOptionsFromChannels,
    normalizeModelOptionValue,
    useConfigStore,
    type AiConfig,
} from "@/stores/use-config-store";

export type SharedConfigResponse = {
    config: AiConfig | null;
    updatedAt: number | null;
    /** 服务端没有存到真实 Key 的渠道 id 列表。普通用户拉取时会带上（便于界面提示），通常只在管理端页有意义。 */
    missingSecrets: string[];
};

export type PublishSharedConfigResponse = {
    ok: boolean;
    updatedAt: number;
    channels: number;
    missingSecrets: string[];
};

/** 拉取共享配置。未登录会抛 `AccessApiError("unauthenticated")`。 */
export async function fetchSharedConfig(): Promise<SharedConfigResponse> {
    const payload = await requestJson<Partial<SharedConfigResponse>>("/api/config");
    return {
        config: (payload.config as AiConfig | null) ?? null,
        updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : null,
        missingSecrets: Array.isArray(payload.missingSecrets) ? payload.missingSecrets : [],
    };
}

/** 发布当前配置（仅管理员）。请求体里带真实 Key，响应里绝不回显。 */
export function publishSharedConfig(config: AiConfig): Promise<PublishSharedConfigResponse> {
    return requestJson<PublishSharedConfigResponse>("/api/config", { method: "PUT", body: JSON.stringify({ config }) });
}

/**
 * 把服务端下发的配置写进本地 store。
 *
 * 覆盖策略是**整体替换**：管理员配好的渠道与偏好就是普通用户的全部设置，
 * 普通用户本地原有的东西（除了 WebDAV 这类纯个人凭据）不保留。
 *
 * 用 `defaultConfig` 打底再铺开 `shared`，是为了在上游给 `AiConfig` 加字段时，
 * 旧的服务端数据也不会让本地出现 `undefined` 字段（对应方案里的"上游重构 AiConfig"风险）。
 */
export function applySharedConfig(shared: AiConfig, origin: string = window.location.origin): void {
    const channels = (Array.isArray(shared.channels) ? shared.channels : []).map((channel) => createModelChannel(channel));
    const merged: AiConfig = { ...defaultConfig, ...shared, channels };

    const config: AiConfig = {
        ...merged,
        channelMode: "local",
        channels,
        models: modelOptionsFromChannels(channels),
        model: normalizeModelOptionValue(merged.model, channels) || merged.model,
        imageModel: normalizeModelOptionValue(merged.imageModel || merged.model, channels),
        videoModel: normalizeModelOptionValue(merged.videoModel, channels),
        textModel: normalizeModelOptionValue(merged.textModel || merged.model, channels),
        audioModel: normalizeModelOptionValue(merged.audioModel || defaultConfig.audioModel, channels),
        // 普通用户的请求一律经本站代理，真实 Key 由 Worker 注入。
        proxyEnabled: true,
        proxyUrl: origin,
    };

    // 注意时序：zustand 的 persist 在 store 创建时（模块加载阶段）就已从 localStorage 恢复完毕，
    // 而这里是启动后的异步拉取，所以这次写入一定晚于恢复、不会被旧值盖回去。
    useConfigStore.setState({ config });
}
