/**
 * 代理转发 + 真实 Key 注入。
 *
 * ## 协议
 *
 * 上游前端把目标 URL **直接拼在代理地址后面**（`withLocalProxy()`）：
 *
 * ```
 *   ${proxyUrl}/${完整目标URL}   →   /https://api.openai.com/v1/images/generations
 * ```
 *
 * 所以这里只要从路径里解析出目标地址，再原样转发即可——**上游前端一行都不用改**。
 * `readTarget()` 的写法照搬 `canvas-proxy/index.js:35-47`：它是作者自己的参考实现，
 * 已经处理过两个真实踩到的坑（见该函数注释）。
 *
 * ## Key 注入怎么定位到具体渠道
 *
 * 唯一难点是"这个请求应该用哪个渠道的 Key"。目标 URL 里没有渠道 id，而两个渠道完全可能
 * 共用同一个 `baseUrl`（同一家供应商配两个 Key），所以**不能靠地址猜**。
 *
 * 解法：下发时把占位符写成 `via-proxy:<channelId>`（见 `config.ts` 的
 * `sharedApiKeyPlaceholder()`）。占位符是前端唯一会原样带出来的凭据，于是：
 *
 * ```
 *   前端带着 Authorization: Bearer via-proxy:ch-1  →  代理查到 ch-1 的真 Key  →  替换后转发
 * ```
 *
 * 渠道 id 本来就在下发给普通用户的 `channels[].id` 里，所以不算新增泄漏。
 * 裸占位符（`via-proxy`，没有 id，来自历史配置或顶层 apiKey）退化为**按目标 origin
 * 匹配渠道**，匹配不到就明确报错，而不是猜一个 Key 用。
 *
 * ## 占位符可能出现在三个地方
 *
 * 上游对三种格式的写法不同，三处都要替换：
 *
 * | 位置 | 触发场景 |
 * |---|---|
 * | `Authorization: Bearer <key>` | OpenAI 格式（`image.ts:351`、`audio.ts:18`） |
 * | `x-goog-api-key: <key>` | Gemini 格式（`image.ts:374`、`model-plugin.ts:396`） |
 * | `?key=<key>` 查询参数 | 部分 Gemini 路径把 Key 放进 URL（`model-plugin.ts:700`） |
 *
 * ## 安全边界（重要，不要当成"已经很安全"）
 *
 * - **不转发 Cookie**。站内会话 Cookie 是我们的凭据，绝不能出现在发给供应商的请求里。
 * - **不加 CORS 头**。请求本来就是同源的，不需要 `access-control-allow-origin: *`；
 *   参考实现加了通配 CORS，那是给跨域用法准备的，我们不需要，也就不加。
 * - **这是一个"登录用户可用的转发器"**。任何登录用户都能借它请求任意 http(s) 地址
 *   （`model-plugin.ts:43` 允许插件写绝对 URL，管理员自己配的 WebDAV 之类也依赖这个自由度），
 *   所以它本质上不是"只放行白名单域名"的收敛代理。当前规模（管理员 1 人 + 普通用户 2-5 人）
 *   可以接受，但这是**已知的、刻意保留的**开放面，收紧方案（origin 白名单）留给阶段 4。
 * - 真实 Key 只在 Worker 内部流转，既不写日志也不出现在响应里。
 */

import { requireUser } from "./auth";
import { channelIdFromPlaceholder, isSharedApiKeyPlaceholder, loadChannelOriginIndex, loadChannelSecrets } from "./config";
import { errorResponse } from "./http";
import type { Env } from "./types";

/**
 * 描述"这次请求是发往本代理、而不是要取本站资源"的判断入口。
 * 解析不出目标就返回空串，调用方据此把请求交回静态资源。
 */
