# 画布数据结构

本文档说明当前画布在前端本地保存的数据结构、图片文件的存储和清理方式，以及后续接入后端存储时建议保持的兼容边界。

## 当前存储位置

当前画布项目主要保存在浏览器本地：

- 画布项目 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`，key 为 `infinite-canvas:canvas_store`。
- 我的素材 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`，key 为 `infinite-canvas:asset_store`。
- 图片 Blob：单独存到 `localForage` 实例，数据库名 `infinite-canvas`，storeName `image_files`。
- 视频等媒体 Blob：单独存到 `localForage` 实例，数据库名 `infinite-canvas`，storeName `media_files`。

画布 JSON 不直接长期保存大体积 base64 图片或视频。图片节点、视频节点、助手图片和素材媒体只保存展示 URL、`storageKey` 和元信息，真实 Blob 通过 `storageKey` 读取。

## 画布项目结构

每个画布项目是一个 `CanvasProject`：

```ts
type CanvasProject = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNodeData[];
  connections: CanvasConnection[];
  chatSessions: CanvasAssistantSession[];
  activeChatId: string | null;
  backgroundMode: "lines" | "dots" | "blank";
  viewport: { x: number; y: number; k: number };
};
```

字段说明：

- `id`：画布项目 ID，当前前端生成。
- `title`：画布名称。
- `createdAt` / `updatedAt`：ISO 字符串。
- `nodes`：画布节点列表。
- `connections`：节点连线列表。
- `chatSessions`：右侧画布助手会话。
- `activeChatId`：当前选中的助手会话 ID。
- `backgroundMode`：画布背景模式。
- `viewport`：视口变换，`x/y` 是屏幕平移，`k` 是缩放比例。

## 节点结构

每个节点是一个 `CanvasNodeData`：

```ts
type CanvasNodeData = {
  id: string;
  type: "image" | "text" | "config" | "video";
  title: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};
```

通用字段：

- `id`：节点 ID。
- `type`：节点类型，当前有图片、文本、生成配置、视频四类。
- `title`：节点标题。
- `position`：画布世界坐标，不是屏幕坐标。
- `width` / `height`：画布世界坐标下的节点尺寸。
- `metadata`：节点内容和业务状态。

`metadata` 当前常用字段：

```ts
type CanvasNodeMetadata = {
  content?: string;
  prompt?: string;
  status?: "idle" | "success" | "loading" | "error";
  errorDetails?: string;
  fontSize?: number;
  generationMode?: "text" | "image" | "video";
  model?: string;
  size?: string;
  count?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  inputOrder?: string[];
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
};
```

不同节点的使用方式：

- 图片节点：`content` 是当前可展示的图片 URL，通常是 `blob:` URL；`storageKey` 指向本地图片 Blob；`naturalWidth/naturalHeight/bytes/mimeType` 保存原图信息。
- 视频节点：`content` 是当前可播放的视频 URL，通常是 `blob:` URL；`storageKey` 指向本地视频 Blob；`bytes/mimeType` 保存文件信息。
- 文本节点：`content` 保存文本内容；`fontSize` 保存字体大小；`prompt/status/errorDetails` 保存生成状态。
- 生成配置节点：`generationMode/model/size/count/inputOrder` 保存生成配置；`generationMode` 可选择文本、图片或视频；上游输入通过 `connections` 计算。
- 图片组节点：根节点用 `isBatchRoot/batchChildIds/primaryImageId/imageBatchExpanded` 记录批量生成结果；子图节点用 `batchRootId` 指回根节点。

## 连线结构

每条连线是一个 `CanvasConnection`：

```ts
type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};
```

连线只保存节点 ID，不保存端口坐标。渲染时根据节点位置和尺寸计算路径。

删除节点时会同步删除以该节点为起点或终点的连线。删除图片组根节点时，会把对应子节点一起删除。

## 助手会话结构

助手会话保存在画布项目内：

```ts
type CanvasAssistantSession = {
  id: string;
  title: string;
  messages: CanvasAssistantMessage[];
  createdAt: string;
  updatedAt: string;
};
```

消息结构：

```ts
type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  mode: "ask" | "image";
  text: string;
  isLoading?: boolean;
  references?: CanvasAssistantReference[];
  images?: CanvasAssistantImage[];
};
```

图片引用和助手生成图片也遵循同一套图片存储规则：

- `dataUrl` 字段当前可能是 `blob:` URL，也可能是旧数据中的 `data:image/...`。
- `storageKey` 存在时，以 `storageKey` 为准读取图片 Blob。
- 发送到 AI 接口前，如果接口需要 base64，会通过 `imageToDataUrl` 临时把 Blob URL 转成 data URL。

## 图片写入流程

所有新增图片应通过 `uploadImage(input)` 写入：

1. 传入 `Blob` 或 data URL。
2. 内部转成 `Blob`。
3. 生成 `storageKey`，格式为 `image:<id>`。
4. 把 Blob 写入 `image_files`。
5. 创建 `blob:` URL，并缓存在内存 `objectUrls`。
6. 读取图片宽高，返回：

