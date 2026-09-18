/**
 * 共享配置：管理员发布的渠道与偏好，所有登录用户只读。
 *
 * 接口：
 *   GET /api/config   任意登录用户：读取（apiKey 已替换为占位符）
 *   PUT /api/config   仅管理员：发布当前配置
 *
 * ## 两条不变量
 *
 * 1. **真实 API Key 只进 `channel_secrets` 表**，任何接口都不返回。`GET` 出参里的
 *    `channels[].apiKey` 一律是占位符，普通用户 F12 也看不到真 Key。
 * 2. **占位符必须非空**。前端有 6 处"Key 不能为空"的校验
 *    （`audio.ts:31/91`、`video.ts:95/257`、`use-config-store.ts:203`、
 *    `model-select-modal.tsx:64`、`app-config-modal.tsx:77`），
 *    占位符正是为了让这些校验自然通过，请求才会真正发到代理上。
 *
 * ## 渠道 id 是密钥的关联键
 *
 * `channel_secrets` 以 `channels[].id` 为主键。所以管理员**不要随意删除再新建渠道**，
 * 否则同一条渠道会换 id、密钥需要重新发布一次。改名字/改 baseUrl 不受影响。
 *
 * ## 这里不覆盖代理设置
 *
 * 下发内容里保留管理员配置里的 `proxyEnabled` / `proxyUrl` 原值，**由前端在应用时强制
 * 改成"本站 origin + 开启代理"**（见 `web/src/services/api/shared-config.ts`）。
 * 放在前端做是因为只有前端才确切知道用户实际访问的是哪个域名（自定义域名 / workers.dev 预览域）。
 */

import { requireAdmin, requireUser } from "./auth";
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from "./http";
import type { D1PreparedStatement, Env } from "./types";

/** 下发与入库时统一使用的 apiKey 占位符**前缀**。非空是刻意的，见文件头注释。 */
export const SHARED_API_KEY_PLACEHOLDER = "via-proxy";

/**
 * 每个渠道的占位符都带上自己的 id：`via-proxy:<channelId>`。
 *
 * 代理层据此确定"该注入哪个渠道的真 Key"。不这么做的话，同一 `baseUrl` 下配了两个 Key
 * 的渠道就无法区分——目标 URL 里没有渠道信息，只能靠地址猜。渠道 id 本来就在下发给
 * 普通用户的 `channels[].id` 里，所以带出来不算新增泄漏。
 */
export function sharedApiKeyPlaceholder(channelId: string): string {
    const id = channelId.trim();
    return id ? `${SHARED_API_KEY_PLACEHOLDER}:${id}` : SHARED_API_KEY_PLACEHOLDER;
}

/** 判断一个 apiKey 值是不是占位符（带 id 或不带 id 都算）。入库时要跳过它，避免把占位符当真 Key 存起来。 */
export function isSharedApiKeyPlaceholder(value: string): boolean {
    const text = value.trim();
    return text === SHARED_API_KEY_PLACEHOLDER || text.startsWith(`${SHARED_API_KEY_PLACEHOLDER}:`);
}

/** 取出占位符里的渠道 id；裸占位符（没有 id）返回空串。 */
export function channelIdFromPlaceholder(value: string): string {
    const text = value.trim();
    if (!text.startsWith(`${SHARED_API_KEY_PLACEHOLDER}:`)) return "";
    return text.slice(SHARED_API_KEY_PLACEHOLDER.length + 1).trim();
}

const SHARED_CONFIG_KEY = "shared";
const SHARED_WEBDAV_CONFIG_KEY = "shared_webdav";
/** 配置里可能带用户手写的模型调用脚本，比 `readJsonBody` 默认的 64KB 上限放宽一些。 */
const MAX_CONFIG_BYTES = 256 * 1024;

type ChannelLike = { id: string; apiKey: string } & Record<string, unknown>;

/**
 * 从任意输入里取出渠道数组，并保证每项都有可用的 `id` 与字符串型 `apiKey`。
 * id 缺失时按位置补一个稳定值，避免出现"没有主键的密钥"。
 */
function channelsOf(raw: unknown): ChannelLike[] {
    const list = (raw as { channels?: unknown } | null)?.channels;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const rawId = typeof record.id === "string" ? record.id.trim() : "";
        const rawKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
        return [{ ...record, id: rawId || `channel-${index + 1}`, apiKey: rawKey }];
    });
}

/** 抹掉一切可能出现真实密钥的字段，换成占位符（供普通成员只读使用）。 */
function sanitize(raw: unknown): Record<string, unknown> {
    const channels = channelsOf(raw);
    return {
        ...(raw as Record<string, unknown>),
        // 顶层 apiKey 是历史字段（渠道化之前的结构），`resolveModelChannel` 在没有任何渠道时
        // 仍会回退到它，所以同样要抹掉。带上首个渠道的 id，让代理层仍能定位到具体渠道。
        apiKey: sharedApiKeyPlaceholder(channels[0]?.id ?? ""),
        channels: channels.map((channel) => ({ ...channel, apiKey: sharedApiKeyPlaceholder(channel.id) })),
    };
}

