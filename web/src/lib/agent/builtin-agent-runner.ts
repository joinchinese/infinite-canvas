/**
 * 内置 Agent 执行驱动器 (Built-in Agent Runner)。
 *
 * 纯前端驱动的 ReAct 循环：
 * 1. 从 useConfigStore 获取已配置的文本模型（走 Worker 代理网关，不暴露真实 Key）。
 * 2. 携带画布工具规范向 LLM 发起流式 Chat Completion 请求。
 * 3. 实时更新 UI 消息气泡中的文字；若模型触发 tool_calls，在前端直接操作画布/工具并回传结果。
 * 4. 支持打断（AbortController）与多轮自主行动。
 */

import type { NavigateFunction } from "react-router-dom";
import { nanoid } from "nanoid";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isSiteTool, runSiteTool, type SiteToolName } from "@/lib/agent/agent-site-tools";
import { BUILTIN_AGENT_SYSTEM_PROMPT, BUILTIN_AGENT_TOOLS } from "@/lib/agent/builtin-agent-tools";
import { buildApiUrl, modelOptionLabel, resolveModelRequestConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useAgentStore, type AgentChatItem } from "@/stores/use-agent-store";

const MAX_AGENT_STEPS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

let currentAbortController: AbortController | null = null;

export function isBuiltinAgentRunning(): boolean {
    return currentAbortController !== null;
}

export function stopBuiltinAgent(): void {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
}

type ChatMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};

type StreamToolCallAccumulator = {
    id: string;
    name: string;
    arguments: string;
};

/**
 * 运行内置 Agent 对话单轮/多轮循环。
 */
