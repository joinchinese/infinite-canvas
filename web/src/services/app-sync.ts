import localforage from "localforage";

import i18n from "@/i18n";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { downloadWebdavFile, listWebdavDirectoryFiles, uploadWebdavFile, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { CanvasDeletedProject, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

type StoredLog = Record<string, unknown> & { id?: string };
export type AppSyncDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench";
type DomainKey = AppSyncDomainKey;
type CanvasDomainData = { projects: CanvasProject[]; deleted: CanvasDeletedProject[] };
type AssetDomainData = { assets: Asset[] };
type LogDomainData = { logs: StoredLog[] };

type AppSyncFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

type DomainManifest<T> = {
    app: "infinite-canvas";
    version: 1;
    domain: DomainKey;
    exportedAt: string;
    data: T;
    files: AppSyncFile[];
};

type SyncDomainOptions<T> = {
    key: DomainKey;
    label: string;
    localData: () => Promise<T>;
    emptyData: T;
    mergeData: (local: T, remote: T) => T;
    applyData?: (data: T) => Promise<void>;
};

type SyncDomainResult<T> = {
    data: T;
    mergedRemote: boolean;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncResult = {
    syncedAt: string;
    mergedRemote: boolean;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncProgressEvent = {
    domain?: AppSyncDomainKey;
    label?: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

export type AppSyncProgress = (event: AppSyncProgressEvent) => void;

const FILE_CONCURRENCY = 3;
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
type LogStore = typeof imageLogStore;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncAppDataToWebdav(config: WebdavSyncConfig, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore)]);

    const isSerial = config.syncMode === "serial";

    const [canvas, assets, imageLogs, videoLogs] = isSerial
        ? [
              await syncDomain<CanvasDomainData>(config, onProgress, {
                  key: "canvas",
                  label: "画布",
                  emptyData: { projects: [], deleted: [] },
                  localData: async () => {
                      const { projects, deletedProjects } = useCanvasStore.getState();
                      return { projects, deleted: deletedProjects };
                  },
                  mergeData: mergeCanvasData,
                  applyData: async (data) => useCanvasStore.getState().replaceProjects(data.projects, data.deleted),
              }),
              await syncDomain<AssetDomainData>(config, onProgress, {
                  key: "assets",
                  label: "我的资产",
                  emptyData: { assets: [] },
                  localData: async () => ({ assets: useAssetStore.getState().assets }),
                  mergeData: (local, remote) => ({ assets: mergeById(local.assets, remote.assets, "updatedAt") }),
                  applyData: async (data) => useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset))),
              }),
              await syncDomain<LogDomainData>(config, onProgress, {
                  key: "image-workbench",
                  label: "生图工作台",
                  emptyData: { logs: [] },
                  localData: async () => ({ logs: await readStoredLogs(imageLogStore) }),
                  mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
                  applyData: async (data) => replaceStoredLogs(imageLogStore, data.logs),
              }),
              await syncDomain<LogDomainData>(config, onProgress, {
                  key: "video-workbench",
                  label: "视频创作台",
                  emptyData: { logs: [] },
                  localData: async () => ({ logs: await readStoredLogs(videoLogStore) }),
                  mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
                  applyData: async (data) => replaceStoredLogs(videoLogStore, data.logs),
              }),
          ]
        : await Promise.all([
              syncDomain<CanvasDomainData>(config, onProgress, {
                  key: "canvas",
                  label: "画布",
                  emptyData: { projects: [], deleted: [] },
                  localData: async () => {
                      const { projects, deletedProjects } = useCanvasStore.getState();
                      return { projects, deleted: deletedProjects };
                  },
                  mergeData: mergeCanvasData,
                  applyData: async (data) => useCanvasStore.getState().replaceProjects(data.projects, data.deleted),
              }),
              syncDomain<AssetDomainData>(config, onProgress, {
                  key: "assets",
                  label: "我的资产",
                  emptyData: { assets: [] },
                  localData: async () => ({ assets: useAssetStore.getState().assets }),
                  mergeData: (local, remote) => ({ assets: mergeById(local.assets, remote.assets, "updatedAt") }),
                  applyData: async (data) => useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset))),
              }),
              syncDomain<LogDomainData>(config, onProgress, {
                  key: "image-workbench",
                  label: "生图工作台",
                  emptyData: { logs: [] },
                  localData: async () => ({ logs: await readStoredLogs(imageLogStore) }),
                  mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
                  applyData: async (data) => replaceStoredLogs(imageLogStore, data.logs),
              }),
              syncDomain<LogDomainData>(config, onProgress, {
                  key: "video-workbench",
                  label: "视频创作台",
                  emptyData: { logs: [] },
                  localData: async () => ({ logs: await readStoredLogs(videoLogStore) }),
                  mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
                  applyData: async (data) => replaceStoredLogs(videoLogStore, data.logs),
              }),
          ]);

    const result = {
        syncedAt: new Date().toISOString(),
        mergedRemote: [canvas, assets, imageLogs, videoLogs].some((item) => item.mergedRemote),
        projects: canvas.data.projects.length,
        assets: assets.data.assets.length,
        imageLogs: imageLogs.data.logs.length,
        videoLogs: videoLogs.data.logs.length,
        files: canvas.files + assets.files + imageLogs.files + videoLogs.files,
        manifestBytes: canvas.manifestBytes + assets.manifestBytes + imageLogs.manifestBytes + videoLogs.manifestBytes,
        uploadedFiles: canvas.uploadedFiles + assets.uploadedFiles + imageLogs.uploadedFiles + videoLogs.uploadedFiles,
        uploadedBytes: canvas.uploadedBytes + assets.uploadedBytes + imageLogs.uploadedBytes + videoLogs.uploadedBytes,
    };
    emitProgress(onProgress, { stage: "同步完成", status: "success" });
    return result;
}

