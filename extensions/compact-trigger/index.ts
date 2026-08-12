/**
 * Compact Trigger
 *
 * Headroom-based compaction trigger: "compact when X tokens of headroom remain"
 * instead of percentage-based thresholds. One setting works across all models.
 *
 * At agent_end, if usedTokens > contextWindow - headroomTokens, inflate
 * lastAssistant.usage.totalTokens past the context window. Pi's internal
 * compaction check then fires its normal pipeline, preserving the full native UX.
 *
 * Requires compaction.enabled: true in settings.json.
 * Requires blackhole extension for VCC summaries (optional, uses pi-default without it).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const DEFAULT_STATS: Omit<CompactStats, "modelId"> = {
    contextWindow: 0,
    count: 0,
    maxTokens: 0,
    totalTokens: 0,
};

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

function findLastAssistantMessage(messages: unknown[]): any | undefined {
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
    let lastAssistantMessageRef: any | undefined;
    let sessionId: string | undefined;

    // Pending stats for notification after compaction
    let pendingStats: CompactStats | undefined;

    // -- Session lifecycle -------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        lastAssistantMessageRef = undefined;
        lastCompactionMs = 0;
        lastNudgeMs = 0;
        pendingStats = undefined;
    });

    pi.on("session_tree", async (_event, _ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
        pendingStats = undefined;
    });

    pi.on("session_before_compact", async (_event, _ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
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

    // Capture the last assistant message reference
    pi.on("turn_end", async (event, _ctx) => {
        const msg = (event as any)?.message;
        if (!msg || msg.role !== "assistant") return;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
        if (!msg.usage) return;
        lastAssistantMessageRef = msg;
    });

    // Main trigger logic
    pi.on("agent_end", async (event, ctx) => {
        const now = Date.now();
        if (now - lastCompactionMs < COMPACTION_COOLDOWN_MS) {
            return;
        }

        const model = ctx.model;
        if (!model) return;

        const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const headroom = getHeadroom(config, model.id);
        const threshold = contextWindow - headroom;

        // Get actual token usage from the last assistant message
        const lastAssistant =
            lastAssistantMessageRef ??
            findLastAssistantMessage((event as any)?.messages ?? []);

        if (!lastAssistant?.usage?.totalTokens) return;

        const usedTokens = lastAssistant.usage.totalTokens;

        if (usedTokens < threshold) return;

        // Nudge cooldown (prevent double-triggering)
        const nudgeNow = Date.now();
        if (nudgeNow - lastNudgeMs < 5000) return;
        lastNudgeMs = nudgeNow;

        // Inflate tokens to force Pi's shouldCompact() to return true
        const forcedTokens = contextWindow + 1;
        lastAssistant.usage.totalTokens = Math.max(lastAssistant.usage.totalTokens, forcedTokens);

        if (!sessionId) return;

        // Update and persist stats (per-session)
        let stats = loadStats(sessionId);

        // Reset per-model stats if model/contextWindow changed
        if (stats.contextWindow !== contextWindow) {
            stats = {
                modelId: model.id,
                contextWindow,
                count: 0,
                maxTokens: 0,
                totalTokens: 0,
            };
        }

        stats.modelId = model.id;
        stats.count += 1;
        stats.maxTokens = Math.max(stats.maxTokens, usedTokens);
        stats.totalTokens += usedTokens;
        saveStats(sessionId, stats);

        // Queue notification for session_compact
        pendingStats = { ...stats };
    });
}
