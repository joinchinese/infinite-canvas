# worker/ — 门禁与 API

`infinite-canvas` 的登录门禁、成员管理与 AI 请求代理。静态资源（Vite 产物）与 API 由**同一个 Worker** 提供，
因此前后端同源，会话直接用 httpOnly Cookie，**不需要任何 CORS 配置**。

> **线上地址：<https://canvas.joinhu01.fun>**（自定义域名，2026-09-16 绑定）
>
> **不要用 `infinite-canvas.join-chinese.workers.dev`。** 那个域名在部分网络下会被 **SNI 级阻断**——
> TCP 443 是通的，但 TLS 握手被打断，换 DNS、改 hosts、换 CF 边缘 IP 全都无效；
> 而**同 IP 段的自有域名完全正常**。所以对外可访问性依赖这个自定义域名，
> 配置在 `wrangler.jsonc` 的 `routes` 里（`custom_domain: true`）。

## 文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口与路由分发；未匹配的请求交回静态资源 |
| `auth.ts` | 会话签发/校验，`/api/auth/*` 四个接口 |
| `members.ts` | 成员 CRUD（仅管理员） |
| `config.ts` | 共享配置读写：真实 Key 落 `channel_secrets`；管理员下发真实 Key，普通用户下发带渠道 id 的占位符（仅管理员可写） |
| `proxy.ts` | 代理转发 + 真实 Key 注入（`/<完整目标URL>`）；SSE 流式透传 |
| `password.ts` | 密码派生规则常量与校验值计算 |
| `crypto.ts` | base64url、HMAC-SHA256、常量时间比较 |
| `http.ts` | JSON 响应、Cookie、错误响应 |
| `types.ts` | `Env` 与领域类型（不依赖 `@cloudflare/workers-types`） |
| `schema.sql` | D1 建表语句 |
| `smoke-test.mjs` | 接口层端到端测试（131 条断言：鉴权、权限、防自锁、共享配置、**代理与 Key 注入、SSE**、路由行为、KDF 一致性） |
| `e2e-access.mjs` | 浏览器端到端测试（真实 Chromium 走完整用户路径，见文末） |

## 前端叠加层在哪

门禁的前端部分集中在这些**新增文件**里，对上游的改动只有 4 处缝合点：

| 新增文件 | 职责 |
|---|---|
| `web/src/services/api/auth.ts` | PBKDF2 派生（必须与 `password.ts` 一致）+ 登录/登出/会话接口 |
| `web/src/services/api/members.ts` | 成员管理接口客户端 |
| `web/src/services/api/shared-config.ts` | 共享配置拉取/发布，以及写入本地 store 的适配层 |
| `web/src/stores/use-access-store.ts` | 登录态、角色、启动流程 |
| `web/src/components/access/access-gate.tsx` | 全局门禁：登录页 / 应用 / 降级提示 / 错误页 |
| `web/src/components/access/shared-config-panel.tsx` | 共享配置发布面板 |
| `web/src/pages/login/index.tsx` | 登录页与首次初始化页 |
| `web/src/pages/admin/members/index.tsx` | 成员管理页（`/admin/members`） |
| `web/src/lib/access-error.ts` | 错误码 → 文案 |
| `web/src/i18n/access.ts` | 门禁文案（独立文件，让上游两个语言包保持零改动） |

| 上游缝合点 | 改动 |
|---|---|
| `web/src/components/layout/client-root-init.tsx` | +1 import，`return <>{children}</>` → `return <AccessGate>{children}</AccessGate>` |
| `web/src/router.tsx` | +1 import，+1 条路由 |
| `web/src/components/layout/user-status-actions.tsx` | +2 import，+2 个按钮（管理员入口、退出登录） |
| `web/src/i18n/index.ts` | 合并 `access` 命名空间，2 行 |

## 本地开发

