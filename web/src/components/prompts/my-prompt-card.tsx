import { memo } from "react";
import { Button, Popconfirm, Tag, Tooltip } from "antd";
import { Copy, Edit2, Sparkles, Trash2 } from "lucide-react";

import type { MyPromptItem } from "@/stores/use-my-prompt-store";

type MyPromptCardProps = {
    item: MyPromptItem;
    onSelect?: () => void;
    onCopy?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    compact?: boolean;
};

export const MyPromptCard = memo(function MyPromptCard({
    item,
    onSelect,
    onCopy,
    onEdit,
    onDelete,
    compact = false,
}: MyPromptCardProps) {
    return (
        <div
            className={`group relative flex flex-col justify-between rounded-xl border border-stone-200 bg-white/70 p-3 shadow-sm backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-stone-400 hover:shadow-md dark:border-stone-800 dark:bg-stone-900/60 dark:hover:border-stone-600 ${
                onSelect ? "cursor-pointer" : ""
            }`}
            onClick={onSelect}
        >
            <div>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <Sparkles className="size-3.5 shrink-0 text-amber-500" />
                        <h3 className="truncate text-xs font-semibold text-stone-900 dark:text-stone-100" title={item.title}>
                            {item.title}
                        </h3>
                    </div>

                    {/* 操作按钮组 */}
                    <div
                        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {onCopy ? (
                            <Tooltip title="复制提示词">
                                <Button
                                    type="text"
                                    size="small"
                                    className="!size-6 !p-0 text-stone-500 hover:text-stone-900 dark:hover:text-stone-200"
                                    icon={<Copy className="size-3" />}
                                    onClick={onCopy}
                                />
                            </Tooltip>
                        ) : null}
                        {onEdit ? (
                            <Tooltip title="编辑">
                                <Button
                                    type="text"
                                    size="small"
                                    className="!size-6 !p-0 text-stone-500 hover:text-stone-900 dark:hover:text-stone-200"
                                    icon={<Edit2 className="size-3" />}
                                    onClick={onEdit}
                                />
                            </Tooltip>
                        ) : null}
                        {onDelete ? (
                            <Popconfirm
                                title="确认删除此提示词？"
                                onConfirm={onDelete}
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true, size: "small" }}
                                cancelButtonProps={{ size: "small" }}
                            >
                                <Button
                                    type="text"
                                    size="small"
                                    className="!size-6 !p-0 text-stone-500 hover:text-red-500"
                                    icon={<Trash2 className="size-3" />}
                                />
                            </Popconfirm>
                        ) : null}
                    </div>
                </div>

                <p
                    className={`mt-2 font-mono text-[11px] leading-relaxed text-stone-600 dark:text-stone-400 ${
                        compact ? "line-clamp-3" : "line-clamp-4"
                    }`}
                    title={item.prompt}
                >
                    {item.prompt}
                </p>
            </div>

            {item.tags && item.tags.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                        <Tag key={tag} className="m-0 border-0 bg-stone-100 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-400">
                            {tag}
                        </Tag>
                    ))}
                </div>
            ) : null}
        </div>
    );
});
