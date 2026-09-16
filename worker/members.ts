/**
 * 成员管理（仅管理员可访问）。
 *
 * 接口：
 *   GET    /api/admin/members                 列表
 *   POST   /api/admin/members                 新增成员
 *   PATCH  /api/admin/members/:id             改角色 / 停用启用 / 改备注名
 *   DELETE /api/admin/members/:id             删除
 *   POST   /api/admin/members/:id/password    重置密码
 *
 * 两条防呆规则（避免把自己锁在门外）：
 *   1. 不能删除自己
 *   2. 系统里至少保留一名"启用状态的管理员"
 *
 * 刻意**没有**"不能修改自己的角色或启用状态"这条限制：它与第 2 条叠加后会让第 2 条永远不触发，
 * 而第 2 条已完整覆盖防锁死的需求，同时又保留了"把管理员移交给别人、自己退下来"的能力。
 */

import { randomId } from "./crypto";
import { buildSessionCookie, errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from "./http";
import { issueSessionForUser, requireAdmin, SESSION_TTL_SECONDS } from "./auth";
import { hashClientVerifier } from "./password";
import type { Env, Role, UserRow, UserStatus } from "./types";

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const CLIENT_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type MemberView = {
    id: string;
    username: string;
    displayName: string;
    role: Role;
    status: UserStatus;
    createdAt: number;
    updatedAt: number;
    lastLoginAt: number | null;
};

type MemberRow = Pick<
    UserRow,
    "id" | "username" | "display_name" | "role" | "status" | "created_at" | "updated_at" | "last_login_at"
>;

function toMemberView(row: MemberRow): MemberView {
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at,
    };
}

const SELECT_MEMBER_COLUMNS = "id, username, display_name, role, status, created_at, updated_at, last_login_at";

async function countActiveAdmins(env: Env): Promise<number> {
    const row = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'",
    ).first<{ total: number }>();
    return row?.total ?? 0;
}

