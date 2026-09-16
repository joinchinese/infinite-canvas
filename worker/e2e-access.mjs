#!/usr/bin/env node
/**
 * 门禁的浏览器端到端测试（真实 Chromium + 真实构建产物）。
 *
 * 它走的是完整用户路径，不是接口层面的模拟：
 *
 *   1. 空库首次访问 → 出现「首次初始化」页 → 创建首位管理员 → 进入应用
 *   2. 管理员进入 /admin/members → 通过界面新增一个普通用户
 *   3. 给管理员注入一份"含真实 Key 的渠道配置" → 在「共享配置」页点发布
 *   4. 退出登录 → 用普通用户账号登录 → 检查**本地配置已被共享配置覆盖**，
 *      且整个 localStorage 里找不到真实 Key
 *   5. 普通用户在浏览器里发一次真实请求 → 经代理转发 → 用假上游确认
 *      **上游收到的是真 Key、而浏览器里始终没有它**
 *
 * 第 5 步是"普通用户能用却拿不到 Key"的最终证明，所以它断言的是**上游实际收到了什么**，
 * 而不是我们的返回值（返回值"看起来对"不代表请求真的发出去了）。
 *
 * ## 依赖
 *
 * 需要 `playwright-core` 与本机已下载的 Chromium。两者都不是本仓库的依赖，
 * 所以用环境变量指路（缺省时按普通模块解析）：
 *
 *   PLAYWRIGHT_MODULE   playwright-core 的入口路径（或其所在目录）
 *   CHROMIUM_PATH       chrome 可执行文件路径；缺省时交给 playwright 自己找
 *
 * ## 用法
 *
 *   npx wrangler dev --port 8787          # 另开一个终端
 *   node worker/e2e-access.mjs http://127.0.0.1:8787
 *
 * **请对空库运行**（`users` 表非空时第一步会失败）：
 *   npx wrangler d1 execute infinite-canvas --local --command "DELETE FROM users; DELETE FROM app_config; DELETE FROM channel_secrets;"
 */

import { isAbsolute } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const BASE_URL = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN = { username: "e2e-admin", password: "admin-Passw0rd!" };
const MEMBER = { username: "e2e-member", password: "member-Passw0rd!" };
const REAL_KEY = "sk-e2e-real-key-must-not-reach-member";
/** 第二个渠道的 Key：它指向本地假上游，用来验证"经代理后上游真的收到了真 Key"。 */
const LIVE_KEY = "sk-e2e-live-key-injected-by-proxy";
const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
/** 会话 Cookie 名（`worker/http.ts`）。会话是无状态签名 Cookie，所以保存下来到后面依然有效。 */
const SESSION_COOKIE = "ic_session";
/** 「偏好设置」里系统提示词输入框的 placeholder——用它精确定位到那个 textarea，比按顺序取第几个稳。 */
const SYSTEM_PROMPT_PLACEHOLDER = "例如：你是一位擅长电影感写实摄影的视觉导演。";
/** 【4b】靠自动同步写进服务端的值，【5】会验证成员拿到的正是这个最新版本（而不是最初手动发布的那份）。 */
const AUTO_SYNC_PROMPT = "e2e-autosync-prompt";
/** 【6b】里"管理员在别处改配置"用的值，用来验证成员端会自动拉取新版本。 */
const MEMBER_REFRESH_PROMPT = "e2e-member-autorefresh-prompt";

// 线上模式（`E2E_LIVE=1`）：目标是真实的 Cloudflare 部署，用来验证本地 http 环境测不到的东西，
// 主要是 **httpOnly Cookie 在真实 HTTPS 下的行为**（Secure / SameSite 在 https 与 http 下判定不同）。
//
// 代价是必须跳过依赖"本机假上游"的两段：【4】里的第二个渠道和整个【7】。
// Worker 跑在 Cloudflare 的边缘，够不到这台机器的 127.0.0.1，所以那两段在线上无意义——
// 它们由本地模式覆盖（本地跑是 34 条断言）。
const LIVE_MODE = process.env.E2E_LIVE === "1";

/**
 * 假上游：验证代理注入时，断言依据必须是"上游实际收到了什么"，而不是我们自己的返回值。
 */