export async function runBuiltinAgentTurn(
    userPrompt: string,
    navigate: NavigateFunction,
    callbacks?: {
        onStreamText?: (accumulatedText: string) => void;
        onActivity?: (activityText: string) => void;
    },
): Promise<void> {
    const configState = useConfigStore.getState().config;
    const agentStore = useAgentStore.getState();

    // 1. 获取选中的思考/文本模型配置
    const targetModel = agentStore.model || configState.textModel || configState.model;
    const requestConfig = resolveModelRequestConfig(configState, targetModel);

    if (!requestConfig.baseUrl.trim() || !requestConfig.apiKey.trim()) {
        throw new Error("当前未配置文本模型或渠道，请先在「配置与用户偏好」中添加可用渠道。");
    }

    // 2. 获取用户当前指定的生图模型
    const selectedImageModel = agentStore.imageModel || configState.imageModel || configState.model;
    const selectedImageModelLabel = modelOptionLabel(configState, selectedImageModel);

    // 3. 准备中止控制器
    stopBuiltinAgent();
    const abortController = new AbortController();
    currentAbortController = abortController;

    // 4. 构建初始消息上下文
    const canvasContext = agentStore.canvasContext;
    const snapshot = canvasContext?.snapshot;
    const canvasSummary = snapshot
        ? `\n\n【当前画布环境快照】\n- 项目标题: ${snapshot.title || "未命名画布"}\n- 节点数量: ${snapshot.nodes.length} 个（${snapshot.nodes.map((n) => `[${n.type}] ${n.title || n.id}`).join("、") || "空"}）\n- 连线数量: ${snapshot.connections.length} 条`
        : "\n\n【当前没有已连接的画布】";

    const defaultSize = configState.size || "1:1";
    const defaultCount = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(configState.canvasImageCount || configState.count)) || 1)));
    const defaultQuality = configState.quality || "auto";

    const imageSettingsPrompt = `\n\n【生图面板默认参数】
- 当前绘图模型: "${selectedImageModel || "默认"}" (${selectedImageModelLabel || "默认"})
- 当前面板画幅比例 (size): "${defaultSize}"
- 当前面板生成张数 (count): ${defaultCount}
- 当前面板画质质量 (quality): "${defaultQuality}"
【生图参数遵从规则】：
1. 当用户创建生图配置节点（config 节点）且未特别指定比例或张数时，默认使用上述面板参数；
2. 当用户在指令中明确要求了画幅比例（如 "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"）或生成数量（如 1张、2张等）时，必须严格将对应的值填入 metadata.size 与 metadata.count 中，严禁忽略！`;

    const systemMessage: ChatMessage = {
        role: "system",
        content: `${BUILTIN_AGENT_SYSTEM_PROMPT}${imageSettingsPrompt}${canvasSummary}`,
    };

    // 提取历史对话中最近的几轮纯对话（排除当前刚加入 store 的最末尾这一条用户消息）
    const previousMessages: ChatMessage[] = [];
    const allStoreMessages = agentStore.messages;
    const historyPool = allStoreMessages.slice(0, -1).slice(-8);
    for (const msg of historyPool) {
        if (msg.role === "user" && msg.text?.trim()) {
            previousMessages.push({ role: "user", content: msg.text.trim() });
        } else if (msg.role === "assistant" && msg.text?.trim()) {
            previousMessages.push({ role: "assistant", content: msg.text.trim() });
        }
    }

    const messages: ChatMessage[] = [
        systemMessage,
        ...previousMessages,
        { role: "user", content: userPrompt },
    ];

    // 生成当前 assistant 消息卡片 ID
    const assistantMessageId = nanoid();
    let currentAssistantText = "";

    agentStore.addMessage({
        id: assistantMessageId,
        threadId: agentStore.activeThreadId,
        turnId: agentStore.activeTurnId,
        role: "assistant",
        text: "",
    });

    const updateAssistantUI = (text: string) => {
        currentAssistantText = text;
        const currentMsgs = useAgentStore.getState().messages;
        useAgentStore.getState().setAgentState({
            messages: currentMsgs.map((m) => (m.id === assistantMessageId ? { ...m, text } : m)),
        });
        callbacks?.onStreamText?.(text);
    };

    try {
        for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
            if (abortController.signal.aborted) break;

            callbacks?.onActivity?.(step === 0 ? "正在思考..." : "正在处理执行结果...");

            const result = await streamChatCompletion(requestConfig, messages, abortController.signal, (deltaText) => {
                updateAssistantUI(currentAssistantText + deltaText);
            });

            currentAssistantText = result.content;
            updateAssistantUI(currentAssistantText);

            // 如果没有工具调用，Agent 这一轮意图已完成
            if (!result.toolCalls || result.toolCalls.length === 0) {
                break;
            }

            // 模型返回了工具调用
            messages.push({
                role: "assistant",
                content: result.content || null,
                tool_calls: result.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                })),
            });

            // 执行每一个工具调用并收集结果
            for (const toolCall of result.toolCalls) {
                if (abortController.signal.aborted) break;

                const name = toolCall.name;
                let parsedArgs: Record<string, unknown> = {};
                try {
                    parsedArgs = JSON.parse(toolCall.arguments || "{}");
                } catch {
                    parsedArgs = {};
                }

                callbacks?.onActivity?.(`执行工具: ${name}...`);
                agentStore.addEventLog({
                    id: nanoid(),
                    time: new Date().toLocaleTimeString(),
                    title: `调用工具: ${name}`,
                    text: JSON.stringify(parsedArgs, null, 2),
                });

                let toolOutput = "";
                try {
                    if (name === "canvas_get_state") {
                        const currentCtx = useAgentStore.getState().canvasContext;
                        if (!currentCtx?.snapshot) {
                            toolOutput = JSON.stringify({ error: "当前没有打开的画布" });
                        } else {
                            const snap = currentCtx.snapshot;
                            toolOutput = JSON.stringify({
                                projectId: snap.projectId,
                                title: snap.title,
                                nodesCount: snap.nodes.length,
                                nodes: snap.nodes.map((n) => ({
                                    id: n.id,
                                    type: n.type,
                                    title: n.title,
                                    position: n.position,
                                    width: n.width,
                                    height: n.height,
                                    content: n.metadata?.content || n.metadata?.composerContent || "",
                                })),
                                connections: snap.connections,
                            });
                        }
                    } else if (name === "canvas_apply_ops") {
                        const currentCtx = useAgentStore.getState().canvasContext;
                        if (!currentCtx) {
                            toolOutput = JSON.stringify({ error: "当前没有已连接的画布上下文" });
                        } else {
                            const rawOps = (parsedArgs.ops as CanvasAgentOp[]) || [];
                            const promptAspect = userPrompt.match(/\b(16:9|9:16|1:1|4:3|3:4|21:9)\b/i)?.[1];
                            const promptCount = /([1一]\s*[张幅个]|单张)/.test(userPrompt)
                                ? 1
                                : /([2两二]\s*[张幅个])/.test(userPrompt)
                                    ? 2
                                    : /([3三]\s*[张幅个])/.test(userPrompt)
                                        ? 3
                                        : /([4四]\s*[张幅个])/.test(userPrompt)
                                            ? 4
                                            : undefined;

                            // 识别本批次中将被 run_generation 触发的 config 节点 ID
                            const generatingConfigIds = new Set<string>();
                            for (const op of rawOps) {
                                if (op.type === "run_generation" && op.nodeId) {
                                    generatingConfigIds.add(op.nodeId);
                                }
                            }

                            // 若存在 run_generation，查找大模型手动连向该 config 节点的冗余空白 image 节点
                            const redundantImageNodeIds = new Set<string>();
                            if (generatingConfigIds.size > 0) {
                                const connectedToConfig = new Set<string>();
                                for (const op of rawOps) {
                                    if (op.type === "connect_nodes" && op.fromNodeId && op.toNodeId && generatingConfigIds.has(op.fromNodeId)) {
                                        connectedToConfig.add(op.toNodeId);
                                    }
                                }
                                for (const op of rawOps) {
                                    if (op.type === "add_node" && op.nodeType === "image" && op.id && connectedToConfig.has(op.id)) {
                                        const meta = op.metadata || {};
                                        if (!meta.content && (!meta.images || (Array.isArray(meta.images) && meta.images.length === 0))) {
                                            redundantImageNodeIds.add(op.id);
                                        }
                                    }
                                }
                            }

                            const ops = rawOps
                                .filter((op) => {
                                    if (op.type === "add_node" && op.id && redundantImageNodeIds.has(op.id)) return false;
                                    if (op.type === "connect_nodes" && op.toNodeId && redundantImageNodeIds.has(op.toNodeId)) return false;
                                    return true;
                                })
                                .map((op) => {
                                    if (op.type === "add_node" && (op.nodeType === "config" || !op.nodeType)) {
                                        const meta = { ...(op.metadata || {}) };
                                        if (!meta.model && selectedImageModel) {
                                            meta.model = selectedImageModel;
                                        }
                                        if (!meta.size) {
                                            meta.size = promptAspect || defaultSize;
                                        }
                                        if (!meta.count) {
                                            meta.count = promptCount || defaultCount;
                                        }
                                        if (!meta.quality) {
                                            meta.quality = defaultQuality;
                                        }
                                        return { ...op, metadata: meta };
                                    }
                                    return op;
                                });
                            const updatedSnapshot = currentCtx.applyOps(ops);
                            toolOutput = JSON.stringify({
                                success: true,
                                appliedOpsCount: ops.length,
                                totalNodes: updatedSnapshot.nodes.length,
                            });
                            agentStore.addEventLog({
                                id: nanoid(),
                                time: new Date().toLocaleTimeString(),
                                title: "画布操作已生效",
                                text: `更新后共 ${updatedSnapshot.nodes.length} 个节点`,
                            });
                        }
                    } else if (name === "site_navigate") {
                        const path = typeof parsedArgs.path === "string" ? parsedArgs.path : "/";
                        navigate(path);
                        toolOutput = JSON.stringify({ success: true, navigatedTo: path });
                    } else if (isSiteTool(name)) {
                        const currentSnap = useAgentStore.getState().canvasContext?.snapshot;
                        const siteRes = await runSiteTool(name as SiteToolName, parsedArgs, navigate, {
                            canvasSnapshot: currentSnap,
                        });
                        toolOutput = JSON.stringify(siteRes ?? { success: true });
                    } else {
                        toolOutput = JSON.stringify({ error: `未知工具: ${name}` });
                    }
                } catch (err) {
                    toolOutput = JSON.stringify({
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: toolOutput,
                });
            }
        }
    } finally {
        if (currentAbortController === abortController) {
            currentAbortController = null;
        }
        callbacks?.onActivity?.("就绪");
    }
}

