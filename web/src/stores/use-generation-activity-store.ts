/**
 * 全局「正在生成」活动登记处。
 *
 * ## 为什么需要它
 *
 * 画布里的生成态（`runningNodeId`）是 `pages/canvas/project.tsx` 的**局部 state**，
 * 而静默同步引擎挂在应用根部。两者互相看不见，于是同步可能在图片正写到一半时
 * 去读本地资源、或在生成完成、资源刚落地但清单还没更新时把一份「半成品」推上远端。
 *
 * 这里不把 `runningNodeId` 提升为全局（那会牵动画布页几十处调用点、也更容易和上游冲突），
 * 而是反过来：由生成方**主动登记**一个计数器，同步方只读这个计数器。
 *
 * ## 为什么是计数器而不是布尔值
 *
 * 画布可以同时跑多个节点的生成（各节点各有 AbortController），Agent 面板也可能并发。
 * 用计数器（`begin`/`end` 成对调用）可以自然支持并发，且不会因为某个任务先结束
 * 就把布尔值错误地翻回 false。
 *
 * ## 保守策略：宁可晚同步，不要推半成品
 *
 * `end()` 之后不是立刻同步，而是先等一个静默窗口（见 `IDLE_SETTLE_MS`）——
 * 生成完成的瞬间，blob 写入 IndexedDB、ztore 更新、清单落盘之间还有异步间隙。
 * 这个窗口用来吸收那段间隙，代价仅仅是备份延后几秒。
 */

import { create } from "zustand";

/** 生成结束后额外等待的静默期：覆盖「blob 落盘 → store 更新」之间的异步间隙。 */
export const IDLE_SETTLE_MS = 8_000;

type GenerationActivityStore = {
    /** 正在进行的生成任务数。> 0 表示应用处于"忙"状态。 */
    activeCount: number;
    /** 最近一次生成结束的时间戳（用于计算静默期）。null 表示本次会话还没生成过。 */
    lastSettledAt: number | null;
    begin: () => void;
    end: () => void;
    /** 外部只需要读，不需要改；提供 reset 供登出时清理。 */
    reset: () => void;
};

export const useGenerationActivityStore = create<GenerationActivityStore>((set) => ({
    activeCount: 0,
    lastSettledAt: null,
    begin: () => set((state) => ({ activeCount: state.activeCount + 1 })),
    end: () =>
        set((state) => ({
            activeCount: Math.max(0, state.activeCount - 1),
            lastSettledAt: Date.now(),
        })),
    reset: () => set({ activeCount: 0, lastSettledAt: null }),
}));

/** 命令式读取（同步引擎在非 React 上下文里用）。 */
export function isGenerationBusy(): boolean {
    return useGenerationActivityStore.getState().activeCount > 0;
}

/**
 * 距离上次生成结束是否已经超过静默期。
 * 从未生成过时返回 true（首次备份不该被无谓地推迟）。
 */
export function isGenerationSettled(now: number = Date.now()): boolean {
    const { activeCount, lastSettledAt } = useGenerationActivityStore.getState();
    if (activeCount > 0) return false;
    if (lastSettledAt === null) return true;
    return now - lastSettledAt >= IDLE_SETTLE_MS;
}

/**
 * 把一个异步生成任务包起来，自动登记/注销。
 *
 * 用法：
 * ```ts
 * await trackGeneration(async () => { ...真正生成... });
 * ```
 * 用 `try/finally` 保证即使抛错也会注销，否则计数器会永久泄漏、静默同步再也不触发。
 */
export async function trackGeneration<T>(task: () => Promise<T>): Promise<T> {
    useGenerationActivityStore.getState().begin();
    try {
        return await task();
    } finally {
        useGenerationActivityStore.getState().end();
    }
}
