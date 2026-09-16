#!/usr/bin/env node
/**
 * 门禁 API 冒烟测试。
 *
 * 用法（先起本地服务）：
 *   npx wrangler dev --port 8787
 *   node worker/smoke-test.mjs http://127.0.0.1:8787
 *
 * 这个脚本同时扮演"前端"：它用与 `web/src/services/api/auth.ts` 完全相同的 PBKDF2 参数
 * 派生 clientVerifier。所以它一旦通过，就证明前后端的密码派生规则是对齐的。
 *
 * 注意：它会写入真实的 D1（本地是 .wrangler/state 下的 SQLite）。
 * 请对空库运行，否则 setup 那一步会因为"已初始化"而失败。
 */

import { readFileSync } from "node:fs";

const BASE_URL = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");

/** 必须与 worker/password.ts 的 PASSWORD_KDF 及 web/src/services/api/auth.ts 的 PASSWORD_KDF 一致。 */
const KDF = { algorithm: "PBKDF2", hash: "SHA-256", iterations: 150000, lengthBits: 256, saltPrefix: "infinite-canvas:v1:" };

const results = [];
let failures = 0;

function record(name, passed, detail = "") {
    results.push({ name, passed, detail });
    if (!passed) failures += 1;
    const mark = passed ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function expectStatus(name, response, expected) {
    record(name, response.status === expected, `期望 ${expected}，实际 ${response.status}`);
}

// ---------------------------------------------------------------------------
// 一个极简的带 Cookie 的 HTTP 客户端
// ---------------------------------------------------------------------------

class Client {
    constructor(label) {
        this.label = label;
        this.cookie = "";
    }

    async request(method, path, body) {
        const headers = {};
        if (body !== undefined) headers["content-type"] = "application/json";
        if (this.cookie) headers["cookie"] = this.cookie;
        const response = await fetch(`${BASE_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "manual",
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) {
            const value = setCookie.split(";")[0];
            this.cookie = value.endsWith("=") ? "" : value;
        }
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        return { status: response.status, payload, headers: response.headers };
    }

    get = (path) => this.request("GET", path);
    post = (path, body) => this.request("POST", path, body);
    patch = (path, body) => this.request("PATCH", path, body);
    del = (path) => this.request("DELETE", path);
}

// ---------------------------------------------------------------------------
// 与前端一致的密码派生
// ---------------------------------------------------------------------------

async function deriveClientVerifier(username, password) {
    const encoder = new TextEncoder();
    const salt = encoder.encode(`${KDF.saltPrefix}${username.trim().toLowerCase()}`);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), KDF.algorithm, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: KDF.algorithm, salt, iterations: KDF.iterations, hash: KDF.hash }, key, KDF.lengthBits);
    return Buffer.from(new Uint8Array(bits)).toString("base64url");
}

const ADMIN = { username: "gate-admin", password: "admin-Passw0rd!" };
const MEMBER = { username: "gate-member", password: "member-Passw0rd!" };
const NEW_PASSWORD = "member-Rotated#2";

// ---------------------------------------------------------------------------
// KDF 常量一致性守卫
// ---------------------------------------------------------------------------

/**
 * 密码派生参数散落在三处（Worker、前端、本脚本），任何一侧被单独改动都会导致
 * **所有人都登录失败**——而且失败现象是"密码正确却提示错误"，很难一眼看出原因。
 * 所以这里把两个源文件当文本读出来做字面量比对，把这类改动变成一条会响的测试。
 */
function parseKdf(sourcePath) {
    const text = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
    const pick = (pattern) => {
        const matched = pattern.exec(text);
        return matched ? matched[1] : undefined;
    };
    return {
        algorithm: pick(/algorithm:\s*"([^"]+)"/),
        hash: pick(/hash:\s*"([^"]+)"/),
        iterations: Number(pick(/iterations:\s*(\d+)/)),
        lengthBits: Number(pick(/lengthBits:\s*(\d+)/)),
        saltPrefix: pick(/saltPrefix:\s*"([^"]+)"/),
    };
}

function checkKdfParity() {
    console.log("\n【0】密码派生参数一致性（三处必须逐字相同）");
    const workerSide = parseKdf("./password.ts");
    const browserSide = parseKdf("../web/src/services/api/auth.ts");

    for (const key of ["algorithm", "hash", "iterations", "lengthBits", "saltPrefix"]) {
        record(`worker/password.ts 的 ${key} 与前端一致`, String(workerSide[key]) === String(browserSide[key]), `worker=${workerSide[key]} web=${browserSide[key]}`);
        record(`本脚本的 ${key} 与 worker 一致`, String(workerSide[key]) === String(KDF[key]), `worker=${workerSide[key]} script=${KDF[key]}`);
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    console.log(`\n目标：${BASE_URL}\n`);

    checkKdfParity();

    const adminVerifier = await deriveClientVerifier(ADMIN.username, ADMIN.password);
    const memberVerifier = await deriveClientVerifier(MEMBER.username, MEMBER.password);
    record("PBKDF2 派生输出是 43 字符的 base64url", /^[A-Za-z0-9_-]{43}$/.test(adminVerifier), adminVerifier.slice(0, 8) + "…");

    const anon = new Client("匿名");
    const admin = new Client("管理员");

    console.log("\n【1】健康检查与初始化状态");
    expectStatus("GET /api/health 返回 200", await anon.get("/api/health"), 200);
    const beforeSetup = await anon.get("/api/auth/me");
    expectStatus("未初始化时 GET /api/auth/me 返回 200（不是 401）", beforeSetup, 200);
    record("未登录返回 authenticated=false", beforeSetup.payload?.authenticated === false);
    record("未初始化时 needsSetup=true", beforeSetup.payload?.needsSetup === true);

    console.log("\n【2】首位管理员引导");
    const badSetup = await anon.post("/api/auth/setup", { username: "x", clientVerifier: adminVerifier });
    expectStatus("非法用户名被拒（400）", badSetup, 400);
    const setup = await anon.post("/api/auth/setup", { username: ADMIN.username, clientVerifier: adminVerifier });
    expectStatus("POST /api/auth/setup 返回 201", setup, 201);
    record("setup 返回 role=admin", setup.payload?.user?.role === "admin");
    record("setup 直接下发会话 Cookie", Boolean(anon.cookie));
    admin.cookie = anon.cookie;

    const secondSetup = new Client("二次初始化").post("/api/auth/setup", { username: "other", clientVerifier: adminVerifier });
    expectStatus("重复初始化被拒（409）", await secondSetup, 409);

    console.log("\n【3】会话");
    const me = await admin.get("/api/auth/me");
    record("已登录时 authenticated=true", me.payload?.authenticated === true);
    record("角色正确带回", me.payload?.user?.role === "admin", me.payload?.user?.role);
    record("响应里不含 password_hash", !JSON.stringify(me.payload).includes("password_hash"));

    console.log("\n【4】登录");
    const wrongPassword = await new Client("错误密码").post("/api/auth/login", {
        username: ADMIN.username,
        clientVerifier: await deriveClientVerifier(ADMIN.username, "wrong-password"),
    });
    expectStatus("错误密码返回 401", wrongPassword, 401);
    const unknownUser = await new Client("不存在用户").post("/api/auth/login", {
        username: "no-such-user",
        clientVerifier: adminVerifier,
    });
    expectStatus("不存在的用户返回 401（且与错误密码同一错误码）", unknownUser, 401);
    record("两者错误码相同，不泄漏账号是否存在", unknownUser.payload?.error === wrongPassword.payload?.error);

    console.log("\n【5】成员管理（管理员）");
    const emptyList = await admin.get("/api/admin/members");
    expectStatus("GET /api/admin/members 返回 200", emptyList, 200);
    record("初始只有 1 名管理员", emptyList.payload?.members?.length === 1, String(emptyList.payload?.members?.length));

    const created = await admin.post("/api/admin/members", {
        username: MEMBER.username,
        displayName: "普通成员",
        role: "member",
        clientVerifier: memberVerifier,
    });
    expectStatus("POST 创建成员返回 201", created, 201);
    record("成员角色为 member", created.payload?.member?.role === "member");
    record("成员状态为 active", created.payload?.member?.status === "active");
    const memberId = created.payload?.member?.id;
    record("返回了成员 id", typeof memberId === "string" && memberId.length > 0);

    const duplicate = await admin.post("/api/admin/members", {
        username: MEMBER.username.toUpperCase(),
        clientVerifier: memberVerifier,
    });
    expectStatus("同名（含大小写变体）重复创建返回 409", duplicate, 409);

    const list = await admin.get("/api/admin/members");
    record("列表变为 2 人", list.payload?.members?.length === 2, String(list.payload?.members?.length));
    record("列表不含 password_hash", !JSON.stringify(list.payload).includes("password_hash"));

    console.log("\n【6】普通用户权限边界");
    const member = new Client("普通成员");
    const memberLogin = await member.post("/api/auth/login", { username: MEMBER.username, clientVerifier: memberVerifier });
    expectStatus("成员登录返回 200", memberLogin, 200);
    record("成员角色为 member", memberLogin.payload?.user?.role === "member");
    const memberList = await member.get("/api/admin/members");
    expectStatus("成员访问成员列表返回 403", memberList, 403);
    const memberCreate = await member.post("/api/admin/members", { username: "hacker", clientVerifier: memberVerifier });
    expectStatus("成员尝试创建账号返回 403", memberCreate, 403);
    const memberDelete = await member.del(`/api/admin/members/${memberId}`);
    expectStatus("成员尝试删除账号返回 403", memberDelete, 403);
    const memberPatch = await member.patch(`/api/admin/members/${memberId}`, { role: "admin" });
    expectStatus("成员尝试自我提权返回 403", memberPatch, 403);
    expectStatus("未登录访问成员列表返回 401", await new Client("未登录").get("/api/admin/members"), 401);

    console.log("\n【7】防自锁规则");
    const adminMe = await admin.get("/api/auth/me");
    const adminId = adminMe.payload?.user?.id;
    expectStatus("管理员删除自己返回 409", await admin.del(`/api/admin/members/${adminId}`), 409);
    expectStatus("唯一管理员降级自己返回 409", await admin.patch(`/api/admin/members/${adminId}`, { role: "member" }), 409);
    expectStatus("唯一管理员停用自己返回 409", await admin.patch(`/api/admin/members/${adminId}`, { status: "disabled" }), 409);
    const stillAdmin = await admin.get("/api/auth/me");
    record("被拒后管理员身份与会话保持完好", stillAdmin.payload?.user?.role === "admin");

    console.log("\n【8】存在第二名管理员时可以移交并自行退位");
    const handover = await admin.post("/api/admin/members", {
        username: "gate-second-admin",
        role: "admin",
        clientVerifier: await deriveClientVerifier("gate-second-admin", "second-Passw0rd!"),
    });
    expectStatus("创建第二名管理员返回 201", handover, 201);
    const secondAdminId = handover.payload?.member?.id;
    const stepDown = await admin.patch(`/api/admin/members/${adminId}`, { role: "member" });
    record("有第二名管理员时降级自己被允许", stepDown.payload?.member?.role === "member", JSON.stringify(stepDown.payload));
    const afterStepDown = await admin.get("/api/auth/me");
    record("降级后自身会话被立即吊销", afterStepDown.payload?.authenticated === false);

    // 恢复：用第二名管理员把自己改回 admin
    const secondAdmin = new Client("第二管理员");
    const secondLogin = await secondAdmin.post("/api/auth/login", {
        username: "gate-second-admin",
        clientVerifier: await deriveClientVerifier("gate-second-admin", "second-Passw0rd!"),
    });
    expectStatus("第二管理员登录成功", secondLogin, 200);
    expectStatus("第二管理员把原管理员改回 admin", await secondAdmin.patch(`/api/admin/members/${adminId}`, { role: "admin" }), 200);
    const adminRelogin = await admin.post("/api/auth/login", { username: ADMIN.username, clientVerifier: adminVerifier });
    expectStatus("原管理员重新登录成功", adminRelogin, 200);
    expectStatus("清理第二名管理员", await admin.del(`/api/admin/members/${secondAdminId}`), 200);

    console.log("\n【9】角色变更会即时吊销会话");
    const promote = await admin.patch(`/api/admin/members/${memberId}`, { role: "admin" });
    record("提升为管理员成功", promote.payload?.member?.role === "admin");
    const memberAfterPromote = await member.get("/api/auth/me");
    record("被改角色的成员旧会话立即失效", memberAfterPromote.payload?.authenticated === false, JSON.stringify(memberAfterPromote.payload));
    const demote = await admin.patch(`/api/admin/members/${memberId}`, { role: "member" });
    record("降级回 member 成功", demote.payload?.member?.role === "member");

    console.log("\n【10】重置密码");
    const rotatedVerifier = await deriveClientVerifier(MEMBER.username, NEW_PASSWORD);
    const reLogin = await member.post("/api/auth/login", { username: MEMBER.username, clientVerifier: memberVerifier });
    expectStatus("成员用原密码重新登录成功", reLogin, 200);
    expectStatus("重置密码返回 200", await admin.post(`/api/admin/members/${memberId}/password`, { clientVerifier: rotatedVerifier }), 200);
    const staleSession = await member.get("/api/auth/me");
    record("重置后旧会话立即失效", staleSession.payload?.authenticated === false);
    const oldPassword = await new Client("旧密码").post("/api/auth/login", { username: MEMBER.username, clientVerifier: memberVerifier });
    expectStatus("旧密码登录返回 401", oldPassword, 401);
    const newPassword = await new Client("新密码").post("/api/auth/login", { username: MEMBER.username, clientVerifier: rotatedVerifier });
    expectStatus("新密码登录返回 200", newPassword, 200);

    console.log("\n【11】停用与删除");
    expectStatus("停用成员返回 200", await admin.patch(`/api/admin/members/${memberId}`, { status: "disabled" }), 200);
    const disabledLogin = await new Client("被停用").post("/api/auth/login", { username: MEMBER.username, clientVerifier: rotatedVerifier });
    expectStatus("被停用后无法登录（403）", disabledLogin, 403);
    expectStatus("重新启用返回 200", await admin.patch(`/api/admin/members/${memberId}`, { status: "active" }), 200);
    expectStatus("删除成员返回 200", await admin.del(`/api/admin/members/${memberId}`), 200);
    expectStatus("删除不存在的成员返回 404", await admin.del(`/api/admin/members/${memberId}`), 404);
    expectStatus("成员被删除后无法登录（401）", await new Client("已删除").post("/api/auth/login", { username: MEMBER.username, clientVerifier: rotatedVerifier }), 401);

    console.log("\n【12】协议层");
    expectStatus("未知 API 路径返回 404", await admin.get("/api/nope"), 404);
    expectStatus("错误方法返回 405", await admin.get("/api/auth/login"), 405);
    expectStatus("非法 JSON 返回 400", await admin.request("POST", "/api/auth/login", undefined), 400);
    expectStatus("登出返回 200", await admin.post("/api/auth/logout"), 200);
    const afterLogout = await admin.get("/api/admin/members");
    expectStatus("登出后访问受保护资源返回 401", afterLogout, 401);

    console.log("\n【13】SPA 路由行为（静态资源层）");
    const navigateHeaders = { "sec-fetch-mode": "navigate", accept: "text/html" };
    const deepLink = await fetch(`${BASE_URL}/admin/members`, { headers: navigateHeaders, redirect: "manual" });
    record("深层路由的导航请求返回 200（刷新不 404）", deepLink.status === 200, `实际 ${deepLink.status}`);
    record("深层路由返回 HTML", (deepLink.headers.get("content-type") || "").includes("text/html"));
    const deepLinkBody = await deepLink.text();
    record("返回的确实是应用外壳", /<html|<!doctype/i.test(deepLinkBody));
    const rootNav = await fetch(`${BASE_URL}/`, { headers: navigateHeaders, redirect: "manual" });
    record("根路径导航返回 200", rootNav.status === 200, `实际 ${rootNav.status}`);
    const unknownPath = await fetch(`${BASE_URL}/no-such-page`, { headers: { "sec-fetch-mode": "cors" }, redirect: "manual" });
    record("未知路径返回 SPA 外壳而非 404", unknownPath.status === 200, `实际 ${unknownPath.status}`);

    console.log("\n【14】共享配置（管理员发布 / 所有人只读 / 真实 Key 不下发）");
    const REAL_KEY = "sk-live-real-key-do-not-leak-9f3c";
    const SHARED_CONFIG = {
        channelMode: "local",
        baseUrl: "https://api.example.com",
        // 顶层 apiKey 是历史字段，`resolveModelChannel` 在没有任何渠道时仍会回退到它，
        // 所以它同样会被抹掉——下面有一条专门断言这件事。
        apiKey: REAL_KEY,
        apiFormat: "openai",
        channels: [
            {
                id: "ch-1",
                name: "Example",
                baseUrl: "https://api.example.com",
                apiKey: REAL_KEY,
                apiFormat: "openai",
                models: [{ name: "gpt-image-2", capability: "image" }],
            },
        ],
        model: "ch-1::gpt-image-2",
        imageModel: "ch-1::gpt-image-2",
        systemPrompt: "shared system prompt",
        size: "1:1",
        proxyEnabled: true,
        // 管理员本机可能在用本地代理；服务端原样保存，由前端应用时强制改成本站 origin。
        proxyUrl: "http://127.0.0.1:23210",
        count: "1",
    };

    // 这一节自己造账号，不依赖前面被删掉的成员，因此可以独立看懂。
    const configAdmin = new Client("管理员（重新登录）");
    expectStatus("管理员重新登录成功", await configAdmin.post("/api/auth/login", { username: ADMIN.username, clientVerifier: adminVerifier }), 200);

    const beforePublish = await configAdmin.get("/api/config");
    expectStatus("未发布时 GET /api/config 返回 200", beforePublish, 200);
    record("未发布时 config 为 null", beforePublish.payload?.config === null, JSON.stringify(beforePublish.payload));
    expectStatus("未登录读取共享配置返回 401", await new Client("匿名").get("/api/config"), 401);

    const CONFIG_MEMBER = { username: "gate-config-user", password: "config-Passw0rd!" };
    const configMemberVerifier = await deriveClientVerifier(CONFIG_MEMBER.username, CONFIG_MEMBER.password);
    const configMember = new Client("普通用户");
    const configMemberCreated = await configAdmin.post("/api/admin/members", { username: CONFIG_MEMBER.username, role: "member", clientVerifier: configMemberVerifier });
    expectStatus("创建普通用户账号返回 201", configMemberCreated, 201);
    expectStatus("该普通用户登录成功", await configMember.post("/api/auth/login", { username: CONFIG_MEMBER.username, clientVerifier: configMemberVerifier }), 200);

    expectStatus("普通用户发布共享配置返回 403", await configMember.request("PUT", "/api/config", { config: SHARED_CONFIG }), 403);
    expectStatus("未登录发布共享配置返回 401", await new Client("匿名").request("PUT", "/api/config", { config: SHARED_CONFIG }), 401);
    expectStatus("channels 不是数组时返回 400", await configAdmin.request("PUT", "/api/config", { config: { channels: "nope" } }), 400);
    expectStatus("缺少 config 字段时返回 400", await configAdmin.request("PUT", "/api/config", {}), 400);
    expectStatus("删除共享配置的方法不允许（405）", await configAdmin.del("/api/config"), 405);

    const published = await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG });
    expectStatus("管理员发布共享配置返回 200", published, 200);
    record("返回的渠道数与提交一致", published.payload?.channels === 1, String(published.payload?.channels));
    record("所有渠道都有密钥 → missingSecrets 为空", Array.isArray(published.payload?.missingSecrets) && published.payload.missingSecrets.length === 0, JSON.stringify(published.payload?.missingSecrets));

    const sharedForAdmin = await configAdmin.get("/api/config");
    const sharedForMember = await configMember.get("/api/config");
    record("管理员自己也能读到共享配置", Boolean(sharedForAdmin.payload?.config));
    record("普通用户能读到共享配置", Boolean(sharedForMember.payload?.config));
    record("响应里完全不出现真实 Key", !JSON.stringify(sharedForMember.payload).includes(REAL_KEY));
    record("渠道 apiKey 已换成占位符", sharedForMember.payload?.config?.channels?.[0]?.apiKey === "via-proxy", String(sharedForMember.payload?.config?.channels?.[0]?.apiKey));
    record("顶层历史 apiKey 字段同样被抹掉", sharedForMember.payload?.config?.apiKey === "via-proxy", String(sharedForMember.payload?.config?.apiKey));
    record("baseUrl 保持真实上游地址（代理要靠它解析目标）", sharedForMember.payload?.config?.channels?.[0]?.baseUrl === "https://api.example.com");
    record("模型列表原样下发", sharedForMember.payload?.config?.channels?.[0]?.models?.length === 1);
    record("其它偏好（systemPrompt）原样下发", sharedForMember.payload?.config?.systemPrompt === "shared system prompt");
    record("服务端不改动 proxyUrl（由前端强制指向本站）", sharedForMember.payload?.config?.proxyUrl === "http://127.0.0.1:23210");
    record("updatedAt 是数字时间戳", typeof sharedForMember.payload?.updatedAt === "number");

    // 只改一个偏好重新发布：密钥沿用，不能被占位符覆盖。
    const republished = await configAdmin.request("PUT", "/api/config", { config: { ...SHARED_CONFIG, size: "16:9" } });
    expectStatus("重复发布返回 200", republished, 200);
    record("重复发布不会把占位符当成真 Key（仍是 0 个缺失密钥）", Array.isArray(republished.payload?.missingSecrets) && republished.payload.missingSecrets.length === 0, JSON.stringify(republished.payload?.missingSecrets));
    const afterRepublish = await configMember.get("/api/config");
    record("普通用户立即读到新偏好", afterRepublish.payload?.config?.size === "16:9", String(afterRepublish.payload?.config?.size));
    record("普通用户读到的 apiKey 仍是占位符", afterRepublish.payload?.config?.channels?.[0]?.apiKey === "via-proxy");

    // 追加一个没有密钥的渠道：应被报为缺失，而不是留一条空密钥。
    const noKeyChannel = { id: "ch-no-key", name: "NoKey", baseUrl: "https://api.example.com", apiKey: "", apiFormat: "openai", models: [] };
    const withNoKey = await configAdmin.request("PUT", "/api/config", { config: { ...SHARED_CONFIG, channels: [...SHARED_CONFIG.channels, noKeyChannel] } });
    record("无密钥渠道被报进 missingSecrets", Array.isArray(withNoKey.payload?.missingSecrets) && withNoKey.payload.missingSecrets.includes("ch-no-key"), JSON.stringify(withNoKey.payload?.missingSecrets));
    record("有密钥的渠道不在缺失列表里", !withNoKey.payload?.missingSecrets?.includes("ch-1"));

    // 渠道被删掉时，它残留的密钥也要一起清掉。
    // 验证方式是**用同一个 id 和一个空密钥把渠道加回来**：密钥若已被清理，它就会出现在
    // missingSecrets 里；若旧密钥还在库里，就不会出现——所以这条断言是真的能分辨的。
    const tempChannel = { id: "ch-temp", name: "Temp", baseUrl: "https://api.example.com", apiKey: "sk-temp-should-be-purged", apiFormat: "openai", models: [] };
    await configAdmin.request("PUT", "/api/config", { config: { ...SHARED_CONFIG, channels: [...SHARED_CONFIG.channels, tempChannel] } });
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG });
    const tempAgain = await configAdmin.request("PUT", "/api/config", {
        config: { ...SHARED_CONFIG, channels: [...SHARED_CONFIG.channels, { ...tempChannel, apiKey: "" }] },
    });
    record("删渠道时其残留密钥确实被清理（同 id 以空密钥加回后仍报缺失）", tempAgain.payload?.missingSecrets?.includes("ch-temp"), JSON.stringify(tempAgain.payload?.missingSecrets));

    // 收尾：恢复成只有 ch-1 的状态，方便测试后用 sqlite 直接核对 channel_secrets 表。
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG });

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
    console.error("\n冒烟测试异常终止：", error);
    process.exitCode = 1;
});