async function syncDomain<T>(config: WebdavSyncConfig, onProgress: AppSyncProgress | undefined, options: SyncDomainOptions<T>): Promise<SyncDomainResult<T>> {
    try {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取远端清单", status: "active" });
        const remoteManifest = await readDomainManifest(config, options.key, options.emptyData);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
        const localData = await options.localData();
        const mergedData = remoteManifest ? options.mergeData(localData, remoteManifest.data) : localData;

        if (remoteManifest) {
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "下载缺失媒体", status: "active" });
            await downloadMissingFiles(config, options.key, mergedData, remoteManifest.files, onProgress);
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "写入本地合并结果", status: "active" });
            await options.applyData?.(mergedData);
        }

        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "上传新增媒体", status: "active" });
        const uploaded = await uploadChangedFiles(config, options.key, mergedData, remoteManifest?.files || [], onProgress);
        const manifest: DomainManifest<T> = { app: "infinite-canvas", version: 1, domain: options.key, exportedAt: new Date().toISOString(), data: mergedData, files: uploaded.files };
        const manifestFile = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: `上传清单 ${formatBytes(manifestFile.size)}`, status: "active" });
        await uploadWebdavFile(config, domainPath(options.key, WEBDAV_MANIFEST_FILE_NAME), manifestFile, "application/json");
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });

        return {
            data: mergedData,
            mergedRemote: Boolean(remoteManifest),
            files: uploaded.files.length,
            manifestBytes: manifestFile.size,
            uploadedFiles: uploaded.uploadedFiles,
            uploadedBytes: uploaded.uploadedBytes,
        };
    } catch (error) {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: error instanceof Error ? error.message : i18n.t("config.webdav.errors.syncFailed"), status: "exception" });
        throw error;
    }
}

