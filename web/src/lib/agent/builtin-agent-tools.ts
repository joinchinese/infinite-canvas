/**
 * 内置 Agent 的工具定义与系统提示词（OpenAI Function Calling 格式）。
 * 纯前端运行，直接对接浏览器内的画布状态与站点工具。
 */

export const BUILTIN_AGENT_SYSTEM_PROMPT = `你是 Infinite Canvas（无限画布）内置的 AI 智能助手。
你正在帮助用户操作当前打开的无限画布网页。

## 你的能力与规则
1. **画布感知**：需要了解当前画布内容、结构、节点时，优先使用 \`canvas_get_state\` 工具获取最新节点与连线快照。
2. **画布操作**：当用户要求创建、修改、连接、删除节点或生成内容时，使用 \`canvas_apply_ops\` 批量提交操作。
   - 节点类型（nodeType）：
     - "text": 文本节点。提示词、说明、脚本内容等。必须在 metadata.content 中填入文本内容。
     - "config": 生成配置节点。支持生图/视频/文本/音频。提示词写在 metadata.composerContent 中。
     - "image": 图片节点。
     - "video": 视频节点。
     - "audio": 音频节点。
   - **config 节点参数严格遵从（极其重要）**：
     - 当用户指定了画幅比例（例如 16:9、9:16、1:1、4:3、3:4、21:9 等）或生成张数（例如 1张、一张、2张等）时，必须严格将对应值写入 metadata.size 与 metadata.count 中，严禁忽略！
     - 示例：若用户要求“生成一张16:9的赛博朋克图”，则 config 节点 metadata 必须包含：\`{ composerContent: "...", size: "16:9", count: 1 }\`。
   - 节点尺寸（参考）：text 节点宽 280 高 160；config 节点宽 340 高 240。
   - 节点布局：创建多个节点时，注意排列坐标（x, y），从左往右或从上往下排列，避免完全重叠覆盖。
   - 工作流连线：如果要建立工作流（例如让提示词文本节点作为生图配置节点的输入），使用 connect_nodes 操作：{ type: "connect_nodes", fromNodeId, toNodeId }。
   - 触发生成：如果用户要求“开始生成”或“运行生成”，在 ops 中添加 { type: "run_generation", nodeId } 操作。
3. **工作台与辅助能力**：
   - 搜索提示词库：使用 \`prompts_search\`。
   - 查看我的素材库：使用 \`assets_list\`。
   - 页面导航跳转：使用 \`site_navigate\`（支持 /、/canvas、/image、/video、/prompts、/assets、/config）。
4. **回答风格**：
   - 执行操作时态度果断，直接调用相应工具，执行后简明扼要地向用户汇报你做了哪些变动（例如创建了哪些节点、连线情况、参数设置等）。
   - 始终使用中文交流。
`;

export const BUILTIN_AGENT_TOOLS = [
    {
        type: "function",
        function: {
            name: "canvas_get_state",
            description: "获取当前画布的最新状态，包括所有节点（ID、类型、标题、内容、坐标、尺寸、状态）以及节点之间的连线。在进行任何针对画布的修改前，先调用此工具了解画布现状。",
            parameters: {
                type: "object",
                properties: {},
            },
        },
    },
    {
        type: "function",
        function: {
            name: "canvas_apply_ops",
            description: "在当前画布上批量执行操作。支持添加节点、更新节点属性、删除节点、在节点之间连线、移动视口、触发节点开始生成等。",
            parameters: {
                type: "object",
                properties: {
                    ops: {
                        type: "array",
                        description: "要执行的画布操作列表，将按顺序一次性执行",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "set_viewport", "select_nodes", "run_generation"],
                                    description: "操作类型",
                                },
                                id: { type: "string", description: "节点ID或连线ID（创建时可由系统自动生成，也可自定）" },
                                ids: { type: "array", items: { type: "string" }, description: "批量删除或选择时的节点ID列表" },
                                nodeType: {
                                    type: "string",
                                    enum: ["image", "text", "config", "video", "audio"],
                                    description: "add_node 时的节点类型：text（文本）、config（生成配置）、image（图片）、video（视频）、audio（音频）",
                                },
                                title: { type: "string", description: "节点标题" },
                                x: { type: "number", description: "节点水平横坐标" },
                                y: { type: "number", description: "节点垂直纵坐标" },
                                width: { type: "number", description: "节点宽度（像素）" },
                                height: { type: "number", description: "节点高度（像素）" },
                                metadata: {
                                    type: "object",
                                    description: "节点的元数据内容。不同节点类型的关键字段：\n- text 节点：content (string, 文本内容)\n- config 节点：\n  - composerContent (string, 提示词内容)\n  - size (string, 画幅比例，如 '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'。当用户指定比例时必须设置！)\n  - count (number, 单次生成张数，通常 1 到 4。当用户指定张数时必须设置！)\n  - quality (string, 生成质量，如 'auto', 'standard', 'hd')\n  - model (string, 指定的生成模型)",
                                    properties: {
                                        content: { type: "string", description: "文本节点的正文内容" },
                                        composerContent: { type: "string", description: "配置节点的生成提示词" },
                                        size: {
                                            type: "string",
                                            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "auto"],
                                            description: "画幅比例。如用户要求 16:9，必须在此处传入 '16:9'，禁止忽略！",
                                        },
                                        count: {
                                            type: "number",
                                            description: "生成图片数量，通常 1 到 4 张。如用户指定 1 张，必须在此处传入 1！",
                                        },
                                        quality: {
                                            type: "string",
                                            enum: ["auto", "standard", "hd"],
                                            description: "画质质量等级",
                                        },
                                        model: {
                                            type: "string",
                                            description: "指定的生成模型 identifier",
                                        },
                                    },
                                },
                                patch: {
                                    type: "object",
                                    description: "update_node 时要更新的属性字段（如 title、position、width、height）",
                                },
                                fromNodeId: { type: "string", description: "connect_nodes 时的起始源节点 ID" },
                                toNodeId: { type: "string", description: "connect_nodes 时的目标节点 ID" },
                                nodeId: { type: "string", description: "run_generation 时的目标节点 ID" },
                                mode: { type: "string", enum: ["text", "image", "video", "audio"], description: "run_generation 时的生成模式" },
                                prompt: { type: "string", description: "run_generation 时的覆盖提示词" },
                            },
                            required: ["type"],
                        },
                    },
                },
                required: ["ops"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "site_navigate",
            description: "在站点不同页面之间进行路由跳转。",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "目标页面路径，例如 '/'、'/canvas'、'/image'、'/video'、'/prompts'、'/assets'、'/config'",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "prompts_search",
            description: "在提示词中心检索提示词模板。",
            parameters: {
                type: "object",
                properties: {
                    keyword: { type: "string", description: "搜索关键词" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "assets_list",
            description: "列出当前用户的素材/资产库列表。",
            parameters: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["image", "video", "audio", "text"], description: "筛选素材类型" },
                },
            },
        },
    },
] as const;
