/**
 * 密码校验。
 *
 * ## 为什么密码派生放在浏览器侧
 *
 * Cloudflare Workers **免费版 CPU 时间上限是 10ms/请求**，官方文档明确写了
 * "处理认证、服务端渲染或解析大负载的较重工作负载通常使用 10-20ms"，正好卡在上限上。
 * 在 Worker 里跑 PBKDF2（十几万次迭代）会直接把请求打成 1102 错误。
 *
 * 因此采用客户端预哈希（Bitwarden 等产品的标准做法）：
 *
 * ```
 *   浏览器：clientVerifier = PBKDF2-SHA256(密码, salt = "infinite-canvas:v1:" + 用户名小写, 150000 次, 256 位)
 *   Worker：password_hash  = HMAC-SHA256(AUTH_SECRET, "pw:v1:" + 用户名小写 + ":" + clientVerifier)
 * ```
 *
 * 服务端只做一次 HMAC（微秒级），CPU 开销可忽略。浏览器没有 CPU 配额，可放心用高迭代。
 *
 * ## 安全边界（README 里也写了一遍，别当成"已经很强"）
 *
 * - `clientVerifier` 等价于密码，**只能走 HTTPS 传输**（本站强制 https）。
 * - 迭代次数由浏览器决定，服务端无法核实。攻击者拿到 D1 导出后，还需要同时拿到
 *   `AUTH_SECRET` 才能离线爆破 —— 所以 `AUTH_SECRET` 必须足够强且不落库。
 * - 密码强度策略只在浏览器侧校验（服务端拿不到明文），前端必须真的执行校验。
 * - 数据库里存 `kdf_iterations` 仅作记录与将来平滑升级用，当前实现不读取它做校验。
 *
 * ## 前端必须与这里逐字保持一致
 *
 * 前端实现在 `web/src/services/api/auth.ts` 的 `deriveClientVerifier()`，
 * 下面的三个常量必须与它完全一致，任何一侧改动都会导致所有人无法登录。
 */

import { hmacSha256Hex } from "./crypto";

export const PASSWORD_KDF = {
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations: 150000,
    /** deriveBits 的位数（32 字节） */
    lengthBits: 256,
    saltPrefix: "infinite-canvas:v1:",
} as const;

/** 用户名归一化：去空格 + 转小写。前端算 salt 时必须用同一套规则。 */
export function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

/** 派生出盐字符串，与前端 `deriveClientVerifier()` 中的盐保持一致。 */
export function passwordSaltFor(username: string): string {
    return `${PASSWORD_KDF.saltPrefix}${normalizeUsername(username)}`;
}

/**
 * 把浏览器算出的 `clientVerifier` 转成入库/比对的 `password_hash`。
 * 时间成本是单次 HMAC-SHA256，远低于免费版的 10ms CPU 上限。
 */
export async function hashClientVerifier(secret: string, username: string, clientVerifier: string): Promise<string> {
    return hmacSha256Hex(secret, `pw:v1:${normalizeUsername(username)}:${clientVerifier}`);
}
