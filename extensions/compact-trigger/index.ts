/**
 * Compact Trigger
 *
 * Headroom-based compaction trigger: "compact when X tokens of headroom remain"
 * instead of percentage-based thresholds. One setting works across all models.
 *
 * At turn_end (after every assistant message), if usedTokens > contextWindow - headroomTokens,
 * inflate lastAssistant.usage.totalTokens past the context window. Pi's internal
 * compaction check then fires its normal pipeline, preserving the full native UX.
 *
 * Uses ctx.getContextUsage() for context estimation (same as pi-model-aware-compaction).
 * Uses session_before_compact preparation.tokensBefore for accurate stats reporting.
 *
 * Requires compaction.enabled: true in settings.json.
 * Requires blackhole extension for VCC summaries (optional, uses pi-default without it).
 */

import {
    buildSessionContext,
    estimateTokens,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HEADROOM = 20000;
const DEFAULT_CONTEXT_WINDOW = 128000;
const COMPACTION_COOLDOWN_MS = 30000;

interface CompactConfig {
    headroomTokens: number;
    models: Record<string, number>;
}

interface CompactStats {
    modelId: string;
    contextWindow: number;
    count: number;
    maxTokens: number;
    totalTokens: number;
}

interface InflationRecord {
    sessionId: string;
    offset: number;
}

const DEFAULT_STATS: Omit<CompactStats, "modelId"> = {
    contextWindow: 0,
    count: 0,
    maxTokens: 0,
    totalTokens: 0,
};

function inflationPath(sessionId: string): string {
    return join(tmpdir(), `pi-compact-trigger-inflation-${sessionId}.json`);
}

function saveInflationOffset(sessionId: string, offset: number): void {
    try {
        writeFileSync(
            inflationPath(sessionId),
            JSON.stringify({ sessionId, offset } as InflationRecord) + "\n",
            "utf-8",
        );
    } catch {
        // ignore
    }
}

function loadAndClearInflationOffset(sessionId: string): number | null {
    try {
        const path = inflationPath(sessionId);
        if (existsSync(path)) {
            const data = JSON.parse(readFileSync(path, "utf-8"));
            if (data.sessionId === sessionId && typeof data.offset === "number") {
                try { writeFileSync(path, "\n", "utf-8"); } catch { /* ignore */ }
                return data.offset;
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function statsPath(sessionId: string): string {
    return join(tmpdir(), `pi-compact-trigger-${sessionId}.json`);
}

function loadStats(sessionId: string): CompactStats {
    try {
        const path = statsPath(sessionId);
        if (existsSync(path)) {
            const data = JSON.parse(readFileSync(path, "utf-8"));
            return {
                modelId: typeof data.modelId === "string" ? data.modelId : "",
                contextWindow: typeof data.contextWindow === "number" ? data.contextWindow : 0,
                count: typeof data.count === "number" ? data.count : 0,
                maxTokens: typeof data.maxTokens === "number" ? data.maxTokens : 0,
                totalTokens: typeof data.totalTokens === "number" ? data.totalTokens : 0,
            };
        }
    } catch {
        // ignore
    }
    return { ...DEFAULT_STATS, modelId: "" };
}

function saveStats(sessionId: string, stats: CompactStats): void {
    try {
        writeFileSync(statsPath(sessionId), JSON.stringify(stats, null, 2) + "\n", "utf-8");
    } catch {
        // ignore write errors
    }
}

function loadConfig(): CompactConfig {
    try {
        const extensionDir = dirname(fileURLToPath(import.meta.url));
        const configPath = join(extensionDir, "config.json");
        const parsed = JSON.parse(readFileSync(configPath, "utf-8"));

        return {
            headroomTokens:
                typeof parsed.headroomTokens === "number" ? parsed.headroomTokens : DEFAULT_HEADROOM,
            models:
                typeof parsed.models === "object" && parsed.models !== null
                    ? (parsed.models as Record<string, number>)
                    : {},
        };
    } catch {
        return { headroomTokens: DEFAULT_HEADROOM, models: {} };
    }
}

function getHeadroom(config: CompactConfig, modelId: string): number {
    if (config.models[modelId] !== undefined) {
        return typeof config.models[modelId] === "number"
            ? config.models[modelId]
            : config.headroomTokens;
    }

    for (const [pattern, value] of Object.entries(config.models)) {
        if (!pattern.includes("*")) continue;

        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");

        if (regex.test(modelId)) {
            return typeof value === "number" ? value : config.headroomTokens;
        }
    }

    return config.headroomTokens;
}

/**
 * Get accumulated context tokens — mirrors pi-model-aware-compaction approach.
 * Primary: ctx.getContextUsage() — Pi's own calculation from session messages.
 * Fallback: buildSessionContext + estimateTokens from Pi SDK.
 */
function getUsedTokens(ctx: ExtensionContext): number | null {
    // Primary: use Pi's built-in context usage calculator
    const usage = ctx.getContextUsage();
    if (usage?.tokens != null)
        return usage.tokens;

    // Fallback: estimate from session messages using Pi's estimateTokens
    try {
        const sessionContext = buildSessionContext(
            ctx.sessionManager.getEntries(),
            ctx.sessionManager.getLeafId(),
        );
        return sessionContext.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    } catch {
        return null;
    }
}

/** Fallback when turn_end didn't capture a reference (e.g., extension loaded mid-session) */
function findLastNonErrorAssistantMessage(messages: unknown[]): any | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] as any;
        if (!msg || msg.role !== "assistant") continue;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
        if (!msg.usage) continue;
        return msg;
    }
    return undefined;
}

function formatNotification(count: number, maxTokens: number, avgTokens: number, contextWindow: number): string {
    return `compact: ${count}x, max ${maxTokens.toLocaleString()} / avg ${Math.round(avgTokens).toLocaleString()} of ${contextWindow.toLocaleString()}`;
}

export default function (pi: ExtensionAPI) {
    const config = loadConfig();

    let lastCompactionMs = 0;
    let lastNudgeMs = 0;
    let sessionId: string | undefined;

    // Best-effort reference to the last assistant message object used by Pi's internal compaction check
    let lastAssistantMessageRef: any | undefined;

    // Pending stats for notification after compaction.
    // Set by session_before_compact — the single source of truth for accurate stats.
    let pendingStats: CompactStats | undefined;

    // Inflation offset from the last turn_end/agent_end inflation.
    // When we inflate msg.usage.totalTokens, getUsedTokens() includes the inflation
    // in its count. The offset = forcedTokens - originalTotalTokens. Subtract it
    // from getUsedTokens() to get the real context usage.
    let lastInflationOffset: number | undefined;

    // -- Session lifecycle -------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        lastAssistantMessageRef = undefined;
        lastCompactionMs = 0;
        lastNudgeMs = 0;
        pendingStats = undefined;
        lastInflationOffset = undefined;
    });

    pi.on("session_tree", async (_event, _ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
        pendingStats = undefined;
        lastInflationOffset = undefined;
    });

    pi.on("session_before_compact", async (event, ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;

        // Single source of truth for stats.
        // Use ctx.getContextUsage() — Pi's own real-time calculation — for accuracy.
        // preparation.tokensBefore rebuilds from session entries and can be inflated
        // by large tool results (e.g. reading session files), producing false estimates.
        const usedTokens = getUsedTokens(ctx);
        if (usedTokens == null) return;
        if (!sessionId) return;

        const model = ctx.model;
        if (!model) return;

        const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;

        // Record ALL compactions — both self-triggered (via our inflation) and
        // Pi's internal percentage-based compaction. The threshold check belongs
        // only in turn_end/agent_end (where we decide whether to inflate).
        // getUsedTokens() includes the inflation we added to msg.usage.totalTokens.
        // offset = forcedTokens - originalTotalTokens. Real = reported - offset.
        let inflationOffset = 0;
        if (lastInflationOffset != null) {
            inflationOffset = lastInflationOffset;
            lastInflationOffset = undefined;
        } else if (sessionId) {
            const fileOffset = loadAndClearInflationOffset(sessionId);
            if (fileOffset != null) inflationOffset = fileOffset;
        }

        const realUsedTokens = Math.max(0, usedTokens - inflationOffset);

        let stats = loadStats(sessionId);
        if (stats.contextWindow !== contextWindow) {
            stats = { modelId: model.id, contextWindow, count: 0, maxTokens: 0, totalTokens: 0 };
        }
        stats.modelId = model.id;
        stats.count += 1;
        stats.maxTokens = Math.max(stats.maxTokens, realUsedTokens);
        stats.totalTokens += realUsedTokens;
        saveStats(sessionId, stats);

        // Queue notification for session_compact
        pendingStats = { ...stats };
    });

    pi.on("session_compact", async (_event, ctx) => {
        lastCompactionMs = Date.now();
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;

        if (pendingStats && ctx.hasUI) {
            try {
                const avg = pendingStats.count > 0
                    ? pendingStats.totalTokens / pendingStats.count
                    : 0;
                ctx.ui.setStatus(
                    "compact-trigger",
                    formatNotification(
                        pendingStats.count,
                        pendingStats.maxTokens,
                        avg,
                        pendingStats.contextWindow,
                    ),
                );
            } catch {
                // ignore UI errors
            }
        }
        pendingStats = undefined;
    });

    // turn_end: fires after EVERY assistant message (including tool-use responses).
    // Captures the message ref AND checks context for inflation trigger.
    // This catches context growth during tool-use loops before overflow.
    pi.on("turn_end", async (event, ctx) => {
        const msg = event?.message;
        if (!msg || msg.role !== "assistant") return;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
        if (!msg.usage) return;

        // Capture reference for inflation
        lastAssistantMessageRef = msg;

        const model = ctx.model;
        if (!model) return;

        const now = Date.now();
        if (now - lastCompactionMs < COMPACTION_COOLDOWN_MS) return;

        const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const headroom = getHeadroom(config, model.id);
        const threshold = contextWindow - headroom;

        // Get actual accumulated context tokens
        const usedTokens = getUsedTokens(ctx);
        if (usedTokens == null || usedTokens < threshold) return;

        // Nudge cooldown (prevent double-triggering)
        const nudgeNow = Date.now();
        if (nudgeNow - lastNudgeMs < 5000) return;
        lastNudgeMs = nudgeNow;

        // Inflate tokens to force Pi's shouldCompact()
        const originalTotalTokens = msg.usage.totalTokens ?? 0;
        const forcedTokens = contextWindow + 1;
        msg.usage.totalTokens = Math.max(originalTotalTokens, forcedTokens);

        // Remember the inflation offset so session_before_compact can subtract it
        // from getUsedTokens() to get real usage.
        const inflationOffset = forcedTokens - originalTotalTokens;
        lastInflationOffset = inflationOffset;
        if (sessionId) saveInflationOffset(sessionId, inflationOffset);
    });

    // agent_end: final check when the agent loop exits.
    // Uses event.messages (full array) as fallback if turn_end didn't capture the ref.
    pi.on("agent_end", async (event, ctx) => {
        const model = ctx.model;
        if (!model) return;

        const now = Date.now();
        if (now - lastCompactionMs < COMPACTION_COOLDOWN_MS) return;

        const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const headroom = getHeadroom(config, model.id);
        const threshold = contextWindow - headroom;

        const usedTokens = getUsedTokens(ctx);
        if (usedTokens == null || usedTokens < threshold) return;

        const nudgeNow = Date.now();
        if (nudgeNow - lastNudgeMs < 5000) return;
        lastNudgeMs = nudgeNow;

        // Inflate last assistant message's totalTokens
        const lastAssistant =
            lastAssistantMessageRef ?? findLastNonErrorAssistantMessage((event as any)?.messages ?? []);
        if (!lastAssistant) return;

        const originalTotalTokens = lastAssistant.usage.totalTokens ?? 0;
        const forcedTokens = contextWindow + 1;
        lastAssistant.usage.totalTokens = Math.max(originalTotalTokens, forcedTokens);

        // Remember the inflation offset (same reason as turn_end)
        const inflationOffset = forcedTokens - originalTotalTokens;
        lastInflationOffset = inflationOffset;
        if (sessionId) saveInflationOffset(sessionId, inflationOffset);
    });
}