/** 管理员读取：从 channel_secrets 表取出各渠道的真实 API Key 回填，支持多设备无缝管理配置。 */
function revealSecrets(raw: unknown, secretMap: Map<string, string>): Record<string, unknown> {
    const channels = channelsOf(raw);
    const firstKey = channels[0] ? (secretMap.get(channels[0].id) ?? "") : "";
    return {
        ...(raw as Record<string, unknown>),
        apiKey: firstKey,
        channels: channels.map((channel) => {
            const realKey = secretMap.get(channel.id);
            return {
                ...channel,
                apiKey: realKey !== undefined ? realKey : (isSharedApiKeyPlaceholder(channel.apiKey) ? "" : channel.apiKey),
            };
        }),
    };
}

export async function handleConfig(request: Request, env: Env, secret: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "GET") {
        const auth = await requireUser(request, env, secret);
        if (!auth.ok) return auth.response;
        return readSharedConfig(env, auth.user);
    }
    if (method === "PUT") {
        const auth = await requireAdmin(request, env, secret);
        if (!auth.ok) return auth.response;
        return writeSharedConfig(request, env, auth.user.id);
    }
    return methodNotAllowed("GET, PUT");
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

async function readSharedConfig(env: Env, user: { id: string; username: string; role: string }): Promise<Response> {
    const isAdmin = user.role === "admin";
    const row = await env.DB.prepare("SELECT value_json, updated_at FROM app_config WHERE config_key = ?1")
        .bind(SHARED_CONFIG_KEY)
        .first<{ value_json: string; updated_at: number }>();

    const stored = row ? (parseJson(row.value_json) as Record<string, unknown> | null) : null;

    // 读取管理员统一发布的 WebDAV 备份配置
    const webdavRow = await env.DB.prepare("SELECT value_json, updated_at FROM app_config WHERE config_key = ?1")
        .bind(SHARED_WEBDAV_CONFIG_KEY)
        .first<{ value_json: string; updated_at: number }>();

    const rawWebdav = webdavRow ? (parseJson(webdavRow.value_json) as Record<string, unknown> | null) : null;
    let webdav: Record<string, unknown> | null = null;
    if (rawWebdav && rawWebdav.sharedEnabled !== false && rawWebdav.url) {
        if (isAdmin) {
            webdav = rawWebdav;
        } else {
            // 普通成员：专属目录物理隔离。
            //
            // 目录形状是 `<管理员根目录>/users/<用户名>`。这里**在服务端拼好**而不是只下发
            // `memberScope` 让前端自己拼，理由是安全性：成员无法通过改本地配置把自己写回
            // 共享根目录（前端那份 `directory` 是下载覆盖的，改了下一次拉取又会被纠正）。
            //
            // `isolateMembers === false` 是管理员显式选择"全员共用一个目录"，属于危险选项，
            // 只用于单人使用或确实想要一份合并快照的场景。
            const baseDir = typeof rawWebdav.directory === "string" ? rawWebdav.directory.trim().replace(/^\/+|\/+$/g, "") : "infinite-canvas";
            const isolate = rawWebdav.isolateMembers !== false;
            if (isolate) {
                const userSegment = normalizeMemberSegment(user.username || user.id || "member");
                webdav = {
                    ...rawWebdav,
                    directory: `${baseDir}/users/${userSegment}`,
                    memberScope: `users/${userSegment}`,
                    managed: true,
                };
            } else {
                webdav = { ...rawWebdav, directory: baseDir, memberScope: "", managed: true };
            }
        }
    }

    if (!stored) return jsonResponse({ config: null, webdav, updatedAt: null, missingSecrets: [] });

    const secretRows = await env.DB.prepare("SELECT channel_id, api_key FROM channel_secrets").all<{ channel_id: string; api_key: string }>();
    const secretMap = new Map((secretRows.results ?? []).map((item) => [item.channel_id, item.api_key]));

    const config = isAdmin ? revealSecrets(stored, secretMap) : sanitize(stored);
    const withSecret = new Set(secretMap.keys());
    const missingSecrets = channelsOf(config)
        .map((channel) => channel.id)
        .filter((id) => !withSecret.has(id));

    return jsonResponse({ config, webdav, updatedAt: row?.updated_at ?? null, missingSecrets });
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * 把用户名压成一个安全的单层目录名。
 *
 * 用户名本身已经被注册校验限制为 `[A-Za-z0-9._-]`，但这里仍然要清洗，因为：
 * - `user.username` 可能缺失（客户端传了 id）；
 * - 未来若有管理员批量导入的账号，不保证同一条 D1 约束。
 *
 * 逗号、点、连字符会被压成下划线是**有意**的：WebDAV 的 `MKCOL` 对某些服务端
 * 不会自动创建多级目录，而带点的段名在某些网盘上会被当成扩展名处理。
 */
function normalizeMemberSegment(value: string): string {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || "member";
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

async function writeSharedConfig(request: Request, env: Env, actorId: string): Promise<Response> {
    const body = await readJsonBody<{ config?: unknown; webdav?: unknown }>(request, MAX_CONFIG_BYTES);
    const raw = body?.config;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return errorResponse(400, "invalid_config");
    if (!Array.isArray((raw as { channels?: unknown }).channels)) return errorResponse(400, "invalid_config");

    const channels = channelsOf(raw);
    const now = Date.now();
    const statements = [];

    // 真实 Key 落 `channel_secrets`。占位符与空值一律跳过——否则第二次发布时会把
    // "via-proxy"（或 "via-proxy:ch-1"）当成真 Key 存进去，之后所有请求都会带着这个假 Key 发出去。
    for (const channel of channels) {
        if (!channel.apiKey || isSharedApiKeyPlaceholder(channel.apiKey)) continue;
        statements.push(
            env.DB.prepare(
                `INSERT INTO channel_secrets (channel_id, api_key, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(channel_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at`,
            ).bind(channel.id, channel.apiKey, now),
        );
    }

    // 清理已删除渠道残留的密钥，避免旧 Key 一直留在库里。
    if (channels.length) {
        const placeholders = channels.map((_, index) => `?${index + 1}`).join(", ");
        statements.push(
            env.DB.prepare(`DELETE FROM channel_secrets WHERE channel_id NOT IN (${placeholders})`).bind(...channels.map((channel) => channel.id)),
        );
    } else {
        statements.push(env.DB.prepare("DELETE FROM channel_secrets"));
    }

    statements.push(
        env.DB.prepare(
            `INSERT INTO app_config (config_key, value_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(config_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).bind(SHARED_CONFIG_KEY, JSON.stringify(sanitize(raw)), now, actorId),
    );

    // 管理员发布的 WebDAV 统一配置持久化
    if (body?.webdav !== undefined) {
        if (body.webdav && typeof body.webdav === "object" && !Array.isArray(body.webdav)) {
            statements.push(
                env.DB.prepare(
                    `INSERT INTO app_config (config_key, value_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(config_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                ).bind(SHARED_WEBDAV_CONFIG_KEY, JSON.stringify(body.webdav), now, actorId),
            );
        } else if (body.webdav === null) {
            statements.push(
                env.DB.prepare("DELETE FROM app_config WHERE config_key = ?1").bind(SHARED_WEBDAV_CONFIG_KEY),
            );
        }
    }

    // batch 在 D1 里是单事务执行：要么渠道密钥与配置一起生效，要么都不生效。
    await env.DB.batch(statements);

    const secretRows = await env.DB.prepare("SELECT channel_id FROM channel_secrets").all<{ channel_id: string }>();
    const withSecret = new Set((secretRows.results ?? []).map((item) => item.channel_id));
    return jsonResponse({
        ok: true,
        updatedAt: now,
        channels: channels.length,
        missingSecrets: channels.map((channel) => channel.id).filter((id) => !withSecret.has(id)),
    });
}

// ---------------------------------------------------------------------------
// 供代理层查询（只有 worker/proxy.ts 会用）
// ---------------------------------------------------------------------------

/**
 * 读取全部渠道的真实密钥。
 *
 * 只给代理层用：**任何 HTTP 接口都不得把它返回出去**。整表读而不是按 id 单查，
 * 是因为渠道数量只有个位数，一次查询就能覆盖一次请求里的所有注入点
 * （某些请求同时带 header 与 query 两处占位符）。
 */
export async function loadChannelSecrets(env: Env): Promise<Map<string, string>> {
    const rows = await env.DB.prepare("SELECT channel_id, api_key FROM channel_secrets").all<{ channel_id: string; api_key: string }>();
    return new Map((rows.results ?? []).map((row) => [row.channel_id, row.api_key]));
}

/**
 * `origin` → 渠道 id。
 *
 * 只在占位符是**裸** `via-proxy`（没有 id）时用于回退匹配——历史配置、以及顶层
 * `apiKey` 字段走的就是这条路。同一个 origin 配了多个渠道时保留先出现的那个，
 * 因为这种配置本身就无法从请求里区分，猜一个不如让它稳定可预期。
 */
export async function loadChannelOriginIndex(env: Env): Promise<Map<string, string>> {
    const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE config_key = ?1")
        .bind(SHARED_CONFIG_KEY)
        .first<{ value_json: string }>();

    const stored = row ? (parseJson(row.value_json) as Record<string, unknown> | null) : null;
    const index = new Map<string, string>();
    for (const channel of channelsOf(stored)) {
        const baseUrl = typeof channel.baseUrl === "string" ? channel.baseUrl.trim() : "";
        if (!baseUrl) continue;
        try {
            const origin = new URL(baseUrl).origin;
            if (!index.has(origin)) index.set(origin, channel.id);
        } catch {
            // baseUrl 不是合法地址：跳过，不影响其它渠道。
        }
    }
    return index;
}