/**
 * 读取某一个业务域的远端清单。
 *
 * ## 为什么 domain 对不上时"降级"而不是"报错"
 *
 * 原实现是直接抛 `invalidManifest`。这在单人手动同步的年代没什么问题——报错了人去看看就行。
 * 但改成**无感静默备份**之后，这个异常会变成致命的：一个坏文件会让该业务域的备份
 * **永久失败**，而且因为是静默的，用户根本不知道自己的资产一直没备份上。
 *
 * 实际上 domain 对不上只有三种来路，没有一种是"用户的真实数据"：
 *
 * 1. 网盘/OpenList 侧在目录里自动生成了同名文件；
 * 2. 上一次写入被中断，留下半截 JSON（`JSON.parse` 成功但字段缺失）；
 * 3. 改造前旧的目录结构残留（共享根目录 → 成员子目录迁移时遗留）。
 *
 * 三种情况下正确做法都是：**当作远端没有清单**，用本地数据重新建立一份并覆盖上去，
 * 下一次同步就自愈了。抛错则会让它一直卡住——这才是真正会丢数据的路径。
 *
 * 注意 `JSON.parse` 失败也走同一条自愈路径（`file` 读到了但不是合法 JSON）。
 */
async function readDomainManifest<T>(config: WebdavSyncConfig, domain: DomainKey, emptyData: T): Promise<DomainManifest<T> | null> {
    const file = await downloadWebdavFile(config, domainPath(domain, WEBDAV_MANIFEST_FILE_NAME));
    if (!file) return null;
    let data: DomainManifest<T>;
    try {
        data = JSON.parse(await file.text()) as DomainManifest<T>;
    } catch {
        // 半截 JSON / 非本应用写的内容：忽略远端，用本地重建。
        return null;
    }
    if (!data || data.app !== "infinite-canvas" || data.domain !== domain) return null;
    return {
        app: "infinite-canvas",
        version: 1,
        domain,
        exportedAt: data.exportedAt || new Date().toISOString(),
        data: data.data || emptyData,
        files: Array.isArray(data.files) ? data.files : [],
    };
}

async function downloadMissingFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: AppSyncFile[] = [];
    const storageKeys = collectStorageKeys(data);
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const localBlob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        scanned += 1;
        if (localBlob) {
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
            continue;
        }
        const remoteFile = remoteFileMap.get(storageKey);
        if (remoteFile) tasks.push(remoteFile);
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
    }
    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体已齐全", current: 1, total: 1, status: "active" });
        return;
    }
    let downloaded = 0;
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async (remoteFile) => {
        const blob = await downloadWebdavFile(config, remoteFile.path);
        if (!blob) return;
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, remoteFile.mimeType);
        await (remoteFile.storageKey.startsWith("image:") ? setImageBlob(remoteFile.storageKey, typedBlob) : setMediaBlob(remoteFile.storageKey, typedBlob));
        downloaded += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", current: downloaded, total: tasks.length, status: "active" });
    });
}

