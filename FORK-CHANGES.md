# Fork 改动清单（相对上游 `basketikun/infinite-canvas`）

> **基线**：上游提交 `e856c878e0a34651bb828e28f0af20d71016a7d4`（2026-09-20 拉取时上游领先 0 个提交）
> **本 fork 领先上游**：31 个功能提交（不含本台账自身的提交；`git rev-list --count <基线>..HEAD` 可随时复核）
> **总量**：新增 37 个文件 · 修改 24 个上游文件 · 删除 0 · 重命名 0

这份文件是**唯一权威的改动台账**。之前散落在 `infinite-canvas-门禁实施方案.md`（只覆盖门禁阶段）
与工作记忆里的缝合点清单（缺 10 项）都不完整，以本文件为准。

---

## 一、怎么用这份清单

| 场景 | 看哪一节 |
|---|---|
| 同步上游新版本 | **第三节**（修改的上游文件）——只有这些文件可能冲突，第二节的新增文件完全不参与合并 |
| 排查某个功能是谁加的 | 第四节（按功能模块） |
| 部署 / 回滚 | 第七节 |
| 人工测试 | 第六节（已知偏差 + 建议测试路径） |

同步命令（**只能用 merge，严禁 `git reset --hard`**）：

```bash
git fetch upstream main
git merge upstream/main      # 冲突只会出现在第三节列出的文件里
cd web && npm run build      # 本地验证
git push origin main         # 推送后由 Cloudflare Workers Builds 自动构建
```

---

## 二、新增文件（37 个，完全不参与上游合并）

### Worker 后端（13）——上游是纯静态 SPA，整个 `worker/` 目录都是新增的

| 文件 | 作用 |
|---|---|
| `worker/index.ts` | Worker 入口：路由分发（API / 代理 / 静态资源兜底） |
| `worker/auth.ts` | 会话签发与校验（httpOnly Cookie） |
| `worker/members.ts` | 成员增删改查 |
| `worker/config.ts` | 共享配置读写；WebDAV 纳管配置 + 成员/管理员隔离段计算 |
| `worker/password.ts` | 密码派生与校验（PBKDF2，与前端参数逐字对齐） |
| `worker/crypto.ts` | HMAC / 常量时间比较等密码学原语 |
| `worker/proxy.ts` | 模型请求代理转发 + 真实 Key 注入 |
| `worker/http.ts` | 请求/响应工具（JSON、错误码、体积限制） |
| `worker/types.ts` | Worker 侧类型定义 |
| `worker/schema.sql` | D1 建表脚本（可重复执行） |
| `worker/README.md` | Worker 侧说明（含部署踩坑记录） |
| `worker/smoke-test.mjs` | 门禁 API 冒烟测试（149 条断言，需空库） |
| `worker/e2e-access.mjs` | 线上端到端验证脚本（真实浏览器链路） |

### 门禁前端（13）

| 文件 | 作用 |
|---|---|
| `web/src/components/access/access-gate.tsx` | 全局门禁：未登录渲染登录页，已登录挂载配置同步与静默备份引擎 |
| `web/src/components/access/shared-config-sync.tsx` | 配置自动下发（管理员）/ 自动拉取（成员） |
| `web/src/components/access/shared-config-panel.tsx` | 成员管理页里的「共享配置」发布面板 |
| `web/src/components/access/auto-sync-engine.tsx` | 备份状态行（顶栏）+ 备份详情面板 + 引擎挂载 |
| `web/src/pages/login/index.tsx` | 登录页 / 首次初始化页 |
| `web/src/pages/admin/members/index.tsx` | 成员管理页 |
| `web/src/services/api/auth.ts` | 登录 / 登出 / 会话 + PBKDF2 派生 |
| `web/src/services/api/members.ts` | 成员管理客户端 |
| `web/src/services/api/shared-config.ts` | 共享配置拉取/发布 + 写入本地 store 的适配层 |
| `web/src/stores/use-access-store.ts` | 登录态与角色（五种状态） |
| `web/src/stores/use-shared-config-sync-store.ts` | 配置同步状态（仅界面显示） |
| `web/src/lib/access-error.ts` | 错误码 → 文案 |
| `web/src/i18n/access.ts` | 门禁与备份文案（独立命名空间，避免改语言包） |