`wrangler.jsonc` 里的 `d1_databases` 现在是**常驻启用**的（真实 `database_id` 已填入）。
这一点不能再随意改回注释：绑定缺失时 `wrangler dev` 拿不到 `env.DB`，
所有 `/api/*` 会落到 `database_unavailable`。

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

跑冒烟测试（**需要空库**；它会真的写入 D1）：

```bash
npx wrangler d1 execute infinite-canvas --local --command "DELETE FROM users; DELETE FROM app_config; DELETE FROM channel_secrets;"
node worker/smoke-test.mjs http://127.0.0.1:8787
```

> `e2e-access.mjs`（浏览器端到端）同样要求空库。两者都从"首次初始化"开始跑，
> 所以**不能连着跑**——中间必须清一次库，否则第二步会撞上 `already_initialized`，
> 后续断言会成片 401（这是脚本设计使然，不是 bug）。

## 首次部署

以下三步已于 2026-09-16 在账户 `430961bc9844a4635e5fb22e33fe42b7` 完成。
换账号或重建库时按同样顺序重做：

```bash
# 1. 建 D1，把返回的 database_id 填进 wrangler.jsonc 的 d1_databases
npx wrangler d1 create infinite-canvas

# 2. 线上建表
npx wrangler d1 execute infinite-canvas --remote --file=./worker/schema.sql

# 3. 线上密钥（本地 .dev.vars 不会上传，必须单独设置）
npx wrangler secret put AUTH_SECRET
```

第 1 步不做就启用绑定，`wrangler deploy` 会在解析绑定时报
`Couldn't find a D1 DB with the id ...` 而失败——这是线上构建变红最常见的原因。

只有 `CLOUDFLARE_API_TOKEN`（缺 D1 权限）时，第 1、2 步可以改走 HTTP API：

```bash
# 建库
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"name":"infinite-canvas"}'

# 建表：POST /accounts/$ACC/d1/database/$UUID/query，body 为 {"sql": "<schema.sql 全文>"}
# 一次请求可以带多条语句，返回的 result 数组里每项对应一条。
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
| GET | `/api/config` | 登录用户 | 共享配置；`channels[].apiKey` 与顶层 `apiKey` 一律替换为占位符 |
| PUT | `/api/config` | 管理员 | 发布共享配置 `{config}`；真实 Key 落 `channel_secrets`，**不落 `app_config`** |
| GET | `/api/admin/members` | 管理员 | 成员列表 |
| POST | `/api/admin/members` | 管理员 | `{username, displayName?, role?, clientVerifier}` |
| PATCH | `/api/admin/members/:id` | 管理员 | `{displayName?, role?, status?}` |
| DELETE | `/api/admin/members/:id` | 管理员 | 删除成员 |
| POST | `/api/admin/members/:id/password` | 管理员 | `{clientVerifier}` 重置密码 |
| ANY | `/<完整目标URL>` | 登录用户 | 代理转发；命中占位符时注入该渠道的真 Key |

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

## 共享配置：普通用户为什么能用却拿不到 Key

管理员在「成员管理 → 共享配置」点发布后，服务端存两份东西：

```
   channel_secrets 表  ← 真实 API Key（主键是 channels[].id）
   app_config 表       ← 其余配置，channels[].apiKey 已换成占位符 "via-proxy:<channelId>"
