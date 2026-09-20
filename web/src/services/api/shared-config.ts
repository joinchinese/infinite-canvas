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
    defaultWebdavSyncConfig,
    modelOptionsFromChannels,
    normalizeModelOptionValue,
    useConfigStore,
    type AiConfig,
    type WebdavSyncConfig,
} from "@/stores/use-config-store";
import { useAccessStore } from "@/stores/use-access-store";

export type SharedConfigResponse = {
    config: AiConfig | null;
    webdav?: WebdavSyncConfig | null;
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
        webdav: (payload.webdav as WebdavSyncConfig | null) ?? null,
        updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : null,
        missingSecrets: Array.isArray(payload.missingSecrets) ? payload.missingSecrets : [],
    };
}

/** 发布当前配置（仅管理员）。请求体里带真实 Key，响应里绝不回显。 */
export function publishSharedConfig(config: AiConfig, webdav?: WebdavSyncConfig): Promise<PublishSharedConfigResponse> {
    return requestJson<PublishSharedConfigResponse>("/api/config", { method: "PUT", body: JSON.stringify({ config, webdav: webdav ? stripVolatileWebdavFields(webdav) : webdav }) });
}

/**
 * 剥离不该进共享配置的「本机易变字段」。
 *
 * `lastSyncedAt`（上次备份时间）是纯个人状态：如果跟着发布流出去，
 * 管理员每次静默备份都会触发一次全员配置发布（成员被无意义地弹通知），
 * 成员本地的备份时间还会被管理员的时间覆盖。快照比较与发布载荷都必须先剥掉它。
 */
export function stripVolatileWebdavFields(webdav: WebdavSyncConfig): Omit<WebdavSyncConfig, "lastSyncedAt"> {
    const { lastSyncedAt: _ignored, ...rest } = webdav;
    return rest;
}

/** 判断一个 apiKey 是否为占位符（via-proxy 或 via-proxy:channelId） */
export function isSharedApiKeyPlaceholder(value: string | undefined | null): boolean {
    if (!value) return false;
    const text = value.trim();
    return text === "via-proxy" || text.startsWith("via-proxy:");
}

/**
 * 把服务端下发的配置写进本地 store。
 *
 * 覆盖策略是**整体替换**：管理员配好的渠道与偏好就是普通用户的全部设置，
 * 普通用户本地原有的东西（除了 WebDAV 这类纯个人凭据）不保留。
 *
 * 智能保护：如果本地已经存在某个渠道的真实 API Key（非占位符），在合入时予以保留，
 * 避免管理员在配置机器上被云端脱敏后的占位符盖掉真实 Key；新机器登录则继承云端占位符走代理。
 *
 * 用 `defaultConfig` 打底再铺开 `shared`，是为了在上游给 `AiConfig` 加字段时，
 * 旧的服务端数据也不会让本地出现 `undefined` 字段（对应方案里的"上游重构 AiConfig"风险）。
 */
