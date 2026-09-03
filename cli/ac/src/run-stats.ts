import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** One name plus how many times it appeared, sorted by count descending then name ascending. */
export interface NameCount {
    readonly count: number;
    readonly name: string;
}

/** Cost anatomy of a single main-thread run, derived from its session transcript. */
export interface RunStats {
    /** Distinct assistant message ids. One id is one API round trip. */
    readonly turns: number;
    /** Billed output tokens, summed once per message id. */
    readonly outputTokens: number;
    /** Cache-read tokens, summed once per message id. This is where an agentic run spends. */
    readonly cacheReadTokens: number;
    /** Mean resident context per turn: `cacheReadTokens / turns`. */
    readonly avgContext: number;
    /** Largest single-turn resident context. */
    readonly peakContext: number;
    /** Times resident context fell off a cliff, which is what auto-compaction looks like. */
    readonly compactions: number;
    /** Every `tool_use` block, counted per block rather than per message. */
    readonly toolCalls: readonly NameCount[];
    /** Sum of `toolCalls`. */
    readonly totalToolCalls: number;
    /** `Agent` spawns rolled up by `subagent_type`. */
    readonly agentSpawns: readonly NameCount[];
}

/** Per-agent-type rollup across the `subagents/` directory beside a session transcript. */
export interface AgentRollup {
    readonly agentType: string;
    readonly runs: number;
    readonly avgTurns: number;
    readonly avgOutputTokens: number;
    readonly avgCacheReadTokens: number;
}

interface Usage {
    readonly cacheRead: number;
    readonly output: number;
}

// A compaction is a collapse, not a drift. Requiring the prior turn to be substantial keeps a small
// run's ordinary fluctuation from reading as a compaction.
const COMPACTION_FLOOR = 100_000;

// A single turn reporting zero or near-zero cache read is common and is NOT a compaction: it is a
// fresh cache segment, and the very next turn resumes at the old level or higher. Measured on one
// 389-turn run, the drop test alone flagged 13 events where only one was real. What separates them
// is persistence, so the level has to STAY down across the following turns to count.
const COMPACTION_WINDOW = 6;

