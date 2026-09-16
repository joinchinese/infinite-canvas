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
import { pathToFileURL } from "node:url";

const BASE_URL = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN = { username: "e2e-admin", password: "admin-Passw0rd!" };
const MEMBER = { username: "e2e-member", password: "member-Passw0rd!" };
const REAL_KEY = "sk-e2e-real-key-must-not-reach-member";
const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

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

    try {
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

        // ---------------------------------------------------------------
        console.log("\n【3】通过界面新增一个普通用户");
        // ---------------------------------------------------------------
        await page.goto("/admin/members", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("table", { timeout: 30000 });
        record("成员表里能看到刚创建的管理员", await page.locator(`text=${ADMIN.username}`).first().isVisible());

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
            ({ key, realKey }) => {
                localStorage.setItem(
                    key,
                    JSON.stringify({
                        state: {
                            config: {
                                channelMode: "local",
                                baseUrl: "https://api.example.com",
                                apiKey: realKey,
                                apiFormat: "openai",
                                channels: [
                                    {
                                        id: "ch-e2e",
                                        name: "E2E Channel",
                                        baseUrl: "https://api.example.com",
                                        apiKey: realKey,
                                        apiFormat: "openai",
                                        models: [{ name: "gpt-image-2", capability: "image" }],
                                    },
                                ],
                                model: "ch-e2e::gpt-image-2",
                                imageModel: "ch-e2e::gpt-image-2",
                                videoModel: "",
                                textModel: "",
                                audioModel: "",
                                systemPrompt: "e2e-system-prompt",
                                size: "1:1",
                                count: "1",
                                proxyEnabled: false,
                                proxyUrl: "http://127.0.0.1:23210",
                            },
                            webdav: { url: "", username: "", password: "", directory: "infinite-canvas", lastSyncedAt: "" },
                        },
                        version: 0,
                    }),
                );
            },
            { key: CONFIG_STORE_KEY, realKey: REAL_KEY },
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
        record("服务端记录的渠道 apiKey 是占位符", sharedSeenByAdmin?.config?.channels?.[0]?.apiKey === "via-proxy");
        record("服务端保留的渠道数与发布的一致", sharedSeenByAdmin?.config?.channels?.length === 1, String(sharedSeenByAdmin?.config?.channels?.length));
        record("服务端响应里没有真实 Key", !JSON.stringify(sharedSeenByAdmin ?? {}).includes(REAL_KEY));
        record("面板显示了最后发布时间", await page.getByText(/最后发布时间/).isVisible().catch(() => false));

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
        record("普通用户的本地配置已换成共享配置（systemPrompt）", memberConfig.systemPrompt === "e2e-system-prompt", String(memberConfig.systemPrompt));
        record("渠道 baseUrl 保持真实上游地址", memberConfig.channels?.[0]?.baseUrl === "https://api.example.com", String(memberConfig.channels?.[0]?.baseUrl));
        record("渠道 apiKey 是占位符", memberConfig.channels?.[0]?.apiKey === "via-proxy", String(memberConfig.channels?.[0]?.apiKey));
        record("代理被强制开启", memberConfig.proxyEnabled === true, String(memberConfig.proxyEnabled));
        record("proxyUrl 被强制指向本站（而不是管理员本机的 127.0.0.1:23210）", memberConfig.proxyUrl === BASE_URL, String(memberConfig.proxyUrl));
        record("模型选项已重建", Array.isArray(memberConfig.models) && memberConfig.models.includes("ch-e2e::gpt-image-2"), JSON.stringify(memberConfig.models));
        record(
            "普通用户的整个 localStorage 里都找不到真实 Key",
            !(await page.evaluate(() => JSON.stringify(localStorage))).includes(REAL_KEY),
        );
        record(
            "普通用户的 localStorage 里也没有 channel_secrets 之类的东西",
            !(await page.evaluate(() => JSON.stringify(localStorage))).toLowerCase().includes("secret"),
        );

        // ---------------------------------------------------------------
        console.log("\n【6】普通用户访问成员管理页被弹回首页");
        // ---------------------------------------------------------------
        await page.goto("/admin/members", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("header", { timeout: 30000 });
        record("普通用户被重定向回首页", new URL(page.url()).pathname === "/", page.url());
        record("普通用户看不到成员表", (await page.locator("table").count()) === 0);

        record("整个流程中没有出现未捕获的页面异常", pageErrors.length === 0, pageErrors.join(" | "));
    } finally {
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