```

普通用户登录时拉到的配置里：

| 字段 | 值 | 原因 |
|---|---|---|
| `channels[].baseUrl` | **真实上游地址** | 请求会拼成 `${proxyUrl}/${baseUrl}/v1/...`，代理要能从路径里解析目标 |
| `channels[].apiKey` | `"via-proxy:<channelId>"` | 非空才能通过前端那批"Key 不能为空"的校验；带 id 是为了让代理解析出"该注入哪个渠道的 Key" |
| `proxyEnabled` / `proxyUrl` | 由**前端**强制设为「本站 origin」 | 管理员本机可能在用 `127.0.0.1:23210` 那个本地代理，对普通用户毫无意义；也只有前端知道用户实际访问的是哪个域名 |

> 早期方案文档里写的"baseUrl 填成代理地址"是错的，会让请求变成 `${proxyUrl}/${proxyUrl}/v1/...`。
> 现在按正确语义实现：`baseUrl` 保持真实上游，`proxyUrl` 指向本站。

**渠道 id 是密钥的关联键**：删掉渠道再新建会换 id，需要重新发布一次；只改名字或地址不受影响。
删除渠道时其残留密钥会一并清理（`smoke-test.mjs` 里有对应断言）。

服务端会在响应里带 `missingSecrets: string[]`，列出"配置里有、但库里没存到真实 Key"的渠道 id，
管理端的共享配置面板据此提示——否则这类渠道在普通用户那里只会表现为生成失败。

## 代理转发：占位符是怎么变成一个真 Key 的

`proxy.ts` 的输入是路径里的完整目标地址（上游 `withLocalProxy()` 拼的 `${proxyUrl}/${目标URL}`）：

```
   /https://api.openai.com/v1/images/generations
```

请求本身带的是普通用户手里的占位符（`Authorization: Bearer via-proxy:ch-1`）。
难点不在转发，而在**"这个请求该用哪个渠道的 Key"**——目标 URL 里没有渠道信息，
而两个渠道完全可能共用同一个 `baseUrl`（同一家供应商配两个 Key），所以**不能靠地址猜**。

解法是让占位符自带渠道 id（`via-proxy:<channelId>`），代理据此查 `channel_secrets` 后替换。
渠道 id 本来就在下发给普通用户的 `channels[].id` 里，所以不算新增泄漏。

替换点有**三处**，因为上游对三种格式的写法不同：

| 位置 | 触发场景 |
|---|---|
| `Authorization: Bearer <key>` | OpenAI 格式（`image.ts:351`、`audio.ts:18`） |
| `x-goog-api-key: <key>` | Gemini 格式（`image.ts:374`、`model-plugin.ts:396`） |
| `?key=<key>` 查询参数 | 部分 Gemini 路径把 Key 放进 URL（`model-plugin.ts:700`） |

裸占位符（`via-proxy`，没有 id，来自历史配置或顶层 `apiKey`）退化为**按目标 origin 匹配渠道**。
匹配不到就报 502，**绝不"随便挑一个 Key"**——那会让请求带着错误渠道的凭据打过去，
在用户那边只表现为莫名其妙的 401。

请求里没有占位符时**原样转发**：上游还有别的合法用法会经过这个代理（用户自己填了真 Key 的渠道、
模型插件里的第三方接口），此时不做任何注入。

### 几个刻意的取舍

- **不转发 Cookie**。站内会话 Cookie 是我们的凭据，绝不能出现在发给供应商的请求里（有断言）。
- **不加 CORS 头**。请求本来就同源，不需要 `access-control-allow-origin: *`。
  参考实现 `canvas-proxy/index.js` 加了通配 CORS，那是给跨域用法准备的。
- **丢弃 `accept-encoding` / `content-length` 等框架头**：`fetch()` 已经重新解码并重新分帧，
  原框架头不再成立（照 `canvas-proxy` 的做法）。
- **SSE 不缓冲**：上游 body 直接交给 `Response`，文本流式输出一个 chunk 一个 chunk 到浏览器。
- **这是一个"登录用户可用的转发器"，不是白名单代理**。任何登录用户都能借它请求任意 http(s) 地址
  （`model-plugin.ts:43` 允许插件写绝对 URL）。当前规模（管理员 1 人 + 普通用户 2-5 人）可接受，
  但这是**已知的、刻意保留的**开放面，收紧方案（origin 白名单）留给阶段 4。

`readTarget()` 的写法照搬 `canvas-proxy/index.js:35-47`，它已经处理过两个真实踩到的坑：
浏览器对路径的转义（`decodeURI`），以及部分客户端把嵌入 URL 里的 `//` 收敛成 `/`
（实测 `https:/api.openai.com/...` 会出现，必须补回来）。

