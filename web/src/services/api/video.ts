import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return config.channelMode === "remote" ? undefined : { Authorization: `Bearer ${config.apiKey}` };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string) {
    const created = await axios.post<VideoResponse>(aiApiUrl(config, "/videos"), { model: config.model, prompt, size: config.size || undefined }, { headers: { ...(aiHeaders(config) || {}), "Content-Type": "application/json" } });
    for (;;) {
        const video = await axios.get<VideoResponse>(aiApiUrl(config, `/videos/${created.data.id}`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: config.model } : undefined });
        if (video.data.status === "completed") break;
        if (video.data.status === "failed" || video.data.status === "cancelled") throw new Error(video.data.error?.message || "视频生成失败");
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${created.data.id}/content`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: config.model } : undefined, responseType: "blob" });
    return content.data;
}
