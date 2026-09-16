/**
 * 会话签发与校验，以及 /api/auth/* 四个接口。
 *
 * 设计要点：
 * 1. **无状态签名令牌 + 每次请求校验数据库**。令牌本身带 HMAC 签名（不查库也能验真伪），
 *    但仍然每次都读一次 users 表，为的是让"删除成员 / 停用成员 / 重置密码"能**立即生效**——
 *    否则一个被删掉的人最多还能用 7 天。D1 的等待时间不计入 CPU 时间，这个开销可以接受。
 * 2. **每请求一次 D1 读**。免费版 D1 每天 500 万次读，2-5 人场景完全用不到零头。
 */

import { hmacSha256Base64Url, randomId, timingSafeEqual } from "./crypto";
import {
    buildClearSessionCookie,
    buildSessionCookie,
    errorResponse,
    jsonResponse,
    parseCookies,
    readJsonBody,
    SESSION_COOKIE,
} from "./http";
import { hashClientVerifier, normalizeUsername } from "./password";
import type { Env, Role, SessionUser, UserRow } from "./types";

/** 会话有效期 7 天。要提前失效就靠 users.auth_version（重置密码/改角色时自增）。 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const SESSION_TOKEN_VERSION = "v1";
const SESSION_SIGNATURE_CONTEXT = "sess:v1:";

/** 连续失败多少次后锁定，以及锁定时长。 */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_DURATION_MS = 5 * 60 * 1000;

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
/** PBKDF2-SHA256 取 256 位 → base64url 恰好 43 字符。放宽到 16-128 以兼容将来调整。 */
const CLIENT_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type SessionPayload = {
    /** 用户 id */
    uid: string;
    /** users.auth_version，用于即时吊销 */
    v: number;
    /** 过期时间（epoch 秒） */
    exp: number;
};

export type AuthOutcome = { ok: true; user: SessionUser } | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// 令牌签发与校验
// ---------------------------------------------------------------------------

async function issueSessionToken(env: Env, secret: string, userId: string, authVersion: number): Promise<string> {
    const payload: SessionPayload = {
        uid: userId,
        v: authVersion,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    };
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const signature = await hmacSha256Base64Url(secret, `${SESSION_SIGNATURE_CONTEXT}${encoded}`);
    return `${SESSION_TOKEN_VERSION}.${encoded}.${signature}`;
}

/**
 * 读取最新的 auth_version 后签发令牌，供"改完自己密码但不想被踢下线"这类场景补发会话。
 * 用户不存在或已停用时返回 null。
 */
export async function issueSessionForUser(env: Env, secret: string, userId: string): Promise<string | null> {
    const row = await env.DB.prepare("SELECT auth_version, status FROM users WHERE id = ?1")
        .bind(userId)
        .first<Pick<UserRow, "auth_version" | "status">>();
    if (!row || row.status !== "active") return null;
    return issueSessionToken(env, secret, userId, row.auth_version);
}

function decodePayload(encoded: string): SessionPayload | null {
    try {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padding = (4 - (normalized.length % 4)) % 4;
        const parsed: unknown = JSON.parse(atob(normalized + "=".repeat(padding)));
        if (!parsed || typeof parsed !== "object") return null;
        const candidate = parsed as Partial<SessionPayload>;
        if (typeof candidate.uid !== "string" || typeof candidate.v !== "number" || typeof candidate.exp !== "number") return null;
        return { uid: candidate.uid, v: candidate.v, exp: candidate.exp };
    } catch {
        return null;
    }
}

/**
 * 校验请求携带的会话，返回当前用户；未登录/已失效返回 null。
 * 这是唯一的鉴权入口，所有需要登录的接口都走它。
 */