## 已验证 / 未验证

**已实测**（`smoke-test.mjs` 131/131；`e2e-access.mjs` 真实 Chromium，本地 44/44）：

- 初始化引导、登录、登出、会话校验
- 成员增删改查、角色边界（普通用户一律 403）
- 防自锁：不能删除自己；至少保留一名启用状态的管理员
- 改角色 / 重置密码 / 停用 / 删除后，目标用户的旧会话立即失效
- 错误密码与不存在的用户返回同一错误码（不泄漏账号是否存在）
- 共享配置：未登录 401、普通用户写入 403、重复发布不会把占位符当成真 Key、
  删渠道会清理残留密钥、响应里（以及数据库的 `app_config` 里）都不出现真实 Key
- **密码派生参数三方一致**：`worker/password.ts` ↔ `web/src/services/api/auth.ts` ↔ 测试脚本，
  用文本解析做字面量比对，单侧改动会让测试失败
- **代理与 Key 注入**（全部以"假上游实际收到了什么"为判据，不是看我们的返回值）：
  未登录 401；`Authorization` / `x-goog-api-key` / `?key=` 三处占位符都被替换成真 Key；
  上游**没有**收到会话 Cookie；POST 请求体完整转发；无占位符时原样转发；
  渠道不存在或缺密钥时 502 且错误码可区分；上游不可达 502
- **SSE 流式透传**：三段事件全部送达，且首块在 ~170ms 就到达（总计 ~470ms）——
  证明是边生成边吐，没有被攒到最后
- 浏览器端到端：首次初始化 → 建成员 → 发布配置 → 退出 → 普通用户登录 →
  本地配置被共享配置覆盖、`apiKey` 是占位符、`proxyUrl` 是本站、整个 localStorage 里没有真实 Key
- **配置只对管理员开放**（浏览器端逐条验证）：
  - 管理员顶栏有配置入口、能直接打开 `/config`、看到的是真实配置界面（反向断言——
    收紧权限时最容易犯的错是把管理员也一起锁掉）
  - 普通用户顶栏没有配置入口，直接访问 `/config` 被弹回首页、看不到配置界面
  - `?baseUrl=&apiKey=` 这条"扫码导入渠道凭据"的路径对普通用户整段跳过：
    地址栏被擦干净、没有写进渠道、也没有弹出配置框
  - 另有一条**自检**：几条"找不到真实 Key"的断言都是把 localStorage 序列化后搜索，
    先确认这个序列化真的读到了内容（本次 1420 字节），否则那些断言会永远成立
- **浏览器 → 代理 → 上游 的完整链路**（本地模式）：普通用户在页面里发出的请求经代理返回 200，
  上游收到的是真 Key，而浏览器里自始至终没有它
- **真实 HTTPS 部署**（线上模式，`canvas.joinhu01.fun`）：首次初始化 →
  建成员 → 发布配置 → 退出 → 普通用户登录全流程通过。这一趟证明了本地 http
  环境测不到的东西——**httpOnly 会话 Cookie 在真实 HTTPS 下正常工作**，
  且 `proxyUrl` 被正确强制成 `https://canvas.joinhu01.fun`（而不是管理员本机的 `127.0.0.1:23210`）
- 线上权限边界：匿名访问 `/api/config`、`/api/admin/members` 与代理路径
  `/<完整目标URL>` 均返回 401
- SPA 路由行为：深层路由刷新返回 200；导航请求不经过 Worker

**未验证**：