/**
 * 封装向 OpenAI 兼容 `/chat/completions` 发起 SSE 流式调用的请求器。
 */
async function streamChatCompletion(
    config: AiConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
): Promise<{ content: string; toolCalls: StreamToolCallAccumulator[] }> {
    const url = buildApiUrl(config.baseUrl, "/chat/completions");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "text/event-stream",
    };

    const requestBody = {
        model: config.model,
        messages,
        tools: BUILTIN_AGENT_TOOLS,
        stream: true,
    };

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!response.ok) {
        let errDetail = "";
        try {
            const errJson = await response.json();
            errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
        } catch {
            errDetail = await response.text().catch(() => "");
        }
        throw new Error(`模型请求失败 (HTTP ${response.status}): ${errDetail || response.statusText}`);
    }

    if (!response.body) {
        throw new Error("服务端没有返回流式数据体");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedContent = "";
    const toolCallMap = new Map<number, StreamToolCallAccumulator>();

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const payloadStr = trimmed.slice(5).trim();
            if (payloadStr === "[DONE]") continue;

            try {
                const chunk = JSON.parse(payloadStr);
                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;
                if (!delta) continue;

                // 累加文本内容
                if (typeof delta.content === "string") {
                    accumulatedContent += delta.content;
                    onDelta(delta.content);
                }

                // 累加工具调用片段
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const index = tc.index ?? 0;
                        if (!toolCallMap.has(index)) {
                            toolCallMap.set(index, {
                                id: tc.id || `call_${nanoid(8)}`,
                                name: tc.function?.name || "",
                                arguments: tc.function?.arguments || "",
                            });
                        } else {
                            const acc = toolCallMap.get(index)!;
                            if (tc.id) acc.id = tc.id;
                            if (tc.function?.name) acc.name += tc.function.name;
                            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                        }
                    }
                }
            } catch {
                // 容忍非 JSON 分块行
            }
        }
    }

    const toolCalls = Array.from(toolCallMap.values()).filter((tc) => tc.name.trim().length > 0);
    return { content: accumulatedContent, toolCalls };
}