```ts
type UploadedImage = {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};
```

图片节点会通过 `imageMetadata(image)` 写入：

```ts
{
  content: image.url,
  storageKey: image.storageKey,
  status: "success",
  naturalWidth: image.width,
  naturalHeight: image.height,
  bytes: image.bytes,
  mimeType: image.mimeType
}
```

因此，`content` 只适合当前浏览器会话展示，不能作为长期文件标识；长期标识是 `storageKey`。

## 图片读取和旧数据迁移

打开画布时会执行图片补水：

- 如果图片节点有 `storageKey`，通过 `resolveImageUrl(storageKey, fallback)` 读取 Blob 并生成新的 `blob:` URL。
- 如果图片节点没有 `storageKey`，但 `content` 是旧的 `data:image/...`，会调用 `uploadImage(content)` 迁移到 `image_files`，并补上 `storageKey`。
- 助手消息里的引用图和生成图也会执行同类逻辑。

我的素材读取时也会做迁移：

- 有 `storageKey`：恢复 `coverUrl` 和 `data.dataUrl` 的可展示 URL。
- 无 `storageKey` 且保存了 base64：写入 `image_files`，然后更新素材里的 `storageKey`。

## 图片移除和清理

图片不是在删除节点时立即按节点逐张删除，而是做引用清理：

1. 删除节点、清空画布、删除画布、删除素材、删除助手会话时，会触发 `cleanupImages`。
2. `cleanupImages` 会收集当前仍被画布项目、素材和额外传入数据引用的所有 `storageKey`。
3. `cleanupUnusedImages` 遍历 `image_files` 中的全部图片。
4. 不在引用集合里的图片会被删除。
5. 删除时会同时 `URL.revokeObjectURL`，并从内存缓存 `objectUrls` 移除。

这套方式可以避免同一张图片被画布、素材或助手同时引用时误删。

需要注意：

- 只要某个 JSON 结构里仍有 `storageKey`，清理逻辑就会认为图片仍被使用。
- `collectImageStorageKeys` 会递归扫描对象中的 `storageKey` 字段，字段值必须以 `image:` 开头才会被当成本地图片。
- 如果后续新增保存图片引用的数据结构，也要确保它能传入清理上下文，或者位于现有项目/素材结构内。

## 后端存储兼容建议

后续接入后端时，建议保持“画布 JSON”和“图片文件”分离：

- 画布表保存项目元信息和画布 JSON。
- 文件表保存图片文件、访问 URL、哈希、大小、MIME、宽高、归属用户等信息。
- 画布节点中继续保存轻量图片引用，不把图片二进制或 base64 写进画布 JSON。

建议图片引用逐步扩展为兼容本地和云端的结构：

```ts
type ImageRef = {
  storageKey?: string;
  fileId?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
};
```

兼容规则：

- 本地旧数据：有 `storageKey`，无 `fileId`，通过 IndexedDB 读取。
- 已上传后端：有 `fileId`，展示时优先使用后端返回的签名 URL 或公开 URL。
- 迁移过渡期：可以同时保留 `storageKey` 和 `fileId`；确认云端文件可用后，再按清理策略删除本地 Blob。
- `content/dataUrl/coverUrl` 仍只作为当前可展示 URL，不作为稳定 ID。

建议读取优先级：

1. 有 `fileId`：向后端换取可访问 URL。
2. 有 `storageKey`：从本地 IndexedDB 生成 `blob:` URL。
3. 有旧 `data:image/...`：先写入本地图片存储，再视需要上传后端。
4. 只有普通 URL：直接展示，但不要假设可长期访问。

建议删除策略：

- 删除节点只删除画布 JSON 引用，不直接删除后端文件。
- 后端文件删除应按引用计数或定期扫描未引用文件处理。
- 保存到“我的素材”的图片，即使原画布节点删除，也应继续保留文件引用。
- 删除画布、删除素材、删除助手会话后，再由后端清理任务判断文件是否无人引用。

建议同步流程：

1. 前端保存画布 JSON 时，保持节点 ID、连线 ID、`storageKey/fileId` 不变。
2. 遇到只有 `storageKey` 的图片，后台同步前先上传 Blob，得到 `fileId`。
3. 上传成功后给对应图片引用补 `fileId` 和云端元信息。
4. 服务端保存更新后的画布 JSON。
5. 前端下次打开时优先走 `fileId`，本地 `storageKey` 只作为缓存或离线回退。

## 后续改动约束

- 不要把新生成的大图直接长期写入画布 JSON。
- 新增图片来源时统一走 `uploadImage` 或未来的文件上传服务。
- 新增图片引用字段时，应保留 `storageKey` 兼容旧本地数据。
- 新增清理入口时，要把仍需保留的画布、素材、助手数据传给 `cleanupUnusedImages`。
- 后端同步完成前，文档和 UI 不要写成已支持云同步。
