/**
 * Worker 入口：静态资源 + API 同域。
 *
 * ## 路由分工
 *
 * ```
 *   /api/*                 → 本文件里的 API 路由
 *   /<完整目标 URL>         → 代理转发（阶段 3）
 *   其他                    → 兜底交给静态资源（Vite 产物）
 * ```
 *
 * ## 为什么不需要 run_worker_first
 *
 * `wrangler.jsonc` 里的 `compatibility_date` 是 2026-09-16，已启用
 * `assets_navigation_prefers_asset_serving`（该行为自 2025-04-01 起默认开启）。
 * 该行为已用探针头实测确认，结果如下：
 *
 * | 请求 | 是否调用 Worker | 结果 |
 * |---|---|---|
 * | 导航请求（地址栏访问/刷新，带 `Sec-Fetch-Mode: navigate`） | **否** | 命中资源则返回资源，未命中返回 index.html 200 |
 * | 非导航请求 + 命中静态资源（如 `/assets/x.js`） | 否 | 返回该资源 |
 * | 非导航请求 + 未命中资源（如页面内 `fetch("/api/...")`） | **是** | 交给本文件的路由 |
 *
 * 两个直接收益：深层路由刷新不 404，且导航不消耗 Worker 调用次数。
 *
 * 所以刻意**不配 `run_worker_first`**：默认行为正好是我们要的，配置面更小。
 * 注意：一旦改成数组形式的 `run_worker_first`，官方文档明确说会**关闭**上面的
 * navigate 自动检测，届时就得更小心地手写每条规则。
 */

import { handleLogin, handleLogout, handleMe, handleSetup } from "./auth";
import { errorResponse, jsonResponse, methodNotAllowed, MISSING_SECRET_RESPONSE, readAuthSecret } from "./http";
import { handleMembers } from "./members";
import type { Env } from "./types";

/** `/api/admin/members`、`/api/admin/members/:id`、`/api/admin/members/:id/password` */
const MEMBERS_PATH = /^\/api\/admin\/members(?:\/([^/]+))?(?:\/([^/]+))?\/?$/;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/")) {
            const secret = readAuthSecret(env);
            if (!secret) return MISSING_SECRET_RESPONSE();
            return handleApi(request, env, url, secret);
        }

        // 阶段 3 会在这里接入代理转发（/<完整目标 URL>）。
        // 在此之前，非 /api 的请求一律交给静态资源。
        if (!env.ASSETS) return errorResponse(503, "assets_unavailable", "未配置 assets 绑定。");
        // 注意：`env.ASSETS.fetch()` 会带上 not_found_handling 语义，
        // 于是任何未命中静态文件的非导航请求都会拿到 index.html + 200（而不是 404）。
        // 这正是 SPA 期望的行为（前端路由自己渲染 404 页）。已实测确认。
        return env.ASSETS.fetch(request);
    },
};

async function handleApi(request: Request, env: Env, url: URL, secret: string): Promise<Response> {
    const method = request.method.toUpperCase();
    // 容忍 `/api/auth/me/` 这类结尾多一个斜杠的写法。
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if (pathname === "/api/health") {
        return method === "GET" ? jsonResponse({ ok: true }) : methodNotAllowed("GET");
    }
    if (pathname === "/api/auth/setup") {
        return method === "POST" ? handleSetup(request, env, url, secret) : methodNotAllowed("POST");
    }
    if (pathname === "/api/auth/login") {
        return method === "POST" ? handleLogin(request, env, url, secret) : methodNotAllowed("POST");
    }
    if (pathname === "/api/auth/logout") {
        return method === "POST" ? handleLogout(url) : methodNotAllowed("POST");
    }
    if (pathname === "/api/auth/me") {
        return method === "GET" ? handleMe(request, env, secret) : methodNotAllowed("GET");
    }

    const membersMatch = MEMBERS_PATH.exec(pathname);
    if (membersMatch) {
        return handleMembers(request, env, url, secret, membersMatch[1], membersMatch[2]);
    }

    return errorResponse(404, "not_found");
}