export function readProxyTarget(url: URL): string {
    // 路径去掉开头的 "/"，并把查询串接回去（目标自己的 query 也要带走）。
    const raw = url.pathname.slice(1) + url.search;

    // 浏览器可能对路径做过转义；decodeURI 只还原路径级转义，保留有意的 encodeURIComponent。
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // 非法转义序列：按原样转发，不因为一个畸形字符就整条请求失败。
    }

    // 有些客户端会把嵌入 URL 里的 "//" 收敛成 "/"（实测 `https:/api.openai.com/...` 会出现），
    // 这里把它补回来，否则 new URL() 会解析出错误的 host。
    target = target.replace(/^(https?:)\/*/i, "$1//");

    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

/** 转发时丢弃的请求头：描述"到本代理这一跳"而非原始请求，或属于本站内部信息。 */
const SKIP_REQUEST_HEADERS = new Set([
    "host",
    "connection",
    "accept-encoding",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    // 站内会话凭据，绝不能转发给上游供应商。
    "cookie",
    // Workers 运行时注入的来源信息，转发出去没有意义。
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
]);

/** 转发时丢弃的响应头：fetch() 已经重新解码并重新分帧，原框架头不再成立。 */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** 可能承载 Key 的查询参数名（上游实际用到的是 `key`）。 */
const KEY_QUERY_PARAMS = ["key", "api_key"];

type KeySlot = { kind: "header"; name: string } | { kind: "query"; name: string };

export async function handleProxy(request: Request, env: Env, target: string): Promise<Response> {
    // 与 /api/* 一致的前置检查：门禁没配好时，代理也不能放行（否则就成了无鉴权转发器）。
    if (!env.AUTH_SECRET?.trim()) return errorResponse(500, "server_not_configured");
    if (!env.DB) return errorResponse(503, "database_unavailable");

    const auth = await requireUser(request, env, env.AUTH_SECRET);
    if (!auth.ok) return auth.response;

    let parsed: URL;
    try {
        parsed = new URL(target);
    } catch {
        return errorResponse(400, "invalid_target");
    }

    const headers = new Headers();
    request.headers.forEach((value, key) => {
        if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });

    const injected = await injectChannelKey(env, parsed, headers);
    if ("response" in injected) return injected.response;

    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    let upstream: Response;
    try {
        upstream = await fetch(injected.target, {
            method,
            headers,
            // 直接流式转发请求体：图片/视频上传不落内存。
            body: hasBody ? request.body : undefined,
            redirect: "follow",
        });
    } catch (error) {
        return errorResponse(502, "upstream_unreachable", error instanceof Error ? error.message : undefined);
    }

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
    });

    // 把上游 body 原样交出去，Worker 不会缓冲——SSE（文本流式输出）因此能一个 chunk 一个
    // chunk 地到浏览器，而不是等整段生成完才吐出来。
    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
    });
}

/**
 * 找出请求里的占位符并换成真实 Key。
 *
 * 没有占位符时**原样转发**，这是因为上游还有别的合法用法会经过这个代理
 * （用户自己填了真 Key 的渠道、模型插件里的第三方接口等）。此时不做任何注入。
 */
async function injectChannelKey(env: Env, target: URL, headers: Headers): Promise<{ target: URL } | { response: Response }> {
    const slots: Array<KeySlot & { value: string }> = [];

    // 1) Authorization: Bearer <...>
    const bearer = /^Bearer\s+(.+)$/i.exec((headers.get("authorization") || "").trim());
    if (bearer) slots.push({ kind: "header", name: "authorization", value: bearer[1].trim() });

    // 2) x-goog-api-key: <...>
    const googleKey = (headers.get("x-goog-api-key") || "").trim();
    if (googleKey) slots.push({ kind: "header", name: "x-goog-api-key", value: googleKey });

    // 3) ?key=<...> 等查询参数
    for (const name of KEY_QUERY_PARAMS) {
        const value = target.searchParams.get(name);
        if (value) slots.push({ kind: "query", name, value });
    }

    const placeholders = slots.filter((slot) => isSharedApiKeyPlaceholder(slot.value));
    if (!placeholders.length) return { target };

    const channelId = await resolveChannelId(env, target, placeholders.map((slot) => slot.value));
    if (!channelId) {
        return {
            response: errorResponse(
                502,
                "channel_unresolved",
                "请求里的占位符无法对应到任何渠道。请让管理员在「成员管理 → 共享配置」重新发布一次配置。",
            ),
        };
    }

    const secrets = await loadChannelSecrets(env);
    const secret = secrets.get(channelId);
    if (!secret) {
        return {
            response: errorResponse(
                502,
                "channel_secret_missing",
                `渠道「${channelId}」没有可用的密钥。请让管理员在「成员管理 → 共享配置」重新发布一次配置。`,
            ),
        };
    }

    for (const slot of placeholders) {
        if (slot.kind === "header") {
            headers.set(slot.name, slot.name === "authorization" ? `Bearer ${secret}` : secret);
        } else {
            target.searchParams.set(slot.name, secret);
        }
    }

    return { target };
}

/**
 * 确定这次请求属于哪个渠道。
 *
 * 优先用占位符里带的 id；只有裸占位符（历史配置、顶层 apiKey）才退回按目标 origin 匹配。
 * 匹配不到 id 时返回空串，由调用方报错——**绝不"随便挑一个 Key"**，
 * 那会让请求带着错误渠道的凭据打到供应商，表现为莫名其妙的 401。
 */
async function resolveChannelId(env: Env, target: URL, placeholderValues: string[]): Promise<string> {
    for (const value of placeholderValues) {
        const id = channelIdFromPlaceholder(value);
        if (id) return id;
    }

    const index = await loadChannelOriginIndex(env);
    return index.get(target.origin) ?? "";
}
