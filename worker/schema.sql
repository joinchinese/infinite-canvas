-- infinite-canvas 用户门禁 · D1 建表
--
-- 应用方式（本地）：npx wrangler d1 execute infinite-canvas --local  --file=./worker/schema.sql
-- 应用方式（线上）：npx wrangler d1 execute infinite-canvas --remote --file=./worker/schema.sql
--
-- 语句全部是 IF NOT EXISTS，可以重复执行。新增字段请另写 ALTER 语句，不要改这里的列定义后
-- 直接重跑——已建的表不会被重建。

-- ---------------------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              TEXT    PRIMARY KEY,
    username        TEXT    NOT NULL,
    display_name    TEXT    NOT NULL DEFAULT '',

    -- 格式：HMAC-SHA256(AUTH_SECRET, "pw:v1:" + 用户名小写 + ":" + clientVerifier)
    -- clientVerifier 由浏览器用 PBKDF2 派生（见 worker/password.ts）。数据库里既没有明文，
    -- 也没有可直接复用的登录值——还需要 AUTH_SECRET 才能比对。
    password_hash   TEXT    NOT NULL,

    -- 仅记录浏览器侧当时使用的迭代次数，便于将来平滑升级 KDF 参数；当前校验逻辑不读取它。
    kdf_iterations  INTEGER NOT NULL DEFAULT 150000,

    role            TEXT    NOT NULL DEFAULT 'member'  CHECK (role   IN ('admin', 'member')),
    status          TEXT    NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'disabled')),

    -- 自增即吊销该用户全部已签发会话（重置密码、改角色、停用账号时自增）。
    auth_version    INTEGER NOT NULL DEFAULT 1,

    -- 登录失败节流
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER,

    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    last_login_at   INTEGER
);

-- 用户名大小写不敏感唯一：Admin 与 admin 视为同一个账号。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- 管理员配好的共享配置（普通用户只读）
-- ---------------------------------------------------------------------------
-- 注意：这里**不存真实 API Key**，下发前会把 channels[].apiKey 替换成占位符。
-- 真实 Key 单独放 channel_secrets，只有 Worker 能读，任何接口都不返回。
CREATE TABLE IF NOT EXISTS app_config (
    config_key  TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

-- ---------------------------------------------------------------------------
-- 渠道真实密钥（仅 Worker 内部读取）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_secrets (
    channel_id  TEXT PRIMARY KEY,
    api_key     TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