async function uploadChangedFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const files: AppSyncFile[] = [];
    const tasks: Array<{ item: AppSyncFile; blob: Blob }> = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;

    // 预先探测远端 files/ 目录下已有的物理文件（断点秒传：若开启增量断点秒传，已存在且大小一致的文件永不重复上传）
    const shouldSkipExisting = config.skipExistingFiles !== false;
    const filesDir = domainPath(domain, "files");
    const existingRemoteFiles = shouldSkipExisting ? await listWebdavDirectoryFiles(config, filesDir) : new Map<string, number>();

    const storageKeys = collectStorageKeys(data);
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const remoteFile = remoteFileMap.get(storageKey);
        if (!blob) {
            if (remoteFile) files.push(remoteFile);
            scanned += 1;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
            continue;
        }
        const fileName = `${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
        const filePath = domainPath(domain, `files/${fileName}`);
        const item: AppSyncFile = {
            storageKey,
            path: remoteFile?.path || filePath,
            mimeType: blob.type || remoteFile?.mimeType || "application/octet-stream",
            bytes: blob.size,
        };
        files.push(item);
        const isMatchedInManifest = Boolean(remoteFile && remoteFile.bytes === blob.size);
        const isMatchedOnServer = shouldSkipExisting && existingRemoteFiles.get(fileName) === blob.size;
        if (!isMatchedInManifest && !isMatchedOnServer) {
            tasks.push({ item, blob });
        }
        scanned += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
    }

    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体无需上传", current: 1, total: 1, status: "active" });
        return { files, uploadedFiles, uploadedBytes };
    }

    // 依据配置的并发模式调度：serial 模式单并发防网盘锁冲突；默认或 concurrent 模式恢复原版 FILE_CONCURRENCY (3) 并发
    const concurrency = config.syncMode === "serial" ? 1 : FILE_CONCURRENCY;
    await runWithConcurrency(tasks, concurrency, async ({ item, blob }) => {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `正在上传 (${uploadedFiles + 1}/${tasks.length}) · ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
        await uploadWebdavFile(config, item.path, blob, item.mimeType);
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `已上传 (${uploadedFiles}/${tasks.length}) · ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
    });

    return { files, uploadedFiles, uploadedBytes };
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
    }
    return asset;
}

async function readStoredLogs(store: LogStore) {
    const logs: StoredLog[] = [];
    await store.iterate<StoredLog, void>((value) => {
        if (value && typeof value === "object") logs.push(value);
    });
    return logs;
}

async function replaceStoredLogs(store: LogStore, logs: StoredLog[]) {
    await store.clear();
    await runWithConcurrency(logs, FILE_CONCURRENCY, async (log) => {
        const id = getStringField(log, "id");
        if (id) await store.setItem(id, log);
    });
}

function mergeCanvasData(local: CanvasDomainData, remote: CanvasDomainData): CanvasDomainData {
    const localDeleted = local.deleted || [];
    const remoteDeleted = remote.deleted || [];
    const deletedAtById = new Map<string, string>();
    for (const item of [...remoteDeleted, ...localDeleted]) {
        if (!item.id || !item.deletedAt) continue;
        const current = deletedAtById.get(item.id);
        if (!current || item.deletedAt >= current) deletedAtById.set(item.id, item.deletedAt);
    }

    const projects = mergeById(local.projects || [], remote.projects || [], "updatedAt").filter((project) => {
        const deletedAt = deletedAtById.get(project.id);
        if (!deletedAt) return true;
        if (getTime(project as Record<string, unknown>, "updatedAt") > Date.parse(deletedAt)) {
            deletedAtById.delete(project.id);
            return true;
        }
        return false;
    });

    return {
        projects,
        deleted: [...deletedAtById.entries()].map(([id, deletedAt]) => ({ id, deletedAt })),
    };
}

function mergeById<T extends { id?: string }>(local: T[], remote: T[], timeKey: string) {
    const items = new Map<string, T>();
    remote.forEach((item) => {
        const id = item.id || "";
        if (id) items.set(id, item);
    });
    local.forEach((item) => {
        const id = item.id || "";
        if (!id) return;
        const current = items.get(id);
        if (!current || getTime(item as Record<string, unknown>, timeKey) >= getTime(current as Record<string, unknown>, timeKey)) items.set(id, item);
    });
    return Array.from(items.values()).sort((a, b) => getTime(b as Record<string, unknown>, timeKey) - getTime(a as Record<string, unknown>, timeKey));
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) keys.add(value);
        return [...keys];
    }
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function domainPath(domain: DomainKey, path: string) {
    return `${domain}/${path}`;
}

function domainLabel(domain: DomainKey) {
    if (domain === "canvas") return "画布";
    if (domain === "assets") return "我的资产";
    if (domain === "image-workbench") return "生图工作台";
    return "视频创作台";
}

function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) {
    onProgress?.(event);
}

function getStringField(item: Record<string, unknown>, key: string) {
    const value = item[key];
    return typeof value === "string" ? value : "";
}

function getTime(item: Record<string, unknown>, key: string) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value) || 0;
    return 0;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }),
    );
    return results;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
