import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";

export type MyPromptItem = {
    id: string;
    title: string;
    prompt: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
};

type MyPromptStore = {
    hydrated: boolean;
    prompts: MyPromptItem[];
    addPrompt: (item: { title: string; prompt: string; tags?: string[] }) => string;
    updatePrompt: (id: string, patch: Partial<Pick<MyPromptItem, "title" | "prompt" | "tags">>) => void;
    removePrompt: (id: string) => void;
    importPrompts: (items: MyPromptItem[]) => void;
};

const MY_PROMPTS_STORE_KEY = "infinite-canvas:my_prompts_store";

const INITIAL_PROMPTS: MyPromptItem[] = [
    {
        id: "preset-photo",
        title: "电影感写实摄影",
        prompt: "Cinematic film still, 35mm photograph, shot on Kodak Portra 400, natural lighting, highly detailed, photorealistic, 8k resolution, masterpiece",
        tags: ["写实", "摄影", "光影"],
        createdAt: Date.now() - 3600000,
        updatedAt: Date.now() - 3600000,
    },
    {
        id: "preset-anime",
        title: "精美日系二次元",
        prompt: "Masterpiece, best quality, ultra-detailed anime illustration, Makoto Shinkai style, vibrant colors, beautiful lighting, cinematic composition",
        tags: ["二次元", "插画", "动漫"],
        createdAt: Date.now() - 7200000,
        updatedAt: Date.now() - 7200000,
    },
];

const storage: PersistStorage<MyPromptStore> = {
    getItem: async (name) => {
        const raw = await localForageStorage.getItem(name);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useMyPromptStore = create<MyPromptStore>()(
    persist(
        (set) => ({
            hydrated: false,
            prompts: INITIAL_PROMPTS,
            addPrompt: ({ title, prompt, tags = [] }) => {
                const id = `prompt_${nanoid(8)}`;
                const now = Date.now();
                const newItem: MyPromptItem = {
                    id,
                    title: title.trim() || "未命名提示词",
                    prompt: prompt.trim(),
                    tags: tags.map((t) => t.trim()).filter(Boolean),
                    createdAt: now,
                    updatedAt: now,
                };
                set((state) => ({ prompts: [newItem, ...state.prompts] }));
                return id;
            },
            updatePrompt: (id, patch) => {
                const now = Date.now();
                set((state) => ({
                    prompts: state.prompts.map((item) =>
                        item.id === id
                            ? {
                                  ...item,
                                  ...patch,
                                  ...(patch.title !== undefined ? { title: patch.title.trim() || item.title } : {}),
                                  ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() || item.prompt } : {}),
                                  ...(patch.tags !== undefined ? { tags: patch.tags.map((t) => t.trim()).filter(Boolean) } : {}),
                                  updatedAt: now,
                              }
                            : item,
                    ),
                }));
            },
            removePrompt: (id) => {
                set((state) => ({ prompts: state.prompts.filter((item) => item.id !== id) }));
            },
            importPrompts: (items) => {
                set((state) => {
                    const existingIds = new Set(state.prompts.map((p) => p.id));
                    const newItems = items.filter((p) => !existingIds.has(p.id));
                    return { prompts: [...state.prompts, ...newItems] };
                });
            },
        }),
        {
            name: MY_PROMPTS_STORE_KEY,
            storage,
            partialize: (state) => ({ prompts: state.prompts } as MyPromptStore),
            onRehydrateStorage: () => () => {
                useMyPromptStore.setState({ hydrated: true });
            },
        },
    ),
);
