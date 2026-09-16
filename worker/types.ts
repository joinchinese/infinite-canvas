/**
 * Worker 运行时与领域类型定义。
 *
 * 这里刻意不依赖 `@cloudflare/workers-types`：Wrangler 用 esbuild 打包，类型只在编译期被擦除，
 * 因此用最小结构化接口就够了，避免为一个类型包新增依赖（本仓库前端依赖锁在 bun.lock 里）。
 */

export type Role = "admin" | "member";
export type UserStatus = "active" | "disabled";

/** D1 绑定：只声明本项目用到的部分。 */
export interface D1Result<T> {
    results?: T[];
    success: boolean;
    meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(): Promise<T | null>;
    run(): Promise<D1Result<unknown>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
    exec(query: string): Promise<unknown>;
}

/** 静态资源绑定（env.ASSETS.fetch）。 */
export interface Fetcher {
    fetch(input: Request | string | URL): Promise<Response>;
}

export interface Env {
    /** D1：用户、共享配置、渠道密钥 */
    DB: D1Database;
    /** Vite 产物目录绑定 */
    ASSETS: Fetcher;
    /**
     * 会话签名与密码校验密钥。
     * 刻意**不提供默认值**：缺失时 API 一律 500 拒绝服务，避免线上跑在某种弱默认密钥上。
     * 本地开发放进 `.dev.vars`，线上用 `wrangler secret put AUTH_SECRET`。
     */
    AUTH_SECRET?: string;
}

/** users 表的一行（含不对外的字段，仅内部使用）。 */
export interface UserRow {
    id: string;
    username: string;
    display_name: string;
    password_hash: string;
    role: Role;
    status: UserStatus;
    auth_version: number;
    failed_attempts: number;
    locked_until: number | null;
    created_at: number;
    updated_at: number;
    last_login_at: number | null;
}

/** 可以安全回传给前端的用户视图。 */
export interface SessionUser {
    id: string;
    username: string;
    displayName: string;
    role: Role;
}