### 内置 Agent（3）

| 文件 | 作用 |
|---|---|
| `web/src/lib/agent/builtin-agent-runner.ts` | 纯前端内置 Agent 执行驱动器（工具调用循环） |
| `web/src/lib/agent/builtin-agent-tools.ts` | 内置 Agent 可用的画布/生图/资产等工具定义 |
| `web/src/lib/agent/builtin-agent-history.ts` | 内置 Agent 对话历史本地持久化 |

### WebDAV 静默备份（3）

| 文件 | 作用 |
|---|---|
| `web/src/services/auto-sync-engine.ts` | 无感静默同步引擎（定时轮询 + 回前台 + 生成结束触发，含互斥与退避） |
| `web/src/stores/use-auto-sync-store.ts` | 备份界面状态（仅显示用） |
| `web/src/stores/use-generation-activity-store.ts` | 「正在生成」活动计数，供备份避让 |

### 提示词库（3）

| 文件 | 作用 |
|---|---|
| `web/src/stores/use-my-prompt-store.ts` | 「我的提示词」存储 |
| `web/src/components/prompts/my-prompt-card.tsx` | 提示词卡片 |
| `web/src/components/prompts/my-prompt-modal.tsx` | 提示词编辑弹窗 |

### 构建与部署（2）

| 文件 | 作用 |
|---|---|
| `package.json`（根目录） | 让 Cloudflare Workers Builds 的 `bun run build` 能解析到 web/ |
| `wrangler.jsonc` | Worker 部署配置（静态资源、D1 绑定、自定义域名路由） |

---

## 三、修改的上游文件（24 个）——同步上游时只盯这里

「冲突风险」= 上游改动同一区域时的合并冲突概率，也是**人工测试的重点区域**。

| 文件 | 改了什么 | 增/删行 | 冲突风险 |
|---|---|---|---|
| `web/src/services/app-sync.ts` | 同步调度可切并发/顺序；新增远端物理文件秒传预检；坏清单降级自愈（不再抛错）；apply 前重读本地重新合并 | 131 / 45 | **高** |
| `web/src/services/webdav-sync.ts` | 新增 `scoped()` 统一收口隔离段、`listWebdavDirectoryFiles()` 目录探测、上传失败/423 自动重试、单请求超时 120s → 300s | 85 / 18 | **高** |
| `web/src/components/layout/app-config-modal.tsx` | 弹窗层权限兜底；WebDAV tab 增加并发模式/秒传/静默备份/下发/独立子目录等开关；成员侧连接信息置灰 | 115 / 21 | **高** |
| `web/src/components/agent/local-agent-panel.tsx` | 接入内置 Agent 驱动 + 本地历史记录 | 219 / 26 | **高** |
| `web/src/pages/prompts/index.tsx` | 提示词中心接入「我的提示词」 | 186 / 26 | **高** |
| `web/src/components/prompts/prompt-select-dialog.tsx` | 选择弹窗整合我的提示词 | 223 / 47 | **高** |
| `web/src/components/agent/agent-connect-view.tsx` | 增加内置/本地模式切换器与内置状态卡片 | 140 / 71 | 中 |
| `web/src/components/agent/agent-chat-composer.tsx` | 底部工具栏挂载双模型下拉（思考/图像）与图像设置面板 | 105 / 19 | 中 |
| `web/src/stores/use-config-store.ts` | WebdavSyncConfig 增加 `memberScope`/`isolateMembers` 等字段 + 目录幂等拼接函数 | 55 / 0 | 中 |
| `web/src/stores/use-agent-store.ts` | 增加 `agentMode: "builtin" \| "local"` | 36 / 5 | 中 |
| `web/src/components/canvas/canvas-side-panel.tsx` | 侧栏插入「我的自定义提示词」分组 | 61 / 1 | 中 |
| `web/src/components/layout/user-status-actions.tsx` | 挂载备份状态行、成员管理入口、退出登录；配置齿轮按角色鉴权 | 50 / 3 | 中 |
| `web/src/components/layout/client-root-init.tsx` | 包裹 `<AccessGate>`；URL 凭据参数对非管理员跳过 | 11 / 2 | 低 |
| `web/src/router.tsx` | 新增 `/admin/members` 路由 | 3 / 0 | 低 |
| `web/src/pages/config/index.tsx` | 非管理员访问 `/config` 拦截 | 8 / 0 | 低 |
| `web/src/components/layout/app-top-nav.tsx` | 导航栏对非管理员过滤 config 链接 | 4 / 1 | 低 |
| `web/src/components/layout/mobile-nav-drawer.tsx` | 移动端抽屉同上 | 4 / 1 | 低 |
| `web/src/i18n/index.ts` | 合并 `access` 命名空间 | 4 / 2 | 低 |
| `web/src/i18n/locales/zh-CN.ts` | 成员托管提示去掉备份路径 | 1 / 0 | 低 |
| `web/src/i18n/locales/en-US.ts` | 同上（英文） | 1 / 0 | 低 |
| `web/src/pages/canvas/project.tsx` | 10 处生成入口的公共咽喉处登记/注销「正在生成」 | 8 / 1 | 低 |
| `web/src/components/canvas/canvas-top-bar.tsx` | Agent 状态文案改为中文直书（见第六节偏差 1） | 2 / 2 | 低 |
| `web/src/components/layout/github-link.tsx` | 隐藏 GitHub 标志（渲染空） | 2 / 18 | 低 |
| `.gitignore` | 忽略 `.dev.vars`、`.wrangler/` | 5 / 1 | 低 |

