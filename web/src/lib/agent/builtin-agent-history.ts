/**
 * 内置 Agent 历史会话本地持久化模块（基于 localforage / IndexedDB）。
 * 完全运行在浏览器端，不依赖任何外部 Local Codex 进程。
 */

import localforage from "localforage";
import { nanoid } from "nanoid";

import type { AgentChatItem, AgentThreadSummary } from "@/stores/use-agent-store";

const threadListStore = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "builtin_agent_threads",
});

const threadMessageStore = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "builtin_agent_messages",
});

/** 获取所有内置 Agent 会话摘要列表，按更新时间倒序排列。 */
export async function getBuiltinThreads(): Promise<AgentThreadSummary[]> {
    const threads: AgentThreadSummary[] = [];
    await threadListStore.iterate<AgentThreadSummary, void>((value) => {
        if (value && value.id) {
            threads.push(value);
        }
    });
    return threads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 获取某个会话下的全部历史消息。 */
export async function getBuiltinThreadMessages(threadId: string): Promise<AgentChatItem[]> {
    if (!threadId) return [];
    const messages = await threadMessageStore.getItem<AgentChatItem[]>(threadId);
    return Array.isArray(messages) ? messages : [];
}

/** 保存或更新会话消息及摘要。 */
export async function saveBuiltinThread(
    threadId: string,
    messages: AgentChatItem[],
    defaultTitle?: string,
): Promise<AgentThreadSummary> {
    const now = Date.now();
    const existing = await threadListStore.getItem<AgentThreadSummary>(threadId);

    // 从第一条用户消息中提取标题/预览
    const firstUserMsg = messages.find((m) => m.role === "user");
    const summaryText = firstUserMsg?.text?.trim() || defaultTitle || "新会话";
    const cleanTitle = summaryText.length > 28 ? `${summaryText.slice(0, 28)}...` : summaryText;

    const summary: AgentThreadSummary = {
        id: threadId,
        name: existing?.name || cleanTitle,
        preview: summaryText,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };

    await Promise.all([
        threadMessageStore.setItem(threadId, messages),
        threadListStore.setItem(threadId, summary),
    ]);

    return summary;
}

/** 批量删除指定的会话。 */
export async function deleteBuiltinThreads(threadIds: string[]): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const id of threadIds) {
        promises.push(threadListStore.removeItem(id));
        promises.push(threadMessageStore.removeItem(id));
    }
    await Promise.all(promises);
}

/** 创建一个新的内置会话 ID。 */
export function createBuiltinThreadId(): string {
    return `builtin_${nanoid(10)}`;
}