function startUpstream() {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url || "/", "http://upstream");
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        method: req.method,
                        path: url.pathname,
                        authorization: req.headers.authorization || "",
                        cookie: req.headers.cookie || "",
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            });
        });
        server.listen(0, "127.0.0.1", () => {
            // unref：即使中途抛错没走到 close，也不要把进程挂在监听器上。
            server.unref();
            resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

const results = [];
let failures = 0;

function record(name, passed, detail = "") {
    results.push({ name, passed, detail });
    if (!passed) failures += 1;
    console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function loadChromium() {
    const raw = process.env.PLAYWRIGHT_MODULE || "playwright-core";
    // Windows 上把绝对路径直接交给 ESM 动态 import 会报 "URL scheme must be file"，
    // 所以这里统一转成 file:// URL（相对路径/裸模块名原样交给解析器）。
    const modulePath = isAbsolute(raw) ? pathToFileURL(raw).href : raw;
    try {
        const loaded = await import(modulePath);
        return loaded.chromium ?? loaded.default?.chromium;
    } catch (error) {
        console.log(`\n跳过：无法加载 playwright-core（${error.message}）`);
        console.log("设置 PLAYWRIGHT_MODULE 指向它的安装位置后重试。\n");
        return null;
    }
}

/** 首位管理员那一步需要空库；这里先探测一次，避免在非空库上跑出一堆无意义的失败。 */
async function looksUninitialized() {
    const response = await fetch(`${BASE_URL}/api/auth/me`);
    const payload = await response.json().catch(() => null);
    return payload?.needsSetup === true;
}

async function main() {
    console.log(`\n目标：${BASE_URL}\n`);
    const chromium = await loadChromium();
    if (!chromium) return;

    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
    });

    let upstream = null;
    try {
        // 假上游：第【4】步会把它作为第二个渠道发布出去，第【7】步用它验证 Key 真的注入到了上游。
        // 线上模式跳过（见 LIVE_MODE 的说明）。
        if (!LIVE_MODE) upstream = await startUpstream();

        const context = await browser.newContext({ baseURL: BASE_URL });
        const page = await context.newPage();
        // 未捕获的页面异常先收集起来，流程跑完再断言——中途 record(false) 会把失败数搅乱。
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        // ---------------------------------------------------------------
        console.log("【1】未登录时被门禁挡住，并进入首次初始化");
        // ---------------------------------------------------------------
        const needsSetup = await looksUninitialized();
        if (!needsSetup) {
            console.log("  ⚠️  数据库不是空的（用户已存在），请先清库后重跑。");
            return;
        }

        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("button[type=submit]", { timeout: 30000 });
        record("出现登录/初始化页（应用没被渲染）", true);
        record("提示为首次初始化", await page.getByText("首次初始化").isVisible().catch(() => false));
        record("页面标题是应用名", (await page.title()).includes("无限画布"), await page.title());

        // ---------------------------------------------------------------
        console.log("\n【2】创建首位管理员");
        // ---------------------------------------------------------------
        await page.locator("#username").fill(ADMIN.username);
        await page.locator("#password").fill(ADMIN.password);
        await page.locator("#confirm").fill(ADMIN.password);
        await page.locator("button[type=submit]").click();
        await page.waitForSelector("header", { timeout: 30000 });
        record("提交后进入应用（顶部导航出现）", await page.locator("header").isVisible());
        const me = await page.evaluate(() => fetch("/api/auth/me").then((response) => response.json()));
        record("服务端确认身份是 admin", me?.user?.role === "admin", JSON.stringify(me?.user));

        // 反向断言：把"配置"收紧成管理员专属时，最容易犯的错是顺手把管理员也一起锁掉。
        record("管理员顶栏能看到配置入口", (await page.locator('button[title="配置"]').count()) > 0);
        await page.goto("/config", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        record("管理员能直接打开 /config（没有被守卫弹走）", new URL(page.url()).pathname === "/config", page.url());
        record("管理员看到的是真实的配置界面", (await page.getByText("配置与用户偏好").count()) > 0);

        // ---------------------------------------------------------------
        console.log("\n【3】通过界面新增一个普通用户");
        // ---------------------------------------------------------------
        await page.goto("/admin/members", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("table", { timeout: 30000 });
        // 等**具体那一行**，而不是等 table 元素。表格壳先渲染、数据靠异步请求后到，
        // 本地回环只要几毫秒所以看不出问题，线上跨洋 + D1 查询会慢出竞态——
        // 只等 table 就会在数据到位之前判失败（这个坑是线上跑的时候才暴露的）。
        const adminRowVisible = await page
            .locator(`text=${ADMIN.username}`)
            .first()
            .waitFor({ state: "visible", timeout: 20000 })
            .then(() => true)
            .catch(() => false);
        record("成员表里能看到刚创建的管理员", adminRowVisible);

        await page.getByRole("button", { name: "新增成员" }).click();
        await page.waitForSelector(".ant-modal input#username", { timeout: 15000 });
        await page.locator(".ant-modal input#username").fill(MEMBER.username);
        await page.locator(".ant-modal input#password").fill(MEMBER.password);
        await page.locator(".ant-modal input#confirm").fill(MEMBER.password);
        await page.locator(".ant-modal .ant-modal-footer button.ant-btn-primary").click();
        await page.waitForSelector(`text=${MEMBER.username}`, { timeout: 20000 });
        record("新成员出现在列表里", await page.locator(`text=${MEMBER.username}`).first().isVisible());

        // ---------------------------------------------------------------
        console.log("\n【4】管理员发布共享配置（含真实 Key）");
        // ---------------------------------------------------------------
        // 模拟"管理员在自己浏览器里配好了渠道"：直接写入 persist 用的 localStorage 键，
        // 然后刷新让 zustand 从里面恢复。这样测的仍是真实的读写链路。
        await page.evaluate(
            ({ key, realKey, liveKey, upstreamPort, liveMode }) => {
                const channels = [
                    {
                        id: "ch-e2e",
                        name: "E2E Channel",
                        baseUrl: "https://api.example.com",
                        apiKey: realKey,
                        apiFormat: "openai",
                        models: [{ name: "gpt-image-2", capability: "image" }],
                    },
                ];
                // 本地模式再加一个指向假上游的渠道：第【7】步用它证明真 Key 确实注入到了上游请求里。
                // 线上模式加不了——Worker 在 Cloudflare 边缘执行，够不到这台机器的 127.0.0.1。
                if (!liveMode) {
                    channels.push({
                        id: "ch-live",
                        name: "Live Upstream",
                        baseUrl: `http://127.0.0.1:${upstreamPort}`,
                        apiKey: liveKey,
                        apiFormat: "openai",
                        models: [{ name: "gpt-image-2", capability: "image" }],
                    });
                }
                localStorage.setItem(
                    key,
                    JSON.stringify({
                        state: {
                            config: {
                                channelMode: "local",
                                baseUrl: "https://api.example.com",
                                apiKey: realKey,
                                apiFormat: "openai",
                                channels,
                                model: "ch-e2e::gpt-image-2",
                                imageModel: "ch-e2e::gpt-image-2",
                                videoModel: "",
                                textModel: "",
                                audioModel: "",
                                systemPrompt: "e2e-system-prompt",
                                size: "1:1",
                                count: "1",
                                // 故意写成本地代理地址：普通用户那边应该被强制改成站点自己的 origin。
                                proxyEnabled: false,
                                proxyUrl: "http://127.0.0.1:23210",
                            },
                            webdav: { url: "", username: "", password: "", directory: "infinite-canvas", lastSyncedAt: "" },
                        },
                        version: 0,
                    }),
                );
            },
            { key: CONFIG_STORE_KEY, realKey: REAL_KEY, liveKey: LIVE_KEY, upstreamPort: upstream?.port ?? 0, liveMode: LIVE_MODE },
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });

        await page.getByRole("tab", { name: "共享配置" }).click();
        await page.getByRole("button", { name: "发布当前配置" }).first().click();

        // 发布是一次异步 PUT。这里不去读 antd 的 toast（DOM 类名随版本变，容易假失败），
        // 而是轮询服务端状态——那才是"发布成功"的权威判据。
        let sharedSeenByAdmin = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            sharedSeenByAdmin = await page.evaluate(() =>
                fetch("/api/config", { cache: "no-store" }).then((response) => response.json().catch(() => null)),
            );
            if (sharedSeenByAdmin?.config) break;
            await page.waitForTimeout(500);
        }
        record("发布后服务端已存下共享配置", Boolean(sharedSeenByAdmin?.config), sharedSeenByAdmin ? "" : "等待 10s 仍未写入");
        record("服务端记录的渠道 apiKey 是占位符（带渠道 id）", sharedSeenByAdmin?.config?.channels?.[0]?.apiKey === "via-proxy:ch-e2e", String(sharedSeenByAdmin?.config?.channels?.[0]?.apiKey));
        record("服务端保留的渠道数与发布的一致", sharedSeenByAdmin?.config?.channels?.length === (LIVE_MODE ? 1 : 2), String(sharedSeenByAdmin?.config?.channels?.length));
        record("服务端响应里没有真实 Key", !JSON.stringify(sharedSeenByAdmin ?? {}).includes(REAL_KEY));
        record("面板显示了最后发布时间", await page.getByText(/最后发布时间/).isVisible().catch(() => false));

        // ---------------------------------------------------------------
        console.log("\n【4b】管理员改配置 → 自动同步（全程不点任何发布按钮）");
        // ---------------------------------------------------------------
        // 这一段针对的是一次真实故障：老版本要求管理员在配置界面改完后，
        // **再去成员管理页点一次「发布当前配置」**。那一步没人会记得，
        // 结果是服务端 app_config 一直是空的，成员只能看到出厂默认配置。
        // 现在本地一改就自动 PUT，所以这里刻意一次都不碰发布按钮。
        await page.goto("/config", { waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "偏好设置" }).click();
        await page.getByPlaceholder(SYSTEM_PROMPT_PLACEHOLDER).fill(AUTO_SYNC_PROMPT);

        // 防抖窗口 1.2s，留足余量后再轮询服务端——服务端存到什么才是"同步成功"的权威判据。
        let autoSynced = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            autoSynced = await page.evaluate(() => fetch("/api/config", { cache: "no-store" }).then((response) => response.json().catch(() => null)));
            if (autoSynced?.config?.systemPrompt === AUTO_SYNC_PROMPT) break;
            await page.waitForTimeout(500);
        }
        record("管理员改配置后自动同步到服务端（没点发布按钮）", autoSynced?.config?.systemPrompt === AUTO_SYNC_PROMPT, String(autoSynced?.config?.systemPrompt));
        record("自动同步的响应里依然没有真实 Key", !JSON.stringify(autoSynced ?? {}).includes(REAL_KEY));
        record("配置界面显示了同步状态", await page.getByText(/已同步给成员|正在同步|有改动待同步/).first().isVisible().catch(() => false));

        // ---------------------------------------------------------------
        console.log("\n【4c】护栏：本机没有可用密钥时，自动同步拒绝下发");
        // ---------------------------------------------------------------
        // 模拟"管理员换了台干净设备"：本机所有渠道的 apiKey 都是空的。
        // 此时照常 PUT 的话，服务端会删掉 channel_secrets 里的全部真实 Key，
        // 把所有人的配置一起打掉——所以要拦住，并且界面上说明原因。
        const adminConfigSnapshot = await page.evaluate((key) => localStorage.getItem(key), CONFIG_STORE_KEY);
        await page.evaluate((key) => {
            const raw = JSON.parse(localStorage.getItem(key) || "{}");
            const channels = raw?.state?.config?.channels;
            if (Array.isArray(channels)) raw.state.config.channels = channels.map((channel) => ({ ...channel, apiKey: "" }));
            localStorage.setItem(key, JSON.stringify(raw));
        }, CONFIG_STORE_KEY);
        // 整页重载让 store 从改过的 localStorage 恢复，并让自动同步重新记基线。
        await page.goto("/config", { waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "偏好设置" }).click();
        await page.getByPlaceholder(SYSTEM_PROMPT_PLACEHOLDER).fill("e2e-must-not-be-published");
        await page.waitForTimeout(3000);

        const afterGuard = await page.evaluate(() => fetch("/api/config", { cache: "no-store" }).then((response) => response.json().catch(() => null)));
        record("本机无密钥时改动没有下发（服务端仍是上一次同步的值）", afterGuard?.config?.systemPrompt === AUTO_SYNC_PROMPT, String(afterGuard?.config?.systemPrompt));
        record("本机无密钥时服务端渠道没被清空", afterGuard?.config?.channels?.length === (LIVE_MODE ? 1 : 2), String(afterGuard?.config?.channels?.length));
        record("界面说明了未下发的原因", await page.getByText("未下发给成员").first().isVisible().catch(() => false));
        // 恢复现场：后面的断言依赖"管理员本机存着真实 Key"（例如退出登录不清配置）。
        await page.evaluate(({ key, snapshot }) => localStorage.setItem(key, snapshot), { key: CONFIG_STORE_KEY, snapshot: adminConfigSnapshot });

        // 留一份管理员的会话 Cookie 给【6b】：那时浏览器里已经是成员身份了，
        // 而【6b】需要"管理员在别处改了配置"这个动作。会话是无状态签名 Cookie、
        // 没有 sessions 表，所以在这里留一份不会踢掉浏览器正在用的那个。
        const adminSession = (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);

        // ---------------------------------------------------------------
        console.log("\n【5】退出登录 → 普通用户登录 → 共享配置生效");
        // ---------------------------------------------------------------
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        // 桌面导航与画布顶栏共用同一个组件，按钮可能出现两次，取第一个即可。
        await page.locator('button[title="退出登录"]').first().click();
        await page.locator(".ant-modal-confirm .ant-btn-primary").last().click();
        await page.waitForSelector("button[type=submit]", { timeout: 20000 });
        record("退出后回到登录页", true);
        // 管理员的本地配置里还有真实 Key——顺手确认"退出"没有把它清掉（它不是凭据存储）。
        const adminKeyAfterLogout = await page.evaluate(
            ({ key, realKey }) => (localStorage.getItem(key) || "").includes(realKey),
            { key: CONFIG_STORE_KEY, realKey: REAL_KEY },
        );
        record("退出登录不清理本地配置（真实 Key 仍在管理员这台机器上）", adminKeyAfterLogout);

        await page.locator("#username").fill(MEMBER.username);
        await page.locator("#password").fill(MEMBER.password);
        await page.locator("button[type=submit]").click();
        await page.waitForSelector("header", { timeout: 30000 });
        record("普通用户登录后进入应用", await page.locator("header").isVisible());

        const memberIdentity = await page.evaluate(() => fetch("/api/auth/me").then((response) => response.json()));
        record("服务端确认身份是 member", memberIdentity?.user?.role === "member", JSON.stringify(memberIdentity?.user));

        const memberStorage = await page.evaluate((key) => localStorage.getItem(key) || "", CONFIG_STORE_KEY);
        const memberConfig = JSON.parse(memberStorage).state?.config ?? {};
        // 断言用的是【4b】自动同步写进去的值，所以这一条同时证明了两件事：
        // 普通用户拿到的确实是服务端的配置，而且是**最新版本**（不是【4】手动发布的那份）。
        record("普通用户的本地配置已换成共享配置（systemPrompt）", memberConfig.systemPrompt === AUTO_SYNC_PROMPT, String(memberConfig.systemPrompt));
        record("渠道 baseUrl 保持真实上游地址", memberConfig.channels?.[0]?.baseUrl === "https://api.example.com", String(memberConfig.channels?.[0]?.baseUrl));
        record("渠道 apiKey 是占位符（带渠道 id，代理据此定位密钥）", memberConfig.channels?.[0]?.apiKey === "via-proxy:ch-e2e", String(memberConfig.channels?.[0]?.apiKey));
        record("代理被强制开启", memberConfig.proxyEnabled === true, String(memberConfig.proxyEnabled));
        record("proxyUrl 被强制指向本站（而不是管理员本机的 127.0.0.1:23210）", memberConfig.proxyUrl === BASE_URL, String(memberConfig.proxyUrl));
        record("模型选项已重建", Array.isArray(memberConfig.models) && memberConfig.models.includes("ch-e2e::gpt-image-2"), JSON.stringify(memberConfig.models));
        // 自检：下面几条"找不到真实 Key"的判据都是把整个 localStorage 序列化成字符串再搜。
        // 先确认这个序列化确实读到了东西——万一它读空（比如浏览器哪天把 Storage 的命名属性
        // 变成不可枚举），那些断言就会永远成立，安全测试变成纸糊的。
        // 已实测：Chrome 里 `JSON.stringify(localStorage)` 会输出全部键值，不是 "{}"。
        const memberStorageDump = await page.evaluate(() => JSON.stringify(localStorage));
        record(
            "自检：localStorage 扫描确实读到了内容（后面几条 Key 断言的前提）",
            memberStorageDump.includes(CONFIG_STORE_KEY) && memberStorageDump.includes(AUTO_SYNC_PROMPT),
            `序列化长度 ${memberStorageDump.length}`,
        );
        record(
            "普通用户的整个 localStorage 里都找不到真实 Key",
            !memberStorageDump.includes(REAL_KEY),
        );
        if (!LIVE_MODE) {
            record(
                "两个渠道的真 Key 都没有落进普通用户浏览器",
                !memberStorageDump.includes(LIVE_KEY),
            );
        }
        record(
            "普通用户的 localStorage 里也没有 channel_secrets 之类的东西",
            !memberStorageDump.toLowerCase().includes("secret"),
        );

        // ---------------------------------------------------------------
        console.log("\n【6】普通用户被挡在管理页与配置页之外");
        // ---------------------------------------------------------------
        await page.goto("/admin/members", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        record("普通用户访问成员管理页被弹回首页", new URL(page.url()).pathname === "/", page.url());
        record("普通用户看不到成员表", (await page.locator("table").count()) === 0);

        // 配置（"配置与用户偏好"）属于高级设置：入口隐藏，而且直接敲 URL 也进不去。
        // 旧版本这两条都是漏的——普通用户既看得见顶栏齿轮，也能打开 /config 改渠道和 API Key。
        record("普通用户顶栏没有配置入口", (await page.locator('button[title="配置"]').count()) === 0);
        await page.goto("/config", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        record("普通用户访问 /config 被弹回首页", new URL(page.url()).pathname === "/", page.url());
        record("普通用户看不到配置界面", (await page.getByText("配置与用户偏好").count()) === 0);

        // `?baseUrl=&apiKey=` 是"把渠道凭据带进本机配置"的用法（扫码 / 分享链接那条路）。
        // 对普通用户既没有意义（他的配置由管理员下发、真 Key 只在服务端），又会让本地配置
        // 短暂偏离共享配置，所以整段被跳过：只擦地址栏，不写配置、不弹配置框。
        await page.goto("/?baseUrl=https://injected.example.com&apiKey=sk-injected-must-be-ignored", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        record("普通用户带凭据参数访问时地址栏被擦干净", !page.url().includes("apiKey"), page.url());
        record("普通用户不会被 URL 参数写进渠道", !(await page.evaluate(() => JSON.stringify(localStorage))).includes("injected.example.com"));
        record("普通用户不会因此被弹出配置界面", (await page.getByText("配置由管理员统一管理").count()) === 0);

        // ---------------------------------------------------------------
        console.log("\n【6b】管理员更新配置 → 成员不刷新页面也能自动拿到");
        // ---------------------------------------------------------------
        // 这是"自动同步"的另一半。只做管理员侧的推送的话，成员得手动刷新才看得到，
        // 现象上仍然是"我改了但他们没变"。成员侧因此加了定时 + 页面重新可见时的拉取。
        // 这里不等那 60s 轮询，直接派发 visibilitychange 走"页面重新可见"那条路径。
        record("拿到了管理员的会话 Cookie（用来模拟另一个人在改配置）", Boolean(adminSession), adminSession ? "" : "没拿到 ic_session");
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });

        const readMemberPrompt = (key) => page.evaluate((storeKey) => JSON.parse(localStorage.getItem(storeKey) || "{}")?.state?.config?.systemPrompt ?? null, key);
        const beforeRefresh = await readMemberPrompt(CONFIG_STORE_KEY);
        record("成员此刻用的还是上一版配置", beforeRefresh === AUTO_SYNC_PROMPT, String(beforeRefresh));

        // 用管理员的会话直接在 Worker 上改配置，等价于"管理员在另一台电脑上改完并同步了"。
        const adminCookieHeader = `${SESSION_COOKIE}=${adminSession?.value ?? ""}`;
        const adminConfigPayload = await fetch(`${BASE_URL}/api/config`, { headers: { cookie: adminCookieHeader } }).then((response) => response.json());
        const writeResponse = await fetch(`${BASE_URL}/api/config`, {
            method: "PUT",
            headers: { cookie: adminCookieHeader, "content-type": "application/json" },
            body: JSON.stringify({ config: { ...(adminConfigPayload.config || {}), systemPrompt: MEMBER_REFRESH_PROMPT } }),
        });
        record("模拟的管理员改写成功", writeResponse.ok, `HTTP ${writeResponse.status}`);

        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        let memberRefreshed = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            memberRefreshed = await readMemberPrompt(CONFIG_STORE_KEY);
            if (memberRefreshed === MEMBER_REFRESH_PROMPT) break;
            await page.waitForTimeout(500);
        }
        record("成员页面不刷新就自动应用了管理员的新配置", memberRefreshed === MEMBER_REFRESH_PROMPT, String(memberRefreshed));

        // ---------------------------------------------------------------
        // 【7】只在本地模式跑：它依赖"本机假上游"，而线上 Worker 够不到这台机器（见 LIVE_MODE 说明）。
        // ---------------------------------------------------------------
        if (!LIVE_MODE) {
            console.log("\n【7】普通用户在浏览器里发请求 → 经代理注入真 Key → 上游收到真 Key");
            // 这一段是"普通用户能用却拿不到 Key"的最终证明：请求从**真实浏览器**发出，
            // 带的是本地配置里那个占位符，而断言看的是**上游实际收到了什么**。
            await page.goto("/", { waitUntil: "domcontentloaded" });
            await page.waitForSelector("header", { timeout: 30000 });

            const liveChannel = memberConfig.channels?.find((channel) => channel.id === "ch-live");
            record("普通用户的配置里有指向真实上游的渠道", Boolean(liveChannel), JSON.stringify(liveChannel?.baseUrl));
            record("该渠道的 apiKey 是带 id 的占位符", liveChannel?.apiKey === "via-proxy:ch-live", String(liveChannel?.apiKey));

            // 用前端真实拼 URL 的规则（`${proxyUrl}/${完整目标URL}`）构造请求，
            // 带着本地配置里的占位符发出去——和画布真实发图时走的是同一条路。
            const proxied = await page.evaluate(
                async ({ proxyUrl, target, placeholder }) => {
                    const response = await fetch(`${proxyUrl}/${target}`, { headers: { authorization: `Bearer ${placeholder}` } });
                    return { status: response.status, payload: await response.json().catch(() => null) };
                },
                { proxyUrl: memberConfig.proxyUrl, target: `${liveChannel.baseUrl}/v1/echo`, placeholder: liveChannel.apiKey },
            );

            record("浏览器发出的请求经代理返回 200", proxied.status === 200, String(proxied.status));
            record("上游收到的是真实 Key，而不是普通用户手里的占位符", proxied.payload?.authorization === `Bearer ${LIVE_KEY}`, String(proxied.payload?.authorization));
            record("上游没有收到站内会话 Cookie", !proxied.payload?.cookie, String(proxied.payload?.cookie));
            record(
                "这一趟下来，普通用户浏览器里依然没有真 Key",
                !(await page.evaluate(() => JSON.stringify(localStorage))).includes(LIVE_KEY),
            );
        }

        record("整个流程中没有出现未捕获的页面异常", pageErrors.length === 0, pageErrors.join(" | "));
    } finally {
        if (upstream) await upstream.close();
        await browser.close();
    }

    console.log(`\n${"-".repeat(56)}`);
    const passed = results.length - failures;
    console.log(`结果：${passed}/${results.length} 通过，${failures} 失败`);
    if (failures > 0) {
        console.log("\n失败项：");
        for (const item of results.filter((entry) => !entry.passed)) console.log(`  - ${item.name}${item.detail ? `（${item.detail}）` : ""}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("\n浏览器测试异常终止：", error);
    process.exitCode = 1;
});