export async function loadSessionUser(request: Request, env: Env, secret: string): Promise<SessionUser | null> {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (!token) return null;

    const separatorIndex = token.indexOf(".");
    const lastSeparator = token.lastIndexOf(".");
    if (separatorIndex < 0 || lastSeparator === separatorIndex) return null;
    if (token.slice(0, separatorIndex) !== SESSION_TOKEN_VERSION) return null;

    const encoded = token.slice(separatorIndex + 1, lastSeparator);
    const signature = token.slice(lastSeparator + 1);
    const expectedSignature = await hmacSha256Base64Url(secret, `${SESSION_SIGNATURE_CONTEXT}${encoded}`);
    if (!timingSafeEqual(signature, expectedSignature)) return null;

    const payload = decodePayload(encoded);
    if (!payload) return null;
    if (payload.exp * 1000 <= Date.now()) return null;

    const row = await env.DB.prepare(
        "SELECT id, username, display_name, role, status, auth_version FROM users WHERE id = ?1",
    )
        .bind(payload.uid)
        .first<Pick<UserRow, "id" | "username" | "display_name" | "role" | "status" | "auth_version">>();

    if (!row) return null;
    if (row.status !== "active") return null;
    // 重置密码 / 改角色 / 停用 都会自增 auth_version，从而让旧令牌立刻作废。
    if (row.auth_version !== payload.v) return null;

    return { id: row.id, username: row.username, displayName: row.display_name || row.username, role: row.role };
}

/** 要求已登录。 */
export async function requireUser(request: Request, env: Env, secret: string): Promise<AuthOutcome> {
    const user = await loadSessionUser(request, env, secret);
    if (!user) return { ok: false, response: errorResponse(401, "unauthenticated") };
    return { ok: true, user };
}

/** 要求管理员。 */
export async function requireAdmin(request: Request, env: Env, secret: string): Promise<AuthOutcome> {
    const outcome = await requireUser(request, env, secret);
    if (!outcome.ok) return outcome;
    if (outcome.user.role !== "admin") return { ok: false, response: errorResponse(403, "forbidden") };
    return outcome;
}

// ---------------------------------------------------------------------------
// 接口：POST /api/auth/setup
// ---------------------------------------------------------------------------

type SetupInput = { username?: unknown; displayName?: unknown; clientVerifier?: unknown };

function readCredentials(input: SetupInput, requireDisplayName: boolean): { username: string; clientVerifier: string; displayName: string } | null {
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const clientVerifier = typeof input.clientVerifier === "string" ? input.clientVerifier.trim() : "";
    const displayName = requireDisplayName && typeof input.displayName === "string" ? input.displayName.trim().slice(0, 64) : "";
    if (!USERNAME_PATTERN.test(username)) return null;
    if (!CLIENT_VERIFIER_PATTERN.test(clientVerifier)) return null;
    return { username, clientVerifier, displayName };
}

/**
 * 首位管理员引导。
 * 只有在 users 表为空时才允许，因此这个接口不需要任何前置凭据也不会被滥用。
 * 并发下靠 `WHERE NOT EXISTS` 保证只可能成功一次。
 */
export async function handleSetup(request: Request, env: Env, url: URL, secret: string): Promise<Response> {
    const body = await readJsonBody<SetupInput>(request);
    if (!body) return errorResponse(400, "invalid_body");
    const credentials = readCredentials(body, false);
    if (!credentials) return errorResponse(400, "invalid_credentials_format");

    const passwordHash = await hashClientVerifier(secret, credentials.username, credentials.clientVerifier);
    const now = Date.now();
    const id = randomId();

    const result = await env.DB.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, status, auth_version, created_at, updated_at, last_login_at)
         SELECT ?1, ?2, ?3, ?4, 'admin', 'active', 1, ?5, ?5, ?5
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
        .bind(id, credentials.username, credentials.username, passwordHash, now)
        .run();

    if ((result.meta?.changes ?? 0) !== 1) {
        return errorResponse(409, "already_initialized", "站点已完成初始化，请直接登录。");
    }

    const token = await issueSessionToken(env, secret, id, 1);
    return jsonResponse(
        { user: { id, username: credentials.username, displayName: credentials.username, role: "admin" as Role } },
        { status: 201, headers: { "set-cookie": buildSessionCookie(token, url, SESSION_TTL_SECONDS) } },
    );
}