- 10ms CPU 上限在**真实免费版**下的表现（本地 dev 无此限制）。
- **代理转发本身在线上未实测**。线上模式的【7】需要假上游，而 Worker 跑在 Cloudflare 边缘
  够不到本机的 `127.0.0.1`，所以线上只验证到"代理路径已注册 + 鉴权生效（401）"。
  转发、Key 注入、SSE 的**逻辑正确性由本地 131 + 44 条断言覆盖**（同一份代码），
  线上与本地唯一可能的差异是 Cloudflare 生产环境的 `fetch` 行为（如路径里 `//` 的规范化）。
  若要补上这最后一块，需要在线上模式里换一个**公网可达**的目标（如 `httpbin.org/anything`），
  代价是引入外部依赖。

**已知未收紧的口子**（阶段 4）：

1. 代理是"登录用户可用的转发器"，没有 origin 白名单（见上面"刻意的取舍"）。

> 阶段 4 的另一半——"普通用户看不到配置"——**已完成**。三层一起做：
> 顶栏入口按角色渲染、`/config` 加路由守卫、**配置弹窗层兜底**（上游十几处
> `openConfigDialog` 自动调用点因此一处都不用改）。判定集中在 `useCanOpenConfig()`，
> 同时放行 `degraded`（服务端还没配好的窗口期，把正在配置的管理员锁在门外更糟）。
> 详见 `web/src/stores/use-access-store.ts` 的注释。

## 浏览器端到端测试

```bash
npx wrangler dev --port 8787      # 另开一个终端
node worker/e2e-access.mjs http://127.0.0.1:8787
```

需要 `playwright-core` 与一份 Chromium。两者都不是本仓库的依赖，用环境变量指路：

| 变量 | 用途 |
|---|---|
| `PLAYWRIGHT_MODULE` | `playwright-core` 的入口路径或所在目录；缺省按普通模块解析 |
| `CHROMIUM_PATH` | `chrome` 可执行文件路径；缺省交给 playwright 自己找 |

在无头环境下它会先探测 `needsSetup`，**库非空时会直接退出并提示先清库**，不会跑出一堆无意义的失败。

它在第【4】步会额外建一个指向**本地假上游**的渠道，第【7】步用真实浏览器发请求去验证
Key 真的注入到了上游。所以本地模式下 `wrangler dev` 必须是本机的（假上游监听在 `127.0.0.1`）。

### 线上模式（`E2E_LIVE=1`）

```bash
E2E_LIVE=1 node worker/e2e-access.mjs https://canvas.joinhu01.fun
```

同一套脚本指向真实部署，用来验证**本地 http 环境测不到的东西**，主要是
httpOnly Cookie 在真实 HTTPS 下的行为（`Secure` / `SameSite` 在 https 与 http 下判定不同）。

代价是必须跳过依赖"本机假上游"的两段：【4】里的第二个渠道和整个【7】——
线上 Worker 在 Cloudflare 边缘执行，够不到这台机器的 `127.0.0.1`。
所以线上比本地少 7 条：本地是 **44 条**，线上模式则是 **37 条**，两者互补而不是互相替代。

> 37 这个数字是按脚本静态推算的，**不是实测**：线上库里已经有真实用户数据，
> 而脚本探测到库非空就会直接退出，不能为了跑测试去清用户的库。
> 阶段 3 时线上跑过 27/27，那是当时 34 条版本下的数字。

线上跑同样需要空库，跑完记得清库（用 D1 的 HTTP API 即可，不必装 wrangler）：

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database/$DB/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"sql":"DELETE FROM users; DELETE FROM app_config; DELETE FROM channel_secrets;"}'
```

> 线上跑曾经暴露过一个本地看不见的竞态：脚本只等 `<table>` 元素出现就去断言行内容，
> 而表格壳先渲染、数据靠异步请求后到。本地回环几毫秒所以一直通过，
> 线上跨洋 + D1 查询慢就翻车了。**等到具体那一行**才是正确写法。

## 排查笔记（踩过的坑）

- **改完前端代码重新构建后，要重启 `wrangler dev`。**
  它启动时建立资源清单，`web/dist` 重建后清单可能是旧的，表现为
  **JS/CSS 请求被当成未命中、返回 SPA 外壳（`content-type: text/html`）**，
  页面白屏、登录页出不来。判断方法：`curl -D - -o /dev/null http://127.0.0.1:8787/assets/<构建出的文件名>`
  看 `content-type` 是不是 `text/javascript`。
