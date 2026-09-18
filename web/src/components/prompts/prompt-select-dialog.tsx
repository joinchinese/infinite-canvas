import { Plus, Search, Sparkles, Star } from "lucide-react";
import { type UIEvent, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { useMyPromptStore, type MyPromptItem } from "@/stores/use-my-prompt-store";
import { MyPromptCard } from "./my-prompt-card";
import { MyPromptModal } from "./my-prompt-modal";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [tab, setTab] = useState<"custom" | "preset">("custom");

    // 我的词库状态
    const myPrompts = useMyPromptStore((state) => state.prompts);
    const removeMyPrompt = useMyPromptStore((state) => state.removePrompt);
    const addMyPrompt = useMyPromptStore((state) => state.addPrompt);
    const [myKeyword, setMyKeyword] = useState("");
    const [mySelectedTag, setMySelectedTag] = useState<string>("all");
    const [modalOpen, setModalOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<MyPromptItem | null>(null);

    // 预设词库状态
    const [presetKeyword, setPresetKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({
        keyword: presetKeyword,
        tags: selectedTags,
        category: selectedCategory,
        enabled: open && tab === "preset",
    });

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    const collectToMyPrompts = (item: Prompt) => {
        addMyPrompt({
            title: item.title,
            prompt: item.prompt,
            tags: item.tags || [],
        });
        message.success("已收藏到我的词库！");
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void query.fetchNextPage();
        }
    };

    // 我的词库标签去重
    const allMyTags = useMemo(() => {
        const set = new Set<string>();
        myPrompts.forEach((p) => p.tags?.forEach((tag) => set.add(tag)));
        return Array.from(set);
    }, [myPrompts]);

    // 我的词库过滤
    const filteredMyPrompts = useMemo(() => {
        const q = myKeyword.trim().toLowerCase();
        return myPrompts.filter((item) => {
            const matchesTag = mySelectedTag === "all" || item.tags?.includes(mySelectedTag);
            const matchesQuery = !q || item.title.toLowerCase().includes(q) || item.prompt.toLowerCase().includes(q);
            return matchesTag && matchesQuery;
        });
    }, [myPrompts, myKeyword, mySelectedTag]);

    return (
        <>
            <Modal
                title={
                    <div className="flex items-center justify-between pr-8">
                        <span className="text-base font-semibold">{t("prompts.library")}</span>
                        <Segmented
                            value={tab}
                            onChange={(val) => setTab(val as "custom" | "preset")}
                            options={[
                                { label: `我的词库 (${myPrompts.length})`, value: "custom" },
                                { label: "灵感预设", value: "preset" },
                            ]}
                            className="bg-stone-100 dark:bg-stone-800"
                        />
                    </div>
                }
                open={open}
                onCancel={() => onOpenChange(false)}
                footer={null}
                width={880}
                centered
            >
                {tab === "custom" ? (
                    <div className="grid h-[62dvh] min-h-0 gap-5 sm:grid-cols-[180px_minmax(0,1fr)]" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                        <aside className="thin-scrollbar min-h-0 overflow-y-auto border-r border-stone-200 pr-3 dark:border-stone-800">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">标签分类</div>
                            <div className="flex flex-wrap gap-1.5">
                                <Tag.CheckableTag
                                    checked={mySelectedTag === "all"}
                                    className={cn("prompt-filter-tag", mySelectedTag === "all" && "is-active")}
                                    onChange={() => setMySelectedTag("all")}
                                >
                                    全部
                                </Tag.CheckableTag>
                                {allMyTags.map((tag) => (
                                    <Tag.CheckableTag
                                        key={tag}
                                        checked={mySelectedTag === tag}
                                        className={cn("prompt-filter-tag", mySelectedTag === tag && "is-active")}
                                        onChange={() => setMySelectedTag(tag)}
                                    >
                                        {tag}
                                    </Tag.CheckableTag>
                                ))}
                            </div>
                        </aside>

                        <section className="flex min-h-0 min-w-0 flex-col">
                            <div className="flex items-center gap-2">
                                <Input
                                    size="middle"
                                    prefix={<Search className="size-4 text-stone-400" />}
                                    value={myKeyword}
                                    onChange={(e) => setMyKeyword(e.target.value)}
                                    placeholder="搜索我的自定义提示词..."
                                    allowClear
                                />
                                <Button
                                    type="primary"
                                    icon={<Plus className="size-3.5" />}
                                    onClick={() => {
                                        setEditingItem(null);
                                        setModalOpen(true);
                                    }}
                                >
                                    新建
                                </Button>
                            </div>

                            <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-1" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                                {filteredMyPrompts.length > 0 ? (
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        {filteredMyPrompts.map((item) => (
                                            <MyPromptCard
                                                key={item.id}
                                                item={item}
                                                onSelect={() => selectPrompt(item.prompt)}
                                                onEdit={() => {
                                                    setEditingItem(item);
                                                    setModalOpen(true);
                                                }}
                                                onDelete={() => removeMyPrompt(item.id)}
                                                compact
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <Empty
                                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                                        description="暂无自定义提示词，点击右上角「新建」添加"
                                        className="py-12"
                                    />
                                )}
                            </div>
                        </section>
                    </div>
                ) : (
                    <div className="grid h-[62dvh] min-h-0 gap-5 sm:grid-cols-[200px_minmax(0,1fr)]" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                        <aside className="thin-scrollbar min-h-0 overflow-y-auto border-r border-stone-200 pr-4 dark:border-stone-800">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.category")}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {promptCategories.map((category) => (
                                    <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                        {category === ALL_PROMPTS_OPTION ? t("common.all") : category}
                                    </Tag.CheckableTag>
                                ))}
                            </div>
                            <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.tags")}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {promptTags.map((tag) => {
                                    const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                    return (
                                        <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                            {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
                                        </Tag.CheckableTag>
                                    );
                                })}
                            </div>
                        </aside>
                        <section className="flex min-h-0 min-w-0 flex-col">
                            <Input size="middle" prefix={<Search className="size-4 text-stone-400" />} value={presetKeyword} onChange={(event) => setPresetKeyword(event.target.value)} placeholder={t("prompts.searchTitle")} allowClear />
                            <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                                {query.isLoading ? (
                                    <div className="flex h-40 items-center justify-center">
                                        <Spin />
                                    </div>
                                ) : null}
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                    {items.map((item) => (
                                        <PromptCard
                                            key={item.id}
                                            item={item}
                                            onOpen={() => selectPrompt(item.prompt)}
                                            onCopy={() => selectPrompt(item.prompt)}
                                            extraAction={
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    icon={<Star className="size-3 text-amber-500" />}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        collectToMyPrompts(item);
                                                    }}
                                                >
                                                    收藏
                                                </Button>
                                            }
                                            compact
                                        />
                                    ))}
                                </div>
                                {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                                {query.isFetchingNextPage ? (
                                    <div className="py-4 text-center">
                                        <Spin size="small" />
                                    </div>
                                ) : null}
                            </div>
                        </section>
                    </div>
                )}
            </Modal>

            <MyPromptModal
                open={modalOpen}
                initialData={editingItem}
                onClose={() => {
                    setModalOpen(false);
                    setEditingItem(null);
                }}
            />
        </>
    );
}