> 注：`i18n/locales/*.ts` 各只改了 1 行（成员托管提示）。其余门禁/备份文案全部走独立文件
> `i18n/access.ts`，这是刻意的低冲突设计。

---

## 四、按功能模块串起来看

### 模块 1 · 用户门禁与成员管理
上游是纯静态 SPA，任何人都能打开。现在由 Worker 提供登录门禁：成员用管理员分配的账号登录，
配置（含 API Key）只对管理员开放。会话走 httpOnly Cookie，密码 PBKDF2 派生后再 HMAC，
数据库里既无明文也不存在可直接复用的登录值。
涉及：`worker/auth.ts`、`worker/members.ts`、`worker/password.ts`、`access-gate.tsx`、
`use-access-store.ts`、`pages/login`、`pages/admin/members`。

### 模块 2 · 配置分发与真实 Key 保护
真实 API Key 只存在 D1 的 `channel_secrets` 表。管理员改动配置后防抖 1.2 秒自动下发；
成员拿到的是 `via-proxy:<channelId>` 占位符，请求经本站 Worker 代理时注入真 Key。
管理员自己读回的是真实 Key，且多设备合并时保留本地已有真 Key。
涉及：`worker/config.ts`、`worker/proxy.ts`、`services/api/shared-config.ts`、
`shared-config-sync.tsx`、`shared-config-panel.tsx`。

### 模块 3 · 内置 Agent
上游 Agent 依赖本地 Codex 进程。新增纯前端内置模式，开箱即用；输入框底部可分别选择
思考模型与图像模型，并带图像设置面板。
涉及：`lib/agent/builtin-agent-*`、`agent-connect-view.tsx`、`agent-chat-composer.tsx`、
`local-agent-panel.tsx`、`use-agent-store.ts`。

### 模块 4 · 我的提示词
新增提示词库，并与画布侧栏、提示词中心、选择弹窗三处联动。
涉及：`use-my-prompt-store.ts`、`my-prompt-card.tsx`、`my-prompt-modal.tsx`、
`pages/prompts/index.tsx`、`prompt-select-dialog.tsx`、`canvas-side-panel.tsx`。

### 模块 5 · WebDAV 统一备份（最后一块）
管理员配好一台 WebDAV 后，所有登录用户的数据（画布、资产、生图/视频记录）在空闲时
**自动增量备份**，无需任何人点按钮。管理员与每位成员分别落在 `<根目录>/users/<用户名>/`，
互不覆盖。生成过程中自动避让；失败按退避重试并可在顶栏状态行点开详情手动重试。
涉及：`services/auto-sync-engine.ts`、`use-auto-sync-store.ts`、
`use-generation-activity-store.ts`、`access/auto-sync-engine.tsx`、
`services/app-sync.ts`、`services/webdav-sync.ts`、`stores/use-config-store.ts`。

---

## 五、没有改动的上游机制（为什么不用改）

