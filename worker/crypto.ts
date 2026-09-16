/**
 * 密码学小工具：base64url 编解码、HMAC-SHA256、常量时间字符串比较。
 *
 * 全部基于 Web Crypto（`crypto.subtle`），Workers 与浏览器都原生支持 —— 这一点很重要：
 * 登录流程的密码派生放在浏览器侧（见 password.ts 的说明），服务端只做一次 HMAC。
 */

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (normalized.length % 4)) % 4;
    const binary = atob(normalized + "=".repeat(padding));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** HMAC-SHA256，输出十六进制。用于密码校验值。 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const key = await hmacKey(secret);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return toHex(new Uint8Array(signature));
}

/** HMAC-SHA256，输出 base64url。用于会话令牌签名。 */
export async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
    const key = await hmacKey(secret);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return base64UrlEncode(new Uint8Array(signature));
}

/**
 * 常量时间字符串比较。
 *
 * 不依赖两个输入长度相同：先累计长度差，再按较长的一侧走满整个循环，
 * 这样比较耗时只与 max(lenA, lenB) 相关，不会因为"第几位开始不同"而泄漏信息。
 */
export function timingSafeEqual(left: string, right: string): boolean {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.max(leftBytes.length, rightBytes.length);
    let difference = leftBytes.length ^ rightBytes.length;
    for (let index = 0; index < length; index += 1) {
        difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }
    return difference === 0;
}

export function randomId(): string {
    return crypto.randomUUID();
}

/** 生成 32 字节随机密钥的 base64url 形式，供 `wrangler secret put` / `.dev.vars` 使用。 */
export function randomSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}
