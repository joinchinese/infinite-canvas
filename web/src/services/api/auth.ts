/**
 * 登录/登出/会话 —— 浏览器侧的认证客户端。
 *
 * ## 密码派生必须与 Worker 侧逐字一致
 *
 * Worker 免费版 CPU 上限 10ms/请求，服务端做不了 PBKDF2（见 `worker/password.ts` 的说明），
 * 所以派生放在这里，服务端只比对一次 HMAC。两边任何一侧改了参数，**所有人都会登录失败**，
 * 因此下面这组常量与 `worker/password.ts` 的 `PASSWORD_KDF` 是强耦合的：
 *
 * | 参数 | 值 |
 * |---|---|
 * | 算法 | PBKDF2 |
 * | 摘要 | SHA-256 |
 * | 迭代 | 150000 |
 * | 输出 | 256 位 → base64url（恰好 43 字符） |
 * | 盐 | `"infinite-canvas:v1:" + 用户名去空格转小写` |
 *
 * `worker/smoke-test.mjs` 里有一条断言会把这两个文件当文本读出来做字面量比对，
 * 参数被单侧改动时会直接测试失败。
 *
 * ## crypto.subtle 需要安全上下文
 *
 * `http://localhost` / `http://127.0.0.1` 与所有 https 域名都算安全上下文，
 * 所以 `wrangler dev` 本地调试也能用；但如果把站点挂在局域网 http 上访问，
 * `crypto.subtle` 会是 undefined，登录直接不可用。
 */

export type AccessRole = "admin" | "member";

export type AccessUser = {
    id: string;
    username: string;
    displayName: string;
    role: AccessRole;
};

/** 密码派生参数。**改动前先读文件头注释。** */
export const PASSWORD_KDF = {
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations: 150000,
    lengthBits: 256,
    saltPrefix: "infinite-canvas:v1:",
} as const;

export type AccessErrorCode =
    | "invalid_credentials"
    | "account_disabled"
    | "locked"
    | "invalid_credentials_format"
    | "invalid_username"
    | "username_taken"
    | "already_initialized"
    | "unauthenticated"
    | "forbidden"
    | "member_not_found"
    | "last_admin"
    | "cannot_delete_self"
    | "server_not_configured"
    | "database_unavailable"
    | "network"
    | "unknown";

export class AccessApiError extends Error {
    readonly code: AccessErrorCode;
    /** 仅在 `locked` 时有值：还需等待多少秒。 */
    readonly retryAfter: number | null;
    readonly status: number;

    constructor(code: AccessErrorCode, message: string, status: number, retryAfter: number | null = null) {
        super(message);
        this.name = "AccessApiError";
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

const KNOWN_ERROR_CODES: readonly string[] = [
    "invalid_credentials",
    "account_disabled",
    "locked",
    "invalid_credentials_format",
    "invalid_username",
    "username_taken",
    "already_initialized",
    "unauthenticated",
    "forbidden",
    "member_not_found",
    "last_admin",
    "cannot_delete_self",
    "server_not_configured",
    "database_unavailable",
];

function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 把密码派生成交付给服务端的 `clientVerifier`。
 *
 * 150000 次 PBKDF2-SHA256 在普通桌面浏览器上约 100-300ms，一次登录只算一次，可以接受。
 * 这个值比服务端能承受的高得多——服务端跑同样的迭代会直接 1102 超时。
 */
export async function deriveClientVerifier(password: string, username: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), PASSWORD_KDF.algorithm, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        {
            name: PASSWORD_KDF.algorithm,
            salt: encoder.encode(`${PASSWORD_KDF.saltPrefix}${normalizeUsername(username)}`),
            iterations: PASSWORD_KDF.iterations,
            hash: PASSWORD_KDF.hash,
        },
        key,
        PASSWORD_KDF.lengthBits,
    );
    return toBase64Url(new Uint8Array(bits));
}

// ---------------------------------------------------------------------------
// 请求封装
// ---------------------------------------------------------------------------

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            // 同源 Cookie 会话，必须带凭据。
            credentials: "same-origin",
            cache: "no-store",
            ...init,
            headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
        });
    } catch {
        throw new AccessApiError("network", "网络请求失败", 0);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload as T;

    const record = (payload || {}) as { error?: unknown; message?: unknown; retryAfter?: unknown };
    const rawCode = typeof record.error === "string" ? record.error : "";
    const code = (KNOWN_ERROR_CODES.includes(rawCode) ? rawCode : "unknown") as AccessErrorCode;
    const retryAfter = typeof record.retryAfter === "number" ? record.retryAfter : null;
    const message = typeof record.message === "string" && record.message ? record.message : rawCode || `HTTP ${response.status}`;
    throw new AccessApiError(code, message, response.status, retryAfter);
}

export type MeResponse = {
    authenticated: boolean;
    user?: AccessUser;
    /** true 表示 `users` 表为空，需要先创建首位管理员。 */
    needsSetup?: boolean;
};

/** 启动时查询当前身份。未登录时返回 200 + `{ authenticated: false }`，不是错误。 */
export function fetchMe(): Promise<MeResponse> {
    return requestJson<MeResponse>("/api/auth/me");
}

export function loginRequest(username: string, password: string): Promise<{ user: AccessUser }> {
    return (async () => {
        const clientVerifier = await deriveClientVerifier(password, username);
        return requestJson<{ user: AccessUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username: username.trim(), clientVerifier }) });
    })();
}

export function setupRequest(username: string, password: string): Promise<{ user: AccessUser }> {
    return (async () => {
        const clientVerifier = await deriveClientVerifier(password, username);
        return requestJson<{ user: AccessUser }>("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: username.trim(), clientVerifier }) });
    })();
}

export function logoutRequest(): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}
