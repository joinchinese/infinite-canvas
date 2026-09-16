/**
 * HTTP 层小工具：JSON 响应、错误响应、Cookie 解析与下发。
 *
 * 本项目前后端同源（静态资源与 API 由同一个 Worker 提供），因此**不需要任何 CORS 配置**，
 * 会话直接用 httpOnly Cookie，前端不用碰 token。
 */

import type { Env } from "./types";

export const SESSION_COOKIE = "ic_session";

/** 统一的 JSON 响应；`Cache-Control: no-store` 避免登录态被中间层缓存。 */
export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(status: number, code: string, message?: string): Response {
    return jsonResponse({ error: code, ...(message ? { message } : {}) }, { status });
}

export function methodNotAllowed(allowed: string): Response {
    return new Response(JSON.stringify({ error: "method_not_allowed", allowed }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: allowed, "cache-control": "no-store" },
    });
}

/** 请求体默认上限。共享配置接口带了用户手写的模型脚本，单独放宽（见 `worker/config.ts`）。 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** 读取请求体里的 JSON；非法 JSON 或超长返回 null（调用方回 400）。 */
export async function readJsonBody<T>(request: Request, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<T | null> {
    try {
        const text = await request.text();
        if (!text || text.length > maxBytes) return null;
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" ? (parsed as T) : null;
    } catch {
        return null;
    }
}

export function parseCookies(request: Request): Record<string, string> {
    const header = request.headers.get("cookie");
    const cookies: Record<string, string> = {};
    if (!header) return cookies;
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name) cookies[name] = value;
    }
    return cookies;
}

/**
 * `Secure` 只在 https 下加：Worker 线上必然是 https，
 * 但 `wrangler dev` 跑在 http://127.0.0.1，硬写 Secure 会让本地测试拿不到 Cookie。
 */
export function isSecureRequest(url: URL): boolean {
    return url.protocol === "https:";
}

export function buildSessionCookie(token: string, url: URL, maxAgeSeconds: number): string {
    const attributes = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (isSecureRequest(url)) attributes.push("Secure");
    return attributes.join("; ");
}

export function buildClearSessionCookie(url: URL): string {
    const attributes = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
    if (isSecureRequest(url)) attributes.push("Secure");
    return attributes.join("; ");
}

/** 校验 `AUTH_SECRET` 是否配置；未配置时拒绝所有 API 请求。 */
export function readAuthSecret(env: Env): string | null {
    const secret = env.AUTH_SECRET?.trim();
    return secret && secret.length >= 16 ? secret : null;
}

export const MISSING_SECRET_RESPONSE = () =>
    errorResponse(
        500,
        "server_not_configured",
        "缺少 AUTH_SECRET。本地开发请写入 .dev.vars，线上执行 wrangler secret put AUTH_SECRET。",
    );