export function applySharedConfig(shared: AiConfig, sharedWebdav?: WebdavSyncConfig | null, origin: string = window.location.origin): void {
    const currentConfig = useConfigStore.getState().config;
    const localRealKeys = new Map<string, string>();
    for (const channel of currentConfig?.channels || []) {
        if (channel.apiKey && !isSharedApiKeyPlaceholder(channel.apiKey)) {
            localRealKeys.set(channel.id, channel.apiKey);
        }
    }

    const channels = (Array.isArray(shared.channels) ? shared.channels : []).map((channel) => {
        const created = createModelChannel(channel);
        // 若云端下发的是脱敏占位符或空值，但本地保留有真实 Key，则继承本地真实 Key；
        // 若云端本身下发了真实 Key（管理员身份读取），则直接采用云端权威最新值。
        if ((!created.apiKey || isSharedApiKeyPlaceholder(created.apiKey)) && localRealKeys.has(created.id)) {
            created.apiKey = localRealKeys.get(created.id)!;
        }
        return created;
    });
    const merged: AiConfig = { ...defaultConfig, ...shared, channels };

    const config: AiConfig = {
        ...merged,
        channelMode: "local",
        apiKey: channels[0]?.apiKey || merged.apiKey,
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

    // ---------------------------------------------------------------------
    // WebDAV 统一纳管
    // ---------------------------------------------------------------------
    //
    // | 角色 | 行为 |
    // |---|---|
    // | 普通成员 | **强制**采用管理员下发的地址/凭据/成员专属目录。本机那份只保留界面偏好
    // |          | （`syncMode` / `skipExistingFiles` / `autoSync`），因为上传快慢和是否静默
    // |          | 是各人网络环境相关的，不该由管理员一刀切。 |
    // | 管理员   | 本机**没配过**才从云端填补（换设备场景）；本机配过则以本机为准，
    // |          | 但 `memberScope` 例外——隔离段由服务端按用户名算，必须跟随。 |
    //
    // 成员侧的 `directory` / `memberScope` 必须整体覆盖：那是服务端按用户名算出来的隔离路径，
    // 如果保留本机的旧值，成员就可能在升级后继续往共享根目录写，从而覆盖别人的数据。
    const currentWebdav = useConfigStore.getState().webdav;
    if (sharedWebdav && sharedWebdav.url) {
        const isAdmin = useAccessStore.getState().user?.role === "admin";
        if (isAdmin) {
            if (!currentWebdav?.url?.trim()) {
                useConfigStore.setState({ webdav: { ...defaultWebdavSyncConfig, ...sharedWebdav } });
            } else {
                // 管理员本机已配置：连接信息保持本机优先（他可能正在编辑），
                // 但「隔离段」由服务端按用户名实时计算（决定他的数据落 users/<admin> 还是根目录），
                // 必须跟随服务端，否则开关「独立子目录」后管理员自己不会迁移。
                useConfigStore.setState({
                    webdav: {
                        ...currentWebdav,
                        memberScope: typeof sharedWebdav.memberScope === "string" ? sharedWebdav.memberScope : "",
                    },
                });
            }
        } else {
            // 本机网络/习惯相关的开关：服务端不下发这些字段，沿用本地。
            // 注意必须**后铺**在下发值之上——旧实现 localPrefs 在前、sharedWebdav 在后，
            // 云端若带了 lastSyncedAt 会把成员自己的备份时间覆盖成管理员的。
            const localPrefs = {
                syncMode: currentWebdav?.syncMode ?? defaultWebdavSyncConfig.syncMode,
                skipExistingFiles: currentWebdav?.skipExistingFiles ?? defaultWebdavSyncConfig.skipExistingFiles,
                autoSync: currentWebdav?.autoSync ?? defaultWebdavSyncConfig.autoSync,
                lastSyncedAt: currentWebdav?.lastSyncedAt ?? "",
            };
            // 连接信息与落盘路径（含专属隔离目录）一律以服务端为准，本机旧值不得残留。
            useConfigStore.setState({
                webdav: {
                    ...defaultWebdavSyncConfig,
                    ...sharedWebdav,
                    ...localPrefs,
                    managed: true,
                },
            });
        }
    } else if (useAccessStore.getState().user?.role !== "admin" && (currentWebdav?.url?.trim() || currentWebdav?.managed)) {
        // 管理员撤销了统一纳管（或还没配置）：清掉成员本机残留的托管配置，
        // 引擎读到空 url 自然停止，界面回落到「未启用云端备份」。
        // 旧实现这里直接跳过，导致撤销后成员仍在用旧配置静默备份。
        // 只在确有残留时重置，避免每轮轮询都白写一次 store。
        useConfigStore.setState({ webdav: { ...defaultWebdavSyncConfig } });
    }

    // 注意时序：zustand 的 persist 在 store 创建时（模块加载阶段）就已从 localStorage 恢复完毕，
    // 而这里是启动后的异步拉取，所以这次写入一定晚于恢复、不会被旧值盖回去。
    useConfigStore.setState({ config });
}
