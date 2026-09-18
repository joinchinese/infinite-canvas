import i18n from "@/i18n";
import { withResolvedWebdavDirectory, withLocalProxy, type WebdavSyncConfig } from "@/stores/use-config-store";

export const WEBDAV_MANIFEST_FILE_NAME = "manifest.json";
const WEBDAV_REQUEST_TIMEOUT_MS = 300000;
const ensuredDirectories = new Set<string>();
const webdavText = (key: string, options?: Record<string, unknown>) => i18n.t(`config.webdav.errors.${key}`, options);

/**
 * 统一出口：把「成员隔离段」固化进目录后再发请求。
 *
 * 隔离段由服务端下发（见 `worker/config.ts`），在这里收口意味着
 * `app-sync` / 配置弹窗 / 重新登录后的自动同步都不需要各自处理路径拼接，
 * 也就不可能出现某条链路漏拼、把成员数据写到共享根目录的情况。
 */
function scoped(config: WebdavSyncConfig): WebdavSyncConfig {
    return withResolvedWebdavDirectory(config);
}

export async function testWebdavConnection(config: WebdavSyncConfig) {
    await ensureWebdavDirectory(scoped(config));
    const response = await webdavFetch(scoped(config), "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (response.ok || response.status === 207) return;
    await throwWebdavError(response, webdavText("testFailed"));
}

export async function downloadWebdavSyncFile(config: WebdavSyncConfig) {
    return downloadWebdavFile(scoped(config), WEBDAV_MANIFEST_FILE_NAME);
}

export async function downloadWebdavFile(config: WebdavSyncConfig, path: string) {
    const target = scoped(config);
    await ensureWebdavDirectory(target);
    const response = await webdavFetch(target, path, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) await throwWebdavError(response, webdavText("downloadFailed"));
    const file = await withTimeout(response.blob(), webdavText("downloadTimeout"));
    return file.size ? file : null;
}

export async function uploadWebdavSyncFile(config: WebdavSyncConfig, file: Blob) {
    return uploadWebdavFile(scoped(config), WEBDAV_MANIFEST_FILE_NAME, file, "application/json");
}

export async function uploadWebdavFile(config: WebdavSyncConfig, path: string, file: Blob, contentType = "application/octet-stream") {
    if (!file.size) throw new Error(webdavText("emptyUpload"));
    const target = scoped(config);
    await ensureWebdavDirectory(target);
    await ensureWebdavSubdirectory(target, path);
    let response: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            response = await webdavFetch(target, path, {
                method: "PUT",
                headers: { "Content-Type": contentType },
                body: file,
            });
            if (response.status !== 423) {
                break;
            }
            // 如果遇到 423 Locked，等待 1.5 秒后自动重试
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
        } catch (err) {
            lastError = err;
            if (attempt < 2) {
                await new Promise((resolve) => window.setTimeout(resolve, 2000));
                continue;
            }
            throw err;
        }
    }
    if (!response || !response.ok) await throwWebdavError(response!, webdavText("uploadFailed"));
}

async function ensureWebdavDirectory(config: WebdavSyncConfig) {
    assertWebdavConfig(config);
    await ensureWebdavDirectoryPath(config, config.directory);
}

async function ensureWebdavSubdirectory(config: WebdavSyncConfig, path: string) {
    const directory = normalizePath(path).split("/").slice(0, -1).join("/");
    if (!directory) return;
    await ensureWebdavDirectoryPath(config, [config.directory, directory].filter(Boolean).join("/"));
}

async function ensureWebdavDirectoryPath(config: WebdavSyncConfig, directory: string) {
    const parts = normalizePath(directory).split("/").filter(Boolean);
    const cacheKey = `${config.url}:${parts.join("/")}`;
    if (ensuredDirectories.has(cacheKey)) return;
    let path = "";
    for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        const response = await webdavFetch({ ...config, directory: "" }, path, { method: "MKCOL" });
        if (response.ok || ((response.status === 405 || response.status === 423) && (await webdavDirectoryExists(config, path)))) continue;
        await throwWebdavError(response, webdavText("directoryFailed"));
    }
    ensuredDirectories.add(cacheKey);
}

async function webdavDirectoryExists(config: WebdavSyncConfig, path: string) {
    const response = await webdavFetch({ ...config, directory: "" }, path, { method: "PROPFIND", headers: { Depth: "0" } });
    return response.ok || response.status === 207;
}

/**
 * 列出远端目录下已有的物理文件及其大小（字节数）。
 * 用于同步前的增量断点比对，已存在且大小相同的文件自动秒级跳过，杜绝重复大文件上传。
 */
export async function listWebdavDirectoryFiles(config: WebdavSyncConfig, path: string): Promise<Map<string, number>> {
    const fileSizes = new Map<string, number>();
    try {
        const response = await webdavFetch(config, path, { method: "PROPFIND", headers: { Depth: "1" } });
        if (!response.ok && response.status !== 207) return fileSizes;
        const xml = await response.text();
        const responseBlocks = xml.split(/<\/[^:]*:response>/i);
        for (const block of responseBlocks) {
            if (!block.trim()) continue;
            // 目录自身排除
            if (/<[^:]*:collection\s*\/?>/i.test(block)) continue;
            const nameMatch = block.match(/<[^:]*:displayname[^>]*>([^<]+)<\/[^:]*:displayname>/i);
            const lenMatch = block.match(/<[^:]*:getcontentlength[^>]*>(\d+)<\/[^:]*:getcontentlength>/i);
            if (nameMatch && lenMatch) {
                const name = nameMatch[1].trim();
                const size = parseInt(lenMatch[1].trim(), 10);
                if (name && !Number.isNaN(size)) {
                    fileSizes.set(name, size);
                }
            }
        }
    } catch {
        // 探测失败时静默返回空 Map，平滑降级为常规流程
    }
    return fileSizes;
}

async function webdavFetch(config: WebdavSyncConfig, path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    const username = (config.username || "").trim();
    const password = (config.password || "").trim();
    if (username || password) headers.set("Authorization", `Basic ${encodeBasicAuth(`${username}:${password}`)}`);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), WEBDAV_REQUEST_TIMEOUT_MS);
    try {
        const rawUrl = buildWebdavUrl(config, path);
        const url = config.useProxy ? withLocalProxy(rawUrl) : rawUrl;
        return await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error(webdavText("requestTimeout"));
        if (error instanceof TypeError) throw new Error(webdavText("connectionFailed"));
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function buildWebdavUrl(config: WebdavSyncConfig, path: string) {
    const baseUrl = config.url.trim().replace(/\/+$/, "");
    const remotePath = [normalizePath(config.directory), normalizePath(path)].filter(Boolean).join("/");
    if (!remotePath) return baseUrl;
    return `${baseUrl}/${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizePath(path: string) {
    return path.trim().replace(/^\/+|\/+$/g, "");
}

function assertWebdavConfig(config: WebdavSyncConfig) {
    if (!config.url.trim()) throw new Error(webdavText("urlRequired"));
}

async function throwWebdavError(response: Response, fallback: string): Promise<never> {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) throw new Error(webdavText("authenticationFailed"));
    if (response.status === 404) throw new Error(webdavText("pathMissing"));
    throw new Error(webdavText("responseFailed", { fallback, status: response.status, detail: detail ? ` ${detail.slice(0, 120)}` : "" }));
}

function encodeBasicAuth(value: string) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, message: string) {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), WEBDAV_REQUEST_TIMEOUT_MS);
        promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
    });
}