/** Sorts by count descending, then by name ascending so the output is stable across runs. */
function toSortedCounts(counts: Map<string, number>): NameCount[] {
    return [...counts.entries()]
        .map(([name, count]): NameCount => ({ count, name }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Derives the cost anatomy of a run from its raw transcript lines.
 *
 * Two counting rules pull in opposite directions and getting either backwards silently corrupts
 * every number downstream. Claude Code writes ONE LINE PER CONTENT BLOCK, repeating the message id
 * and the identical usage object on each line. So usage must be summed once per message id, and
 * tool calls must be counted once per block. A single dedupe strategy applied to both is wrong
 * whichever one you pick.
 *
 * @param lines Raw JSONL lines from a session transcript. Unparseable lines are skipped.
 * @returns The aggregated statistics for the run.
 */
export function computeRunStats(lines: readonly string[]): RunStats {
    // 1. Fold the transcript once, keeping usage keyed by id and tool blocks counted in full.
    const usageById = new Map<string, Usage>();
    const contextSeries: number[] = [];
    const toolCounts = new Map<string, number>();
    const agentCounts = new Map<string, number>();

    for (const line of lines) {
        const record = parseRecord(line);
        if (record === undefined) {
            continue;
        }

        const id = record.id;
        if (id !== undefined && !usageById.has(id) && record.usage !== undefined) {
            usageById.set(id, record.usage);
            contextSeries.push(record.usage.cacheRead);
        } else if (id !== undefined && !usageById.has(id)) {
            // An assistant record with no usage block still cost a round trip, so it counts as a
            // turn. Recording it with zeroes keeps the turn count honest without inventing tokens.
            usageById.set(id, { cacheRead: 0, output: 0 });
        }

        for (const block of record.toolUses) {
            bump(toolCounts, block.name);
            if (block.name === "Agent" && block.subagentType !== undefined) {
                bump(agentCounts, block.subagentType);
            }
        }
    }

    // 2. Reduce the per-id usage into the headline totals.
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let peakContext = 0;
    for (const usage of usageById.values()) {
        outputTokens += usage.output;
        cacheReadTokens += usage.cacheRead;
        peakContext = Math.max(peakContext, usage.cacheRead);
    }

    // 3. Walk the context series for collapses that persist.
    let compactions = 0;
    for (let i = 1; i < contextSeries.length; i += 1) {
        const previous = contextSeries[i - 1] ?? 0;
        const current = contextSeries[i] ?? 0;
        if (previous < COMPACTION_FLOOR || current >= previous / 2) {
            continue;
        }
        let windowMax = 0;
        const end = Math.min(i + COMPACTION_WINDOW, contextSeries.length);
        for (let j = i; j < end; j += 1) {
            windowMax = Math.max(windowMax, contextSeries[j] ?? 0);
        }
        if (windowMax < previous / 2) {
            compactions += 1;
        }
    }

    const turns = usageById.size;
    const toolCalls = toSortedCounts(toolCounts);
    return {
        agentSpawns: toSortedCounts(agentCounts),
        avgContext: turns === 0 ? 0 : Math.round(cacheReadTokens / turns),
        cacheReadTokens,
        compactions,
        outputTokens,
        peakContext,
        toolCalls,
        totalToolCalls: toolCalls.reduce((sum, entry) => sum + entry.count, 0),
        turns,
    };
}

interface ParsedRecord {
    readonly id: string | undefined;
    readonly usage: Usage | undefined;
    readonly toolUses: readonly { name: string; subagentType: string | undefined }[];
}

/** Parses one transcript line, returning undefined for anything that is not an assistant turn. */
function parseRecord(line: string): ParsedRecord | undefined {
    if (line.trim() === "") {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        // A truncated final line is normal on a live transcript; it is not worth failing the run.
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record["type"] !== "assistant") {
        return undefined;
    }

    const message = record["message"];
    if (typeof message !== "object" || message === null) {
        return undefined;
    }
    const messageRecord = message as Record<string, unknown>;

    const rawId = messageRecord["id"];
    const id = typeof rawId === "string" ? rawId : undefined;

    return {
        id,
        toolUses: readToolUses(messageRecord["content"]),
        usage: readUsage(messageRecord["usage"]),
    };
}

function readUsage(raw: unknown): Usage | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    const usage = raw as Record<string, unknown>;
    const output = usage["output_tokens"];
    const cacheRead = usage["cache_read_input_tokens"];
    return {
        cacheRead: typeof cacheRead === "number" ? cacheRead : 0,
        output: typeof output === "number" ? output : 0,
    };
}

function readToolUses(raw: unknown): { name: string; subagentType: string | undefined }[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const out: { name: string; subagentType: string | undefined }[] = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const block = entry as Record<string, unknown>;
        if (block["type"] !== "tool_use" || typeof block["name"] !== "string") {
            continue;
        }
        const input = block["input"];
        const subagentType = typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)["subagent_type"]
            : undefined;
        out.push({
            name: block["name"],
            subagentType: typeof subagentType === "string" ? subagentType : undefined,
        });
    }
    return out;
}

function formatCounts(entries: readonly NameCount[], indent: string): string[] {
    const width = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
    return entries.map((entry) => `${indent}${entry.name.padEnd(width)}  ${entry.count}`);
}

/** Renders a run's statistics as the block the redesign work compares against. */
export function formatRunStats(stats: RunStats, rollup: readonly AgentRollup[] = []): string {
    const lines = [
        `Turns: ${stats.turns}`,
        `Output tokens: ${stats.outputTokens}`,
        `Cache-read tokens: ${stats.cacheReadTokens}`,
        `Average context: ${stats.avgContext}`,
        `Peak context: ${stats.peakContext}`,
        `Compactions: ${stats.compactions}`,
        `Tool calls: ${stats.totalToolCalls}`,
        ...formatCounts(stats.toolCalls, "  "),
    ];

    if (stats.agentSpawns.length > 0) {
        lines.push("Agent spawns:", ...formatCounts(stats.agentSpawns, "  "));
    }

    if (rollup.length > 0) {
        lines.push("Subagent rollup (runs / avg turns / avg output / avg cache-read):");
        for (const entry of rollup) {
            lines.push(
                `  ${entry.agentType}  ${entry.runs}  ${entry.avgTurns}  `
                    + `${entry.avgOutputTokens}  ${entry.avgCacheReadTokens}`,
            );
        }
    }

    return lines.join("\n");
}

