/**
 * 成员管理页（仅管理员可访问，路由 `/admin/members`）。
 *
 * ## 放在这里是为了贴合上游的目录约定
 *
 * 项目 `AGENTS.md` 里已经写了 `admin/assets/`、`admin/prompts/` 这套"管理后台"目录规范
 * （代码里还没有 `admin` 目录），所以 `pages/admin/members/` 正是作者规划中的位置。
 * 万一上游将来真的加了同名目录，冲突也只是路径撞车，不需要重写逻辑。
 *
 * ## 这个页面的两道防线
 *
 * 1. 前端：非管理员直接 `<Navigate to="/" replace />`
 * 2. 后端：`/api/admin/*` 全部走 `requireAdmin`，非管理员一律 403
 *
 * 前端这道只是体验，**真正的门禁在后端**——绕过它没有任何收益，因为拿不到数据也改不动任何东西。
 */

import { useCallback, useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Popconfirm, Select, Table, Tabs, Tag } from "antd";
import { Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import { SharedConfigPanel } from "@/components/access/shared-config-panel";
import { accessErrorMessage } from "@/lib/access-error";
import type { AccessRole } from "@/services/api/auth";
import {
    createMemberRequest,
    deleteMemberRequest,
    listMembersRequest,
    resetMemberPasswordRequest,
    updateMemberRequest,
    type Member,
    type MemberStatus,
} from "@/services/api/members";
import { useAccessStore, useIsAdmin } from "@/stores/use-access-store";

type FormMode = "create" | "edit";

type MemberFormFields = {
    username: string;
    displayName?: string;
    role: AccessRole;
    status?: MemberStatus;
    password?: string;
    confirm?: string;
};

type PasswordFields = { password: string; confirm: string };

/** 与 Worker 侧 `USERNAME_PATTERN` / 登录页保持一致。 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;

function formatTime(value: number | null, fallback: string) {
    return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : fallback;
}

export default function AdminMembersPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const isAdmin = useIsAdmin();
    const currentUser = useAccessStore((state) => state.user);

    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("members");

    const [formMode, setFormMode] = useState<FormMode | null>(null);
    const [editingMember, setEditingMember] = useState<Member | null>(null);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm<MemberFormFields>();

    const [passwordTarget, setPasswordTarget] = useState<Member | null>(null);
    const [resetting, setResetting] = useState(false);
    const [passwordForm] = Form.useForm<PasswordFields>();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setMembers(await listMembersRequest());
        } catch (error) {
            message.error(accessErrorMessage(error) || t("access.members.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        if (!isAdmin) return;
        void load();
    }, [isAdmin, load]);

    // 非管理员：所有 hook 都已执行完毕，这里再返回是安全的。
    if (!isAdmin) return <Navigate to="/" replace />;

    const openCreate = () => {
        setEditingMember(null);
        setFormMode("create");
        form.setFieldsValue({ username: "", displayName: "", role: "member", password: "", confirm: "" });
    };

    const openEdit = (member: Member) => {
        setEditingMember(member);
        setFormMode("edit");
        form.setFieldsValue({ username: member.username, displayName: member.displayName, role: member.role, status: member.status });
    };

    const closeForm = () => {
        setFormMode(null);
        setEditingMember(null);
        form.resetFields();
    };

    const submitForm = async (values: MemberFormFields) => {
        setSaving(true);
        try {
            if (formMode === "create") {
                const created = await createMemberRequest({
                    username: values.username,
                    displayName: values.displayName,
                    role: values.role,
                    password: values.password || "",
                });
                message.success(t("access.members.created"));
                closeForm();
                if (created) setMembers((list) => [...list, created].sort(compareMembers));
                else await load();
            } else if (editingMember) {
                const updated = await updateMemberRequest(editingMember.id, {
                    displayName: values.displayName,
                    role: values.role,
                    status: values.status,
                });
                message.success(t("access.members.updated"));
                closeForm();
                if (updated) setMembers((list) => list.map((item) => (item.id === updated.id ? updated : item)).sort(compareMembers));
                else await load();
            }
        } catch (error) {
            message.error(accessErrorMessage(error));
        } finally {
            setSaving(false);
        }
    };

    const submitPassword = async (values: PasswordFields) => {
        if (!passwordTarget) return;
        setResetting(true);
        try {
            await resetMemberPasswordRequest(passwordTarget.id, passwordTarget.username, values.password);
            message.success(t("access.members.passwordReset"));
            setPasswordTarget(null);
            passwordForm.resetFields();
            await load();
        } catch (error) {
            message.error(accessErrorMessage(error));
        } finally {
            setResetting(false);
        }
    };

    const removeMember = async (member: Member) => {
        try {
            await deleteMemberRequest(member.id);
            message.success(t("access.members.deleted"));
            setMembers((list) => list.filter((item) => item.id !== member.id));
        } catch (error) {
            message.error(accessErrorMessage(error));
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-5xl px-6 py-6">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("access.members.title")}</h1>
                        <p className="mt-1 max-w-2xl text-sm text-stone-500">{t("access.members.description")}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                            {t("access.members.refresh")}
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                            {t("access.members.add")}
                        </Button>
                    </div>
                </div>

                <Tabs
                    activeKey={activeTab}
                    onChange={setActiveTab}
                    items={[
                        {
                            key: "members",
                            label: t("access.members.nav"),
                            children: (
                                <Table<Member>
                                    rowKey="id"
                                    size="middle"
                                    loading={loading}
                                    dataSource={members}
                                    pagination={false}
                                    locale={{ emptyText: t("access.members.empty") }}
                                    columns={[
                                        {
                                            title: t("access.members.columns.username"),
                                            dataIndex: "username",
                                            render: (username: string, member) => (
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium">{username}</span>
                                                    {member.id === currentUser?.id ? <Tag color="blue">{t("access.members.you")}</Tag> : null}
                                                </div>
                                            ),
                                        },
                                        {
                                            title: t("access.members.columns.displayName"),
                                            dataIndex: "displayName",
                                            render: (displayName: string) => <span className="text-stone-500">{displayName || "—"}</span>,
                                        },
                                        {
                                            title: t("access.members.columns.role"),
                                            dataIndex: "role",
                                            width: 120,
                                            render: (role: AccessRole) => <Tag color={role === "admin" ? "gold" : "default"}>{t(`access.members.roles.${role}`)}</Tag>,
                                        },
                                        {
                                            title: t("access.members.columns.status"),
                                            dataIndex: "status",
                                            width: 100,
                                            render: (status: MemberStatus) => <Tag color={status === "active" ? "green" : "red"}>{t(`access.members.status.${status}`)}</Tag>,
                                        },
                                        {
                                            title: t("access.members.columns.createdAt"),
                                            dataIndex: "createdAt",
                                            width: 150,
                                            render: (value: number) => <span className="text-xs text-stone-500">{formatTime(value, "—")}</span>,
                                        },
                                        {
                                            title: t("access.members.columns.lastLoginAt"),
                                            dataIndex: "lastLoginAt",
                                            width: 150,
                                            render: (value: number | null) => <span className="text-xs text-stone-500">{formatTime(value, t("access.members.never"))}</span>,
                                        },
                                        {
                                            title: t("access.members.columns.actions"),
                                            key: "actions",
                                            width: 200,
                                            render: (_value, member) => (
                                                <div className="flex gap-1">
                                                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(member)} />
                                                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => setPasswordTarget(member)} title={t("access.members.resetPassword")} />
                                                    {member.id === currentUser?.id ? (
                                                        <Button size="small" danger disabled icon={<Trash2 className="size-3.5" />} title={t("access.members.deleteSelfHint")} />
                                                    ) : (
                                                        <Popconfirm
                                                            title={t("access.members.deleteConfirm", { name: member.displayName || member.username })}
                                                            okText={t("common.delete")}
                                                            cancelText={t("common.cancel")}
                                                            okButtonProps={{ danger: true }}
                                                            onConfirm={() => void removeMember(member)}
                                                        >
                                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} />
                                                        </Popconfirm>
                                                    )}
                                                </div>
                                            ),
                                        },
                                    ]}
                                />
                            ),
                        },
                        {
                            key: "shared-config",
                            label: t("access.sharedConfig.nav"),
                            children: <SharedConfigPanel />,
                        },
                    ]}
                />
            </div>

            <Modal
                open={formMode !== null}
                title={t(formMode === "create" ? "access.members.addTitle" : "access.members.editTitle")}
                okText={t(formMode === "create" ? "access.members.createSubmit" : "access.members.saveSubmit")}
                cancelText={t("common.cancel")}
                confirmLoading={saving}
                onCancel={closeForm}
                onOk={() => form.submit()}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" requiredMark={false} onFinish={(values) => void submitForm(values)} className="mt-4">
                    {formMode === "create" ? (
                        <Form.Item name="username" label={t("access.login.username")} rules={[{ required: true }, { pattern: USERNAME_PATTERN, message: t("access.setup.usernamePattern") }]}>
                            <Input placeholder={t("access.login.usernamePlaceholder")} autoComplete="off" />
                        </Form.Item>
                    ) : null}

                    <Form.Item name="displayName" label={t("access.members.displayName")}>
                        <Input placeholder={t("access.members.displayNamePlaceholder")} />
                    </Form.Item>

                    <Form.Item name="role" label={t("access.members.role")} extra={t("access.members.roleHint")} initialValue="member">
                        <Select
                            options={[
                                { value: "member", label: t("access.members.roles.member") },
                                { value: "admin", label: t("access.members.roles.admin") },
                            ]}
                        />
                    </Form.Item>

                    {formMode === "edit" ? (
                        <Form.Item name="status" label={t("access.members.statusLabel")} extra={t("access.members.statusHint")}>
                            <Select
                                options={[
                                    { value: "active", label: t("access.members.status.active") },
                                    { value: "disabled", label: t("access.members.status.disabled") },
                                ]}
                            />
                        </Form.Item>
                    ) : (
                        <>
                            <Form.Item name="password" label={t("access.members.password")} extra={t("access.members.passwordHint")} rules={[{ required: true }, { min: MIN_PASSWORD_LENGTH, message: t("access.setup.passwordMinLength") }]}>
                                <Input.Password placeholder={t("access.members.passwordPlaceholder")} autoComplete="new-password" />
                            </Form.Item>
                            <Form.Item
                                name="confirm"
                                label={t("access.setup.confirm")}
                                dependencies={["password"]}
                                rules={[
                                    { required: true, message: t("access.setup.confirmRequired") },
                                    ({ getFieldValue }) => ({
                                        validator: (_rule, value) =>
                                            !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("access.setup.passwordMismatch"))),
                                    }),
                                ]}
                            >
                                <Input.Password placeholder={t("access.setup.confirmPlaceholder")} autoComplete="new-password" />
                            </Form.Item>
                        </>
                    )}
                </Form>
            </Modal>

            <Modal
                open={passwordTarget !== null}
                title={t("access.members.resetPasswordTitle", { name: passwordTarget?.displayName || passwordTarget?.username || "" })}
                okText={t("access.members.resetSubmit")}
                cancelText={t("common.cancel")}
                confirmLoading={resetting}
                onCancel={() => {
                    setPasswordTarget(null);
                    passwordForm.resetFields();
                }}
                onOk={() => passwordForm.submit()}
                destroyOnHidden
            >
                <Form form={passwordForm} layout="vertical" requiredMark={false} onFinish={(values) => void submitPassword(values)} className="mt-4">
                    <Form.Item name="password" label={t("access.members.password")} extra={t("access.members.resetPasswordHint")} rules={[{ required: true }, { min: MIN_PASSWORD_LENGTH, message: t("access.setup.passwordMinLength") }]}>
                        <Input.Password placeholder={t("access.members.passwordPlaceholder")} autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item
                        name="confirm"
                        label={t("access.setup.confirm")}
                        dependencies={["password"]}
                        rules={[
                            { required: true, message: t("access.setup.confirmRequired") },
                            ({ getFieldValue }) => ({
                                validator: (_rule, value) =>
                                    !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("access.setup.passwordMismatch"))),
                            }),
                        ]}
                    >
                        <Input.Password placeholder={t("access.setup.confirmPlaceholder")} autoComplete="new-password" />
                    </Form.Item>
                </Form>
            </Modal>
        </main>
    );
}

/** 管理员排前面，其余按用户名不区分大小写排序——与后端列表顺序保持一致。 */
function compareMembers(left: Member, right: Member) {
    if (left.role !== right.role) return left.role === "admin" ? -1 : 1;
    return left.username.toLowerCase().localeCompare(right.username.toLowerCase());
}