- **同一端口不要留两个 `wrangler dev` 实例。** Windows 上两个进程可以同时 bind 同一个端口，
  请求会被路由到"坏"的那个，表现为各种莫名其妙的超时。
- **两个测试脚本都要求空库、且不能连着跑**（都从"首次初始化"开始），中间必须清一次库，
  否则第二个脚本会撞 `already_initialized` 并成片 401。
- **`wrangler.jsonc` 的 D1 绑定不要图省事改回注释。** 现在它是常驻启用的，
  注释掉之后 `wrangler dev` 拿不到 `env.DB`，`/api/*` 会全部落到 `database_unavailable`，
  本地测试会成片失败（这个坑踩过一次）。
- **改了 `database_id`，本地的表会"凭空消失"。** miniflare 按这个 id 给本地 sqlite 文件命名
  （`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`），所以**换 id 等于换了个空库**，
  表现是所有 `/api/*` 报 `no such table: users`。重新跑一次
  `d1 execute infinite-canvas --local --file=./worker/schema.sql` 就好；
  旧那个 sqlite 还留在目录里，可以直接删。
- **本机网络访问不到 `*.workers.dev` 时，仍然可以验证线上部署。** 用 Cloudflare API
  下载线上脚本 + 查绑定，而不是靠 HTTP 请求：

  ```bash
  # 线上 Worker 的绑定（应有 env.DB 与 env.ASSETS）
  curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/infinite-canvas/settings" \
    -H "Authorization: Bearer $TOKEN"

  # 线上脚本内容（确认自己的代码真的部署上去了）
  curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/infinite-canvas/content/v2" \
    -H "Authorization: Bearer $TOKEN" -o /tmp/live.js
  grep -o "needsSetup\|channel_secrets\|via-proxy" /tmp/live.js | sort -u
  ```

  这只能证明"代码与绑定在位"，**不能替代真实请求验证**。要真正跑通还得有可达的域名。
- **本机 `wrangler deploy` 会在最后一步失败，而部署其实靠 CI 完成。**
  `wrangler.jsonc` 里的 `routes`（自定义域名）需要 zone 级的
  `Workers Routes: Edit` 权限，而常用的账户级 API Token 没有它。表现是：
  `Uploaded infinite-canvas (8.60 sec)` 之后紧跟
  `Authentication error [code: 10000]`（`/zones/<id>/workers/routes`），
  退出码非 0、**deployment 也没创建**。
  正确的做法是**推到 GitHub，让 Cloudflare Workers Builds 构建部署**——
  它用平台内部凭据，不受这个权限限制。验证方式见下一条。
- **不要用构建产物的文件名去判断线上跑的是哪一版。** CF 用 Bun 构建，
  本机用 Node 构建，同一份源码产出的文件名 hash **不一样**
  （实测：本机 `index-DaRahg9S.js`，线上 `index-DLmQG0Ve.js`）。
  抓线上 `index.html` 认出文件名后去请求它，若内容不对还会被 SPA 兜底成 HTML……
  真正可靠的判据是**在 bundle 里搜一个只可能出现在新代码里的字符串**：

  ```bash
  curl -s https://canvas.joinhu01.fun/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
  curl -s "https://canvas.joinhu01.fun/assets/<上一步的文件名>" -o live-bundle.js
  grep -c "只在本次新增的文案" live-bundle.js     # 命中即证明新版本已上线
  ```

  顺带记一个 Git Bash 的坑：Windows 原生 `curl` 不认识 `/tmp/...`（会当成 `C:\tmp`），
  用 `-o /tmp/x` 写文件会静默失败，改用相对路径或 Windows 路径。