/**
 * Rolls the `subagents/` directory beside a transcript up by agent type.
 *
 * Each subagent run is a `<id>.jsonl` with a sibling `<id>.meta.json` naming its `agentType`, so the
 * per-tier cost of a run is measurable without opening the main transcript at all.
 *
 * @param transcriptPath Absolute path to the main session transcript.
 * @returns One entry per agent type, busiest first. Empty when the directory does not exist.
 */
export function computeAgentRollup(transcriptPath: string): AgentRollup[] {
    const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
    const subagentsDir = join(dirname(transcriptPath), sessionId, "subagents");

    let entries: string[];
    try {
        entries = readdirSync(subagentsDir);
    } catch {
        // A run that spawned nothing has no directory. That is a real answer, not a failure.
        return [];
    }

    const byType = new Map<string, { cacheRead: number; output: number; runs: number; turns: number }>();
    for (const entry of entries) {
        if (!entry.endsWith(".meta.json")) {
            continue;
        }
        const agentType = readAgentType(join(subagentsDir, entry));
        if (agentType === undefined) {
            continue;
        }
        const transcript = join(subagentsDir, entry.replace(/\.meta\.json$/, ".jsonl"));
        let stats: RunStats;
        try {
            stats = computeRunStats(readFileSync(transcript, "utf8").split("\n"));
        } catch {
            continue;
        }
        const bucket = byType.get(agentType) ?? { cacheRead: 0, output: 0, runs: 0, turns: 0 };
        byType.set(agentType, {
            cacheRead: bucket.cacheRead + stats.cacheReadTokens,
            output: bucket.output + stats.outputTokens,
            runs: bucket.runs + 1,
            turns: bucket.turns + stats.turns,
        });
    }

    return [...byType.entries()]
        .map(([agentType, bucket]): AgentRollup => ({
            agentType,
            avgCacheReadTokens: Math.round(bucket.cacheRead / bucket.runs),
            avgOutputTokens: Math.round(bucket.output / bucket.runs),
            avgTurns: Math.round((bucket.turns / bucket.runs) * 10) / 10,
            runs: bucket.runs,
        }))
        .sort((a, b) => b.runs - a.runs);
}

function readAgentType(metaPath: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const agentType = (parsed as Record<string, unknown>)["agentType"];
        return typeof agentType === "string" ? agentType : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolves a bare session id, or passes a path straight through.
 *
 * The id form is the common one: it is what the transcript filename, the sibling `subagents/`
 * directory and every telemetry event key on, and it is what the CLI prints in a resume hint.
 *
 * @param sessionOrPath A session id, or a path containing a separator.
 * @param projectsRoot The `projects` directory to scan when given an id.
 * @returns An absolute or relative path to the transcript.
 * @throws When the projects root is unreadable, or no project holds that session.
 */
export function resolveTranscriptPath(sessionOrPath: string, projectsRoot: string): string {
    if (sessionOrPath.includes("/")) {
        return sessionOrPath;
    }

    const id = sessionOrPath.replace(/\.jsonl$/, "");
    let projects: string[];
    try {
        projects = readdirSync(projectsRoot);
    } catch {
        throw new Error(`Projects root is not readable: ${projectsRoot}`);
    }

    for (const project of projects) {
        const candidate = join(projectsRoot, project, `${id}.jsonl`);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`No transcript found for session ${id} under ${projectsRoot}`);
}

/** Reads a transcript from disk and renders its statistics, including the subagent rollup. */
export function runRunStats(transcriptPath: string): string {
    const text = readFileSync(transcriptPath, "utf8");
    const stats = computeRunStats(text.split("\n"));
    return formatRunStats(stats, computeAgentRollup(transcriptPath));
}