function isUniqueViolation(error: unknown): boolean {
    return String(error instanceof Error ? error.message : error).toUpperCase().includes("UNIQUE");
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

/**
 * @param memberId  `/api/admin/members/:id` 里的 id（列表接口为 undefined）
 * @param subPath   第二段路径，目前只有 `password`
 */
export async function handleMembers(
    request: Request,
    env: Env,
    url: URL,
    secret: string,
    memberId?: string,
    subPath?: string,
): Promise<Response> {
    const auth = await requireAdmin(request, env, secret);
    if (!auth.ok) return auth.response;
    const actor = auth.user;
    const method = request.method.toUpperCase();

    if (!memberId) {
        if (method === "GET") return listMembers(env);
        if (method === "POST") return createMember(request, env, secret);
        return methodNotAllowed("GET, POST");
    }

    if (subPath === "password") {
        if (method !== "POST") return methodNotAllowed("POST");
        return resetPassword(request, env, url, secret, actor.id, memberId);
    }

    // `/api/admin/members/:id/<其他>` 一律 404，避免把未知子路径静默当成对 :id 的操作。
    if (subPath !== undefined) return errorResponse(404, "not_found");

    if (method === "PATCH") return updateMember(request, env, actor.id, memberId);
    if (method === "DELETE") return deleteMember(env, actor.id, memberId);
    return methodNotAllowed("PATCH, DELETE");
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

async function listMembers(env: Env): Promise<Response> {
    const { results } = await env.DB.prepare(
        `SELECT ${SELECT_MEMBER_COLUMNS} FROM users
         ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE`,
    ).all<MemberRow>();
    return jsonResponse({ members: (results ?? []).map(toMemberView) });
}

// ---------------------------------------------------------------------------
// 新增
// ---------------------------------------------------------------------------

type CreateInput = { username?: unknown; displayName?: unknown; role?: unknown; clientVerifier?: unknown };

async function createMember(request: Request, env: Env, secret: string): Promise<Response> {
    const body = await readJsonBody<CreateInput>(request);
    if (!body) return errorResponse(400, "invalid_body");

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) : "";
    const clientVerifier = typeof body.clientVerifier === "string" ? body.clientVerifier.trim() : "";
    const role: Role = body.role === "admin" ? "admin" : "member";

    if (!USERNAME_PATTERN.test(username)) return errorResponse(400, "invalid_username", "用户名需为 3-32 位字母、数字、点、下划线或短横线。");
    if (!CLIENT_VERIFIER_PATTERN.test(clientVerifier)) return errorResponse(400, "invalid_credentials_format");

    const now = Date.now();
    const id = randomId();
    const passwordHash = await hashClientVerifier(secret, username, clientVerifier);

    try {
        await env.DB.prepare(
            `INSERT INTO users (id, username, display_name, password_hash, role, status, auth_version, created_at, updated_at, last_login_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6, NULL)`,
        )
            .bind(id, username, displayName || username, passwordHash, role, now)
            .run();
    } catch (error) {
        if (isUniqueViolation(error)) return errorResponse(409, "username_taken", "该用户名已存在。");
        throw error;
    }

    const row = await env.DB.prepare(`SELECT ${SELECT_MEMBER_COLUMNS} FROM users WHERE id = ?1`)
        .bind(id)
        .first<MemberRow>();
    return jsonResponse({ member: row ? toMemberView(row) : null }, { status: 201 });
}

// ---------------------------------------------------------------------------
// 修改
// ---------------------------------------------------------------------------

type UpdateInput = { displayName?: unknown; role?: unknown; status?: unknown };

async function updateMember(request: Request, env: Env, actorId: string, memberId: string): Promise<Response> {
    const body = await readJsonBody<UpdateInput>(request);
    if (!body) return errorResponse(400, "invalid_body");

    const target = await env.DB.prepare(`SELECT ${SELECT_MEMBER_COLUMNS} FROM users WHERE id = ?1`)
        .bind(memberId)
        .first<MemberRow>();
    if (!target) return errorResponse(404, "member_not_found");

    const nextRole: Role = body.role === undefined ? target.role : body.role === "admin" ? "admin" : "member";
    const nextStatus: UserStatus = body.status === undefined ? target.status : body.status === "disabled" ? "disabled" : "active";
    const nextDisplayName =
        body.displayName === undefined ? target.display_name : typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) : target.display_name;

    // 允许管理员改动自己的角色/状态（便于把管理员身份移交给别人后自己退下来），
    // 但"系统里至少保留一名启用状态的管理员"这条不变量必须守住——
    // 这也是唯一能防止把自己锁在门外的关卡，因此不另加"不能改自己"的限制（那会让这条规则永远不触发）。
    const losesAdmin = target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active");
    if (losesAdmin && (await countActiveAdmins(env)) <= 1) {
        return errorResponse(409, "last_admin", "至少需要保留一名启用状态的管理员。");
    }

    const roleChanged = nextRole !== target.role;
    const statusChanged = nextStatus !== target.status;
    const now = Date.now();

    // 角色或状态变化时自增 auth_version，让目标用户的现有会话立即失效。
    await env.DB.prepare(
        `UPDATE users
         SET display_name = ?1, role = ?2, status = ?3, updated_at = ?4,
             auth_version = auth_version + ?5
         WHERE id = ?6`,
    )
        .bind(nextDisplayName || target.username, nextRole, nextStatus, now, roleChanged || statusChanged ? 1 : 0, memberId)
        .run();

    const row = await env.DB.prepare(`SELECT ${SELECT_MEMBER_COLUMNS} FROM users WHERE id = ?1`)
        .bind(memberId)
        .first<MemberRow>();
    return jsonResponse({ member: row ? toMemberView(row) : null });
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

async function deleteMember(env: Env, actorId: string, memberId: string): Promise<Response> {
    if (memberId === actorId) return errorResponse(409, "cannot_delete_self", "不能删除自己的账号。");

    const target = await env.DB.prepare("SELECT id, username, role, status FROM users WHERE id = ?1")
        .bind(memberId)
        .first<Pick<UserRow, "id" | "username" | "role" | "status">>();
    if (!target) return errorResponse(404, "member_not_found");

    // 这里刻意**不做**"至少保留一名管理员"的校验：它是不可达的。
    // 执行者必然是一名启用状态的管理员（requireAdmin 已保证），而被删者不可能是他自己（上面已拦），
    // 所以只要被删者是管理员，系统里就至少有 2 名启用管理员，校验条件恒不成立。
    // 管理员数量的下界由 updateMember 里的 last_admin 守卫负责维持。
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(memberId).run();
    return jsonResponse({ ok: true, id: memberId });
}

// ---------------------------------------------------------------------------
// 重置密码
// ---------------------------------------------------------------------------

type ResetInput = { clientVerifier?: unknown };

async function resetPassword(request: Request, env: Env, url: URL, secret: string, actorId: string, memberId: string): Promise<Response> {
    const body = await readJsonBody<ResetInput>(request);
    if (!body) return errorResponse(400, "invalid_body");

    const clientVerifier = typeof body.clientVerifier === "string" ? body.clientVerifier.trim() : "";
    if (!CLIENT_VERIFIER_PATTERN.test(clientVerifier)) return errorResponse(400, "invalid_credentials_format");

    const target = await env.DB.prepare("SELECT id, username, auth_version FROM users WHERE id = ?1")
        .bind(memberId)
        .first<Pick<UserRow, "id" | "username" | "auth_version">>();
    if (!target) return errorResponse(404, "member_not_found");

    const passwordHash = await hashClientVerifier(secret, target.username, clientVerifier);
    const now = Date.now();

    const result = await env.DB.prepare(
        `UPDATE users
         SET password_hash = ?1, failed_attempts = 0, locked_until = NULL, updated_at = ?2, auth_version = auth_version + 1
         WHERE id = ?3`,
    )
        .bind(passwordHash, now, memberId)
        .run();

    if ((result.meta?.changes ?? 0) !== 1) return errorResponse(404, "member_not_found");

    // 改自己的密码会把当前会话一起作废，所以顺手补发一个新会话，免得管理员把自己踢下线。
    if (memberId === actorId) {
        const token = await issueSessionForUser(env, secret, memberId);
        if (token) {
            return jsonResponse({ ok: true }, { headers: { "set-cookie": buildSessionCookie(token, url, SESSION_TTL_SECONDS) } });
        }
    }
    return jsonResponse({ ok: true });
}
