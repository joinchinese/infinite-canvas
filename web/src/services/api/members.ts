/**
 * 成员管理客户端（仅管理员可用）。
 *
 * 新增成员和重置密码时，密码在浏览器侧派生成 `clientVerifier` 再上传（原因见 `auth.ts`）。
 * **明文密码不会离开浏览器**，服务端拿不到它，因此也不存在"管理员能看到成员密码"这回事——
 * 忘了密码只能重置。
 */

import { deriveClientVerifier, requestJson } from "@/services/api/auth";
import type { AccessRole } from "@/services/api/auth";

export type MemberStatus = "active" | "disabled";

export type Member = {
    id: string;
    username: string;
    displayName: string;
    role: AccessRole;
    status: MemberStatus;
    createdAt: number;
    updatedAt: number;
    lastLoginAt: number | null;
};

export async function listMembersRequest(): Promise<Member[]> {
    const payload = await requestJson<{ members?: Member[] }>("/api/admin/members");
    return payload.members ?? [];
}

export async function createMemberRequest(input: { username: string; displayName?: string; role: AccessRole; password: string }): Promise<Member | null> {
    const clientVerifier = await deriveClientVerifier(input.password, input.username);
    const payload = await requestJson<{ member: Member | null }>("/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ username: input.username.trim(), displayName: input.displayName?.trim() || "", role: input.role, clientVerifier }),
    });
    return payload.member;
}

export async function updateMemberRequest(id: string, patch: { displayName?: string; role?: AccessRole; status?: MemberStatus }): Promise<Member | null> {
    const payload = await requestJson<{ member: Member | null }>(`/api/admin/members/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
    });
    return payload.member;
}

export async function deleteMemberRequest(id: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/api/admin/members/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function resetMemberPasswordRequest(id: string, username: string, password: string): Promise<void> {
    const clientVerifier = await deriveClientVerifier(password, username);
    await requestJson<{ ok: boolean }>(`/api/admin/members/${encodeURIComponent(id)}/password`, {
        method: "POST",
        body: JSON.stringify({ clientVerifier }),
    });
}
