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
import { createServer } from "node:http";

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

    async request(method, path, body, extraHeaders) {
        const headers = { ...(extraHeaders || {}) };
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
// 假上游：代理测试用它来回答"上游到底收到了什么"
// ---------------------------------------------------------------------------

/**
 * 起一个真的 HTTP 服务器充当"供应商 API"。
 *
 * 代理的所有断言都必须基于**上游实际收到了什么**来判定，而不是基于我们自己的日志或
 * 返回值——后者可能"看起来对"但实际没发生。这个上游把收到的凭据原样回显，就成了断言依据。
 */
function startUpstream() {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url || "/", "http://upstream");

            // SSE：三段事件、每段间隔 150ms，用来验证"边生成边到达"而不是攒完再吐。
            if (url.pathname === "/v1/sse") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                let index = 0;
                const timer = setInterval(() => {
                    index += 1;
                    res.write(`data: chunk-${index}\n\n`);
                    if (index === 3) {
                        clearInterval(timer);
                        res.end();
                    }
                }, 150);
                return;
            }

            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        method: req.method,
                        path: url.pathname,
                        authorization: req.headers.authorization || "",
                        xGoogApiKey: req.headers["x-goog-api-key"] || "",
                        queryKey: url.searchParams.get("key") || "",
                        cookie: req.headers.cookie || "",
                        acceptEncoding: req.headers["accept-encoding"] || "",
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            });
        });
        server.listen(0, "127.0.0.1", () => {
            // unref：这个监听器不该阻止进程退出。否则测试中途抛错（没走到 close）时，
            // Node 会一直挂在这个 server 上不结束，表现为"测试卡死"。
            server.unref();
            resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

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
    record("管理员自己能读到包含真实 Key 的共享配置", sharedForAdmin.payload?.config?.channels?.[0]?.apiKey === REAL_KEY);
    record("普通用户能读到共享配置", Boolean(sharedForMember.payload?.config));
    record("普通用户响应里完全不出现真实 Key", !JSON.stringify(sharedForMember.payload).includes(REAL_KEY));
    record("普通用户的渠道 apiKey 已换成占位符（带渠道 id，供代理层定位密钥）", sharedForMember.payload?.config?.channels?.[0]?.apiKey === "via-proxy:ch-1", String(sharedForMember.payload?.config?.channels?.[0]?.apiKey));
    record("普通用户的顶层历史 apiKey 字段同样被抹掉（沿用首个渠道的 id）", sharedForMember.payload?.config?.apiKey === "via-proxy:ch-1", String(sharedForMember.payload?.config?.apiKey));
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
    record("普通用户读到的 apiKey 仍是占位符", afterRepublish.payload?.config?.channels?.[0]?.apiKey === "via-proxy:ch-1");

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

    console.log("\n【15】代理转发与真实 Key 注入");
    // 关键：所有断言都基于这个假上游**实际收到了什么**，而不是我们的日志或返回值。
    const upstream = await startUpstream();

    const PROXY_KEY = "sk-proxy-real-key-must-not-leak-1a2b";
    const PROXY_CHANNEL = {
        id: "ch-proxy",
        name: "Proxy",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        apiKey: PROXY_KEY,
        apiFormat: "openai",
        models: [{ name: "gpt-image-2", capability: "image" }],
    };
    const proxyConfig = { ...SHARED_CONFIG, channels: [...SHARED_CONFIG.channels, PROXY_CHANNEL] };
    await configAdmin.request("PUT", "/api/config", { config: proxyConfig });

    // 目标 URL 直接拼在代理地址后：/http://127.0.0.1:<port>/v1/...
    // proxyPath 是**路径**（Client 会自己补 BASE_URL 前缀），需要完整地址时用 proxyUrl。
    const proxyPath = (path) => `/http://127.0.0.1:${upstream.port}${path}`;
    const proxyUrl = (path) => `${BASE_URL}${proxyPath(path)}`;

    expectStatus("未登录使用代理返回 401", await new Client("匿名").get(proxyPath("/v1/echo")), 401);

    // 普通用户登录后，Authorization 里带的就是下发下来的占位符（真实场景由前端自动带上）。
    const echoed = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { authorization: "Bearer via-proxy:ch-proxy" });
    expectStatus("普通用户经代理请求上游返回 200", echoed, 200);
    record("上游收到的是真实 Key，而不是占位符", echoed.payload?.authorization === `Bearer ${PROXY_KEY}`, String(echoed.payload?.authorization));
    record("上游完全没有收到会话 Cookie", echoed.payload?.cookie === "", String(echoed.payload?.cookie));
    record("上游收到的路径原样保留", echoed.payload?.path === "/v1/echo", String(echoed.payload?.path));
    record("响应里不会把占位符回显出来（说明替换真的发生了）", !JSON.stringify(echoed.payload).includes("via-proxy:"), JSON.stringify(echoed.payload?.authorization));

    // 三种放置位置都要能替换（上游对 OpenAI / Gemini / 部分 Gemini 路径的写法不同）。
    const viaGoog = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { "x-goog-api-key": "via-proxy:ch-proxy" });
    record("x-goog-api-key 里的占位符被替换", viaGoog.payload?.xGoogApiKey === PROXY_KEY, String(viaGoog.payload?.xGoogApiKey));
    const viaQuery = await configMember.get(proxyPath("/v1/echo?key=via-proxy:ch-proxy"));
    record("查询参数 ?key= 里的占位符被替换", viaQuery.payload?.queryKey === PROXY_KEY, String(viaQuery.payload?.queryKey));

    const posted = await configMember.request("POST", proxyPath("/v1/echo"), { hello: "world" }, { authorization: "Bearer via-proxy:ch-proxy" });
    record("POST 请求体被完整转发", posted.payload?.body === '{"hello":"world"}', JSON.stringify(posted.payload?.body));
    record("POST 同样注入真实 Key", posted.payload?.authorization === `Bearer ${PROXY_KEY}`, String(posted.payload?.authorization));

    // 没有占位符时原样转发：上游还有别的合法用法（用户自己填了真 Key）。
    const OWN_KEY = "sk-own-key-of-the-operator";
    const passthrough = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { authorization: `Bearer ${OWN_KEY}` });
    record("请求里没有占位符时原样转发（不自作主张替换）", passthrough.payload?.authorization === `Bearer ${OWN_KEY}`, String(passthrough.payload?.authorization));

    // 占位符带的渠道 id 在库里没有密钥 → 明确报"缺密钥"，而不是"随便挑一个 Key"。
    const unknownChannel = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { authorization: "Bearer via-proxy:no-such-channel" });
    expectStatus("占位符指向库里没有密钥的渠道返回 502", unknownChannel, 502);
    record("错误码指出是缺密钥（不会退化成随便挑一个 Key）", unknownChannel.payload?.error === "channel_secret_missing", String(unknownChannel.payload?.error));

    // 裸占位符（没有 id，来自历史配置或顶层 apiKey）退化为**按目标 origin 匹配渠道**。
    const bareMatched = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { authorization: "Bearer via-proxy" });
    record("裸占位符按目标 origin 回退匹配到渠道", bareMatched.payload?.authorization === `Bearer ${PROXY_KEY}`, String(bareMatched.payload?.authorization));
    const bareUnmatched = await configMember.request("GET", "/http://127.0.0.1:1/v1/echo", undefined, { authorization: "Bearer via-proxy" });
    expectStatus("裸占位符匹配不到任何渠道返回 502", bareUnmatched, 502);
    record("错误码指出渠道无法解析", bareUnmatched.payload?.error === "channel_unresolved", String(bareUnmatched.payload?.error));

    // 「配置里有这个渠道，但库里没有它的密钥」——必须报得出来，否则在用户那边只表现为生成失败。
    const keylessChannel = { id: "ch-keyless", name: "Keyless", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "", apiFormat: "openai", models: [] };
    await configAdmin.request("PUT", "/api/config", { config: { ...proxyConfig, channels: [...proxyConfig.channels, keylessChannel] } });
    const missingSecret = await configMember.request("GET", proxyPath("/v1/echo"), undefined, { authorization: "Bearer via-proxy:ch-keyless" });
    expectStatus("占位符指向没有密钥的渠道返回 502", missingSecret, 502);
    record("错误码指出是缺密钥", missingSecret.payload?.error === "channel_secret_missing", String(missingSecret.payload?.error));

    // 上游不可达时应有明确的 502，而不是把异常直接抛成 500。
    const deadPort = await configMember.request("GET", "/http://127.0.0.1:1/v1/echo", undefined, { authorization: "Bearer via-proxy:ch-proxy" });
    expectStatus("上游不可达返回 502", deadPort, 502);
    record("错误码指出是上游不可达", deadPort.payload?.error === "upstream_unreachable", String(deadPort.payload?.error));

    // SSE：必须边生成边到达。若被缓冲，首块会等到最后才出现（首块耗时 ≈ 总耗时）。
    const sseStartedAt = Date.now();
    const sseResponse = await fetch(proxyUrl("/v1/sse"), { headers: { cookie: configMember.cookie } });
    record("SSE 的 content-type 被原样保留", sseResponse.headers.get("content-type") === "text/event-stream", String(sseResponse.headers.get("content-type")));
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let firstChunkMs = 0;
    let sseText = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkMs) firstChunkMs = Date.now() - sseStartedAt;
        sseText += decoder.decode(value, { stream: true });
    }
    const totalMs = Date.now() - sseStartedAt;
    record("SSE 三段事件全部送达", /chunk-1[\s\S]*chunk-2[\s\S]*chunk-3/.test(sseText), JSON.stringify(sseText.slice(0, 80)));
    record("SSE 是流式到达而不是攒完再吐", firstChunkMs + 120 < totalMs, `首块 ${firstChunkMs}ms / 总计 ${totalMs}ms`);

    // 收尾：恢复配置并关掉假上游。
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG });
    await upstream.close();

    // -----------------------------------------------------------------------
    // WebDAV 统一纳管与成员专属目录隔离
    // -----------------------------------------------------------------------
    const WEBDAV = {
        url: "https://dav.example.com/webdav",
        username: "backup-user",
        password: "backup-pass",
        directory: "infinite-canvas",
        lastSyncedAt: "",
        useProxy: false,
        syncMode: "serial",
        skipExistingFiles: true,
        autoSync: true,
        sharedEnabled: true,
        isolateMembers: true,
    };

    const webdavPublished = await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG, webdav: WEBDAV });
    expectStatus("管理员可发布 WebDAV 纳管配置", webdavPublished, 200);

    const adminWebdav = await configAdmin.get("/api/config");
    record("管理员读回自己的 WebDAV 配置（directory 保持根目录原样）", adminWebdav.payload?.webdav?.directory === "infinite-canvas", String(adminWebdav.payload?.webdav?.directory));
    record("管理员同样拿到隔离段（数据也落 users/<用户名>，根目录保持整洁）", adminWebdav.payload?.webdav?.memberScope === "users/gate-admin", String(adminWebdav.payload?.webdav?.memberScope));
    record("管理员的 WebDAV 配置不打 managed 标记（保持可编辑）", !adminWebdav.payload?.webdav?.managed);
    record("lastSyncedAt 不入库（纯个人状态，不随发布流动）", adminWebdav.payload?.webdav?.lastSyncedAt === undefined, JSON.stringify(adminWebdav.payload?.webdav?.lastSyncedAt));

    const memberWebdav = await configMember.get("/api/config");
    record("普通成员能读到下发的 WebDAV 配置", Boolean(memberWebdav.payload?.webdav?.url), String(memberWebdav.payload?.webdav?.url));
    const memberDir = memberWebdav.payload?.webdav?.directory;
    const expectedScope = `users/${String(CONFIG_MEMBER.username).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    record("成员拿到专属子目录（根目录/users/<用户名>）", memberDir === `infinite-canvas/${expectedScope}`, String(memberDir));
    record("成员同时拿到 memberScope 供前端幂等拼接", memberWebdav.payload?.webdav?.memberScope === expectedScope, String(memberWebdav.payload?.webdav?.memberScope));
    record("成员的 WebDAV 配置带 managed 标记（前端据此置灰输入）", memberWebdav.payload?.webdav?.managed === true);
    record("成员读到的 WebDAV 凭据可用（这是共享备份账号，非渠道密钥）", memberWebdav.payload?.webdav?.username === "backup-user");
    record("成员拿到的目录不等于管理员根目录（不会互相覆盖）", Boolean(memberDir) && memberDir !== "infinite-canvas", `${memberDir}`);

    // 管理员关掉下发：成员应读不到 WebDAV 配置，而不是拿到别人的。
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG, webdav: { ...WEBDAV, sharedEnabled: false } });
    const memberAfterDisable = await configMember.get("/api/config");
    record("关闭下发后成员读不到 WebDAV 配置", memberAfterDisable.payload?.webdav === null, JSON.stringify(memberAfterDisable.payload?.webdav));

    // 管理员关掉隔离：全员落到根目录（危险选项，但行为要可预期）。
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG, webdav: { ...WEBDAV, isolateMembers: false } });
    const memberNoIsolate = await configMember.get("/api/config");
    record("关闭隔离后成员落到共享根目录", memberNoIsolate.payload?.webdav?.directory === "infinite-canvas", String(memberNoIsolate.payload?.webdav?.directory));
    record("关闭隔离后 memberScope 为空（不重复拼接）", memberNoIsolate.payload?.webdav?.memberScope === "", JSON.stringify(memberNoIsolate.payload?.webdav?.memberScope));
    const adminNoIsolate = await configAdmin.get("/api/config");
    record("关闭隔离后管理员的隔离段同样清空", adminNoIsolate.payload?.webdav?.memberScope === "", JSON.stringify(adminNoIsolate.payload?.webdav?.memberScope));

    // webdav 传 null 表示撤销纳管，成员应回落到各自本地配置。
    await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG, webdav: null });
    const memberAfterRevoke = await configMember.get("/api/config");
    record("传 null 可撤销 WebDAV 纳管", memberAfterRevoke.payload?.webdav === null, JSON.stringify(memberAfterRevoke.payload?.webdav));

    // 非法 webdav（数组）不应被写进库，且不影响配置本身的发布。
    const badWebdav = await configAdmin.request("PUT", "/api/config", { config: SHARED_CONFIG, webdav: ["nope"] });
    expectStatus("webdav 传数组时仍按配置本身返回 200", badWebdav, 200);
    const afterBadWebdav = await configAdmin.get("/api/config");
    record("非法 webdav 不会被持久化", afterBadWebdav.payload?.webdav === null, JSON.stringify(afterBadWebdav.payload?.webdav));

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