- **`withLocalProxy` 代理出口**：上游已有，直接复用，所以不需要逐个改 8 个 api 文件。
- **配置导入/导出**：上游已有，成员侧配置分发复用了它。
- **`router.tsx` 的门禁**：门禁放在 `client-root-init.tsx`（包裹全应用的壳）内部，
  不需要给每条路由加守卫。
- **配置权限拦截点**：拦在 `AppConfigModal` 一处，而不是改上游十几处 `openConfigDialog` 调用方。

---

## 六、已知偏差与建议人工测试的路径

### 已知偏差（都是有意的取舍，不是 bug）

1. **`canvas-top-bar.tsx` 的 Agent 状态文案硬编码中文**。上游用的是 i18n key
   （`canvas.agentConnected` 等），为了拿到「Agent 就绪」这个确切措辞改成了中文字面量。
   副作用：切到英文界面时这一处仍是中文。**未修，等确认措辞后再决定。**
2. **管理员旧备份数据未迁移**。改成 `users/<用户名>/` 之前，管理员的数据同步在共享根目录。
   首次同步会在 `users/<管理员>/` 传一份新副本，根目录的旧文件夹需要手工删除。
3. **切换「独立子目录」开关后，当前设备的实际路径要等一次配置回读**（登录时或 ≤60 秒轮询）
   才跟着变；期间仍按旧路径同步，不影响数据安全。
4. **成员打不开配置弹窗**，因此「上传模式 / 断点秒传 / 静默备份」三个开关实际上由管理员
   一并决定，成员无法自调。设计文档里"留给成员自调"的意图目前没有 UI 支撑。
5. **多成员共用同一个 WebDAV 账号**，且目录名可预测（`users/<用户名>`）。持有该凭据的成员
   理论上可以用第三方客户端写入别人的目录——这是共享账号模型的固有限制，应用层无法解决。
6. **`i18n` 里保留了 `config.webdav.errors.invalidManifest` 键**。该错误已改为降级自愈不再抛出，
   但旧版缓存页面仍可能显示这句文案；等所有人升级完可以删。

### 建议人工测试的路径（按风险排序）

1. **成员账号首登 + 首次备份**：确认 `users/<成员名>/` 下出现四个业务目录，且与管理员目录互不干扰。
2. **静默备份不打扰**：让管理员与成员各挂机 5~10 分钟，确认没有反复弹「管理员更新了配置」通知。
3. **备份状态可见性**：顶栏状态行 → 详情面板（状态/上次成功时间/上次上传/开关/立即备份），
   确认界面**不再出现任何目录路径**。
4. **生成与备份并存**：备份进行中触发生图，确认生成结果不被覆盖（这是本轮修掉的最严重问题）。
5. **撤销下发**：管理员关掉「下发给所有成员」，确认成员端备份停止、界面回到「未启用云端备份」。
6. **权限边界**：成员账号确认看不到配置齿轮、打不开 `/config`、`/admin/members` 不可访问。
7. **管理员干净设备**：清空浏览器数据后登录，确认不会因为「本机无真实 Key」而误发布空配置
   （界面应显示「未下发给成员」并说明原因）。
8. **上游同步演练**（可选）：`git merge upstream/main` 跑一遍，确认只在第三节列出的文件出现冲突。

---

## 七、部署与回滚

- **部署**：只能走 GitHub push → Cloudflare Workers Builds 自动构建。
  本机 API Token 缺 zone 级权限，直接 `wrangler deploy` 会在 routes 阶段报 10000 错误。
- **线上地址**：<https://canvas.joinhu01.fun>（自定义域名；`*.workers.dev` 在部分网络被 SNI 阻断）。
- **数据库**：D1 库 `989c4426-c843-4eea-b8e4-122523b100fe`，建表脚本 `worker/schema.sql`（幂等）。
- **回滚**：`git revert <commit>` 后推送即可触发重新构建；不建议 `git reset --hard`。
  注意 WebDAV 隔离路径的改动回滚后，已写入 `users/` 的数据不会自动搬回根目录（数据仍在，只是位置变了）。
- **测试环境**：跑冒烟测试必须用**空库**（`.wrangler/state-smoke` + 先执行 `schema.sql`），
  否则 `setup` 那一步会因为"已初始化"失败。