// ---------------------------------------------------------------------------
// 接口：POST /api/auth/login
// ---------------------------------------------------------------------------

type LoginInput = { username?: unknown; clientVerifier?: unknown };

export async function handleLogin(request: Request, env: Env, url: URL, secret: string): Promise<Response> {
    const body = await readJsonBody<LoginInput>(request);
    if (!body) return errorResponse(400, "invalid_body");

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const clientVerifier = typeof body.clientVerifier === "string" ? body.clientVerifier.trim() : "";
    if (!username || !CLIENT_VERIFIER_PATTERN.test(clientVerifier)) return errorResponse(400, "invalid_credentials_format");

    const row = await env.DB.prepare(
        `SELECT id, username, display_name, password_hash, role, status, auth_version, failed_attempts, locked_until
         FROM users WHERE username = ?1 COLLATE NOCASE`,
    )
        .bind(username)
        .first<Pick<UserRow, "id" | "username" | "display_name" | "password_hash" | "role" | "status" | "auth_version" | "failed_attempts" | "locked_until">>();

    const now = Date.now();

    if (row?.locked_until && row.locked_until > now) {
        const retryAfter = Math.ceil((row.locked_until - now) / 1000);
        return new Response(JSON.stringify({ error: "locked", retryAfter }), {
            status: 429,
            headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(retryAfter), "cache-control": "no-store" },
        });
    }

    // 用户不存在时也走一次 HMAC，让"存在/不存在"的响应耗时保持一致。
    const expectedHash = row
        ? row.password_hash
        : await hashClientVerifier(secret, username, "0000000000000000000000000000000000000000000");
    const actualHash = await hashClientVerifier(secret, username, clientVerifier);
    const passwordMatches = timingSafeEqual(actualHash, expectedHash);

    if (!row || !passwordMatches) {
        if (row) await registerFailedAttempt(env, row.id, row.failed_attempts ?? 0);
        return errorResponse(401, "invalid_credentials", "用户名或密码不正确。");
    }

    if (row.status !== "active") {
        return errorResponse(403, "account_disabled", "该账号已被停用，请联系管理员。");
    }

    await env.DB.prepare(
        "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?1, updated_at = ?1 WHERE id = ?2",
    )
        .bind(now, row.id)
        .run();

    const token = await issueSessionToken(env, secret, row.id, row.auth_version);
    return jsonResponse(
        {
            user: {
                id: row.id,
                username: row.username,
                displayName: row.display_name || row.username,
                role: row.role,
            },
        },
        { headers: { "set-cookie": buildSessionCookie(token, url, SESSION_TTL_SECONDS) } },
    );
}

async function registerFailedAttempt(env: Env, userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
        await env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = ?1 WHERE id = ?2")
            .bind(Date.now() + LOCK_DURATION_MS, userId)
            .run();
        return;
    }
    await env.DB.prepare("UPDATE users SET failed_attempts = ?1 WHERE id = ?2").bind(attempts, userId).run();
}

// ---------------------------------------------------------------------------
// 接口：POST /api/auth/logout 、GET /api/auth/me
// ---------------------------------------------------------------------------

export function handleLogout(url: URL): Response {
    return jsonResponse({ ok: true }, { headers: { "set-cookie": buildClearSessionCookie(url) } });
}

/**
 * 前端启动时调用：告诉它"我是谁"以及"站点是否还没初始化"。
 *
 * 未登录时返回 **200 + `{ authenticated: false }`** 而不是 401 ——
 * 这是启动路径上的常规查询，回 401 只会在控制台刷一堆无用报错。
 */
export async function handleMe(request: Request, env: Env, secret: string): Promise<Response> {
    const user = await loadSessionUser(request, env, secret);
    if (user) return jsonResponse({ authenticated: true, user, needsSetup: false });

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    return jsonResponse({ authenticated: false, needsSetup: (countRow?.total ?? 0) === 0 });
}
