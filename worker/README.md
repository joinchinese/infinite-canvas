# worker/ — 门禁与 API

`infinite-canvas` 的登录门禁、成员管理与 AI 请求代理。静态资源（Vite 产物）与 API 由**同一个 Worker** 提供，
因此前后端同源，会话直接用 httpOnly Cookie，**不需要任何 CORS 配置**。

## 文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口与路由分发；未匹配的请求交回静态资源 |
| `auth.ts` | 会话签发/校验，`/api/auth/*` 四个接口 |
| `members.ts` | 成员 CRUD（仅管理员） |
| `password.ts` | 密码派生规则常量与校验值计算 |
| `crypto.ts` | base64url、HMAC-SHA256、常量时间比较 |
| `http.ts` | JSON 响应、Cookie、错误响应 |
| `types.ts` | `Env` 与领域类型（不依赖 `@cloudflare/workers-types`） |
| `schema.sql` | D1 建表语句 |
| `smoke-test.mjs` | 端到端冒烟测试（67 条断言，覆盖鉴权、权限、防自锁、路由行为） |

`config.ts`（共享配置下发）与 `proxy.ts`（代理转发 + Key 注入）属于后续阶段，尚未创建。

## 本地开发

**第 0 步：启用 `wrangler.jsonc` 里的 `d1_databases`。**

仓库里这段默认是**注释掉的**，原因是它需要真实的 `database_id`——
留着占位符会让 `wrangler deploy` 失败（Cloudflare 会在部署解析绑定时报
`Couldn't find a D1 DB with the id ...`），进而连带影响线上构建。
所以提交版保持可部署，启用门禁时再取消注释。

```bash
# 1. 本地密钥（该文件已被 .gitignore 忽略）
printf 'AUTH_SECRET=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" > .dev.vars

# 2. 建表（本地 D1 落在 .wrangler/state，同样已忽略）
npx wrangler d1 execute infinite-canvas --local --file=./worker/schema.sql

# 3. 起服务
npx wrangler dev --port 8787
```

`web/dist` 若不存在，wrangler 会拒绝启动（`assets.directory` 校验）。
可以放一个占位 `web/dist/index.html`，或先跑一次真实构建。

### 配置未完成时的降级行为（已实测）

门禁没有配置完整时，**静态站点完全不受影响**，只有 `/api/*` 报错，且错误信息直接指出缺什么：

| 情况 | `/api/health` | 其他 `/api/*` | 静态站点 |
|---|---|---|---|
| `AUTH_SECRET` 未设置 | 200 | 500 `server_not_configured` | 正常 |
| `AUTH_SECRET` 已设置、D1 未绑定 | 200 | 503 `database_unavailable` | 正常 |
| 两者都就绪 | 200 | 正常 | 正常 |

`/api/health` 刻意放在密钥校验之前，这样在配置过程中也能用它确认 Worker 已经上线。

跑冒烟测试（需要空库；它会真的写入 D1）：

```bash
npx wrangler d1 execute infinite-canvas --local --command "DELETE FROM users;"
node worker/smoke-test.mjs http://127.0.0.1:8787
```

## 首次部署

```bash
# 1. 建 D1，把返回的 database_id 填进 wrangler.jsonc 并取消该段注释
npx wrangler d1 create infinite-canvas

# 2. 线上建表
npx wrangler d1 execute infinite-canvas --remote --file=./worker/schema.sql

# 3. 线上密钥（本地 .dev.vars 不会上传，必须单独设置）
npx wrangler secret put AUTH_SECRET
```

部署后打开站点，`/api/auth/me` 会返回 `needsSetup: true`，前端会引导创建首位管理员。
该引导接口只在 `users` 表为空时可用（靠 `WHERE NOT EXISTS` 保证只可能成功一次）。

## API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 存活探测 |
| POST | `/api/auth/setup` | 公开（仅空库） | 创建首位管理员并直接下发会话 |
| POST | `/api/auth/login` | 公开 | `{username, clientVerifier}` |
| POST | `/api/auth/logout` | 公开 | 清除 Cookie |
| GET | `/api/auth/me` | 公开 | 未登录返回 `200 {authenticated:false}`（不是 401，避免启动路径刷控制台报错） |
| GET | `/api/admin/members` | 管理员 | 成员列表 |
| POST | `/api/admin/members` | 管理员 | `{username, displayName?, role?, clientVerifier}` |
| PATCH | `/api/admin/members/:id` | 管理员 | `{displayName?, role?, status?}` |
| DELETE | `/api/admin/members/:id` | 管理员 | 删除成员 |
| POST | `/api/admin/members/:id/password` | 管理员 | `{clientVerifier}` 重置密码 |

## 密码方案：为什么派生在浏览器侧

Cloudflare Workers **免费版 CPU 上限是 10ms/请求**，官方文档明确说认证类工作负载通常要 10-20ms。
在 Worker 里跑 PBKDF2 会把请求打成 1102 错误。因此：

```
浏览器  clientVerifier = PBKDF2-SHA256(密码, salt="infinite-canvas:v1:"+用户名小写, 150000 次, 256 位)
Worker  password_hash  = HMAC-SHA256(AUTH_SECRET, "pw:v1:"+用户名小写+":"+clientVerifier)
```

服务端只做一次 HMAC（微秒级）。**前端实现必须与 `password.ts` 的 `PASSWORD_KDF` 逐字一致**
（`web/src/services/api/auth.ts` 的 `deriveClientVerifier()`），任何一侧改动都会导致所有人无法登录。

### 安全边界（不要当成"已经很强"）

- `clientVerifier` 等价于密码，只能走 HTTPS 传输。
- 迭代次数由浏览器决定，服务端无法核实。攻击者拿到 D1 导出后**还需要同时拿到 `AUTH_SECRET`** 才能离线爆破
  —— 所以 `AUTH_SECRET` 必须够强且不落库。
- 密码强度策略只在浏览器侧校验（服务端拿不到明文），前端必须真的执行。
- 登录接口有节流：连续失败 8 次锁定 5 分钟（记在 `users.failed_attempts` / `locked_until`）。

## 会话与即时吊销

会话是 HMAC 签名的无状态令牌，但**每次请求仍会读一次 `users` 表**，为的是让删除/停用/改角色/重置密码**立即生效**
（否则被删的人最多还能用 7 天）。D1 的等待时间不计入 CPU，这个开销可以接受。

自增 `users.auth_version` 即吊销该用户全部已签发会话。

## 已验证 / 未验证

**已实测**（`smoke-test.mjs`，67/67 通过）：

- 初始化引导、登录、登出、会话校验
- 成员增删改查、角色边界（普通用户一律 403）
- 防自锁：不能删除自己；至少保留一名启用状态的管理员
- 改角色 / 重置密码 / 停用 / 删除后，目标用户的旧会话立即失效
- 错误密码与不存在的用户返回同一错误码（不泄漏账号是否存在）
- SPA 路由行为：深层路由刷新返回 200；导航请求不经过 Worker

**未验证**：共享配置下发、代理转发与 Key 注入（阶段 2/3）、上游 SSE 流式透传、
`/https://...` 路径中 `//` 被规范化的问题（需照 `canvas-proxy/index.js` 的 `readTarget()` 处理）。
