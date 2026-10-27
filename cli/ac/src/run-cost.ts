import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTurns } from "./run-stats.ts";
import type { Turn, Usage } from "./run-stats.ts";

/**
 * Per-MTok USD rates for one model: input, output, cache read, five-minute and one-hour cache writes.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-27.
 */
interface Rates {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite5m: number;
    readonly cacheWrite1h: number;
}

// Haiku 5.5 is the one model whose rate depends on the request: a prompt over 100k tokens, cache reads
// and writes included, pays five times the base rates.
const HAIKU_5_5_PROMPT_LIMIT = 100_000;
const HAIKU_5_5_LARGE: Rates = {
    cacheRead: 0.05,
    cacheWrite1h: 1,
    cacheWrite5m: 0.625,
    input: 0.5,
    output: 2.5,
};

// Matched by substring in this order, most specific first: `claude-opus-5` is a prefix of `claude-opus-5-5`.
// The family fallbacks are the Opus 4.5 to 5, Sonnet 4.5 and 4.6, and Fable 5 rates; Opus 4.1 and older,
// retired, would price low.
const RATES: readonly (readonly [string, Rates])[] = [
    ["haiku-5-5", { cacheRead: 0.01, cacheWrite1h: 0.2, cacheWrite5m: 0.125, input: 0.1, output: 0.5 }],
    ["haiku-4-5", { cacheRead: 0.1, cacheWrite1h: 2, cacheWrite5m: 1.25, input: 1, output: 5 }],
    ["fable-5-1", { cacheRead: 0.25, cacheWrite1h: 20, cacheWrite5m: 12.5, input: 10, output: 50 }],
    ["fable", { cacheRead: 1, cacheWrite1h: 20, cacheWrite5m: 12.5, input: 10, output: 50 }],
    ["opus-5-5", { cacheRead: 0.2, cacheWrite1h: 8, cacheWrite5m: 5, input: 4, output: 20 }],
    ["opus", { cacheRead: 0.5, cacheWrite1h: 10, cacheWrite5m: 6.25, input: 5, output: 25 }],
    ["sonnet-5-5", { cacheRead: 0.1, cacheWrite1h: 4, cacheWrite5m: 2.5, input: 2, output: 10 }],
    ["sonnet-5", { cacheRead: 0.2, cacheWrite1h: 4, cacheWrite5m: 2.5, input: 2, output: 10 }],
    ["sonnet", { cacheRead: 0.3, cacheWrite1h: 6, cacheWrite5m: 3.75, input: 3, output: 15 }],
];

// A subagent's cache lives five minutes. A turn that comes later than that and writes at least half
// its context again is a rebuild the TTL caused, not new content.
const IDLE_GAP_MS = 5 * 60 * 1000;
const REBUILD_SHARE = 0.5;

/**
 * Prices one API round trip in USD.
 *
 * Models the table does not name (the `<synthetic>` placeholder, a third-party id) price at zero rather
 * than at a guessed family rate. An older model in a known family prices at that family's current rate.
 */
export function priceTurn(model: string, usage: Usage): number {
    const rates = RATES.find(([key]) => model.includes(key))?.[1];
    if (rates === undefined) {
        return 0;
    }

    const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    const applied = model.includes("haiku-5-5") && prompt > HAIKU_5_5_PROMPT_LIMIT ? HAIKU_5_5_LARGE : rates;

    return (
        usage.input * applied.input
        + usage.output * applied.output
        + usage.cacheRead * applied.cacheRead
        + usage.cacheWrite5m * applied.cacheWrite5m
        + usage.cacheWrite1h * applied.cacheWrite1h
    ) / 1_000_000;
}

/** One agent type's, or the main thread's, rolled-up cost over the window. */
export interface CostRow {
    readonly name: string;
    readonly runs: number;
    readonly turns: number;
    readonly usage: Usage;
    readonly dollars: number;
    /** Active minutes: the gaps between consecutive turns, counting only those within the idle threshold. */
    readonly minutes: number;
    /** Cache-write tokens spent on turns that rebuilt the context after an idle gap past the TTL. */
    readonly idleRebuildTokens: number;
}

export interface RunCostReport {
    readonly since: string;
    readonly sessions: number;
    readonly main: CostRow;
    /** Subagent rows, most expensive first. */
    readonly rows: readonly CostRow[];
}

export interface RunCostOptions {
    /** The Claude Code `projects` directory. */
    readonly root: string;
    /** First day counted, `YYYY-MM-DD`, compared against each turn's UTC timestamp. */
    readonly since: string;
    /** Keep only project directories whose name contains this substring. */
    readonly project?: string;
    /** Count sessions that spawned no `ac:` agent too. */
    readonly allSessions?: boolean;
}

interface Bucket {
    runs: number;
    turns: number;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    dollars: number;
    minutes: number;
    idleRebuildTokens: number;
}

function emptyBucket(): Bucket {
    return {
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        dollars: 0,
        idleRebuildTokens: 0,
        input: 0,
        minutes: 0,
        output: 0,
        runs: 0,
        turns: 0,
    };
}

/** Folds one run's turns into a bucket. Returns false when no turn falls inside the window. */
function addRun(bucket: Bucket, turns: readonly Turn[], since: string): boolean {
    const kept = turns.filter((turn) => turn.timestamp.slice(0, 10) >= since);
    if (kept.length === 0) {
        return false;
    }

    let previousAt: number | undefined;
    for (const turn of kept) {
        const { usage } = turn;
        const at = Date.parse(turn.timestamp);
        const written = usage.cacheWrite5m + usage.cacheWrite1h;
        const context = usage.cacheRead + written;
        const gap = previousAt === undefined || Number.isNaN(at) ? undefined : at - previousAt;
        if (gap !== undefined && gap > IDLE_GAP_MS && written >= context * REBUILD_SHARE) {
            bucket.idleRebuildTokens += written;
        }
        if (gap !== undefined && gap <= IDLE_GAP_MS) {
            bucket.minutes += gap / 60_000;
        }
        previousAt = Number.isNaN(at) ? previousAt : at;

        bucket.turns += 1;
        bucket.input += usage.input;
        bucket.cacheRead += usage.cacheRead;
        bucket.cacheWrite5m += usage.cacheWrite5m;
        bucket.cacheWrite1h += usage.cacheWrite1h;
        bucket.output += usage.output;
        bucket.dollars += priceTurn(turn.model, usage);
    }

    bucket.runs += 1;

    return true;
}

function toRow(name: string, bucket: Bucket): CostRow {
    return {
        dollars: bucket.dollars,
        idleRebuildTokens: bucket.idleRebuildTokens,
        minutes: bucket.minutes,
        name,
        runs: bucket.runs,
        turns: bucket.turns,
        usage: {
            cacheRead: bucket.cacheRead,
            cacheWrite1h: bucket.cacheWrite1h,
            cacheWrite5m: bucket.cacheWrite5m,
            input: bucket.input,
            output: bucket.output,
        },
    };
}

function listDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        // A project with no sessions, or a session that spawned nothing: an empty answer, not a failure.
        return [];
    }
}

function readLines(path: string): string[] {
    try {
        return readFileSync(path, "utf8").split("\n");
    } catch {
        return [];
    }
}

function readAgentType(metaPath: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
        const agentType = typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)["agentType"]
            : undefined;
        return typeof agentType === "string" ? agentType : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Rolls up what ac runs cost across every session transcript under the projects root.
 *
 * A session counts when it spawned at least one `ac:` subagent (or always, with `allSessions`), and its
 * main thread is then counted whole: the orchestrator's turns cannot be told apart from the user's other
 * work in the same session, so the main row is an upper bound on what the workflows cost there.
 */
export function collectRunCost(options: RunCostOptions): RunCostReport {
    const main = emptyBucket();
    const byType = new Map<string, Bucket>();
    const seen = new Set<string>();
    let sessions = 0;

    // A resumed or forked session copies earlier messages into its own transcript under the same ids.
    const unseen = (path: string): Turn[] => readTurns(readLines(path)).filter((turn) => {
        if (seen.has(turn.id)) {
            return false;
        }
        seen.add(turn.id);
        return true;
    });

    for (const project of listDir(options.root)) {
        if (options.project !== undefined && !project.includes(options.project)) {
            continue;
        }
        const projectDir = join(options.root, project);

        for (const entry of listDir(projectDir)) {
            if (!entry.endsWith(".jsonl")) {
                continue;
            }
            const session = entry.slice(0, -".jsonl".length);
            const subagentsDir = join(projectDir, session, "subagents");

            // 1. Pair every subagent transcript with the agent type its meta file names.
            const runs = listDir(subagentsDir)
                .filter((name) => name.endsWith(".meta.json"))
                .map((name) => ({
                    agentType: readAgentType(join(subagentsDir, name)),
                    transcript: join(subagentsDir, name.replace(/\.meta\.json$/, ".jsonl")),
                }));
            const ranAcAgent = runs.some((run) => run.agentType?.startsWith("ac:") === true);
            if (!ranAcAgent && options.allSessions !== true) {
                continue;
            }

            // 2. Fold the subagents and the main thread, each limited to the window.
            let counted = false;
            for (const run of runs) {
                if (run.agentType === undefined) {
                    continue;
                }
                const turns = unseen(run.transcript);
                // Split a type by the effort its run used, so a per-spawn effort experiment shows as its own row.
                const effort = turns.find((turn) => turn.effort !== "")?.effort;
                const name = effort === undefined ? run.agentType : `${run.agentType} [${effort}]`;
                const bucket = byType.get(name) ?? emptyBucket();
                if (addRun(bucket, turns, options.since)) {
                    byType.set(name, bucket);
                    counted = true;
                }
            }
            if (addRun(main, unseen(join(projectDir, entry)), options.since)) {
                counted = true;
            }
            if (counted) {
                sessions += 1;
            }
        }
    }

    return {
        main: toRow("main thread", main),
        rows: [...byType.entries()]
            .map(([name, bucket]) => toRow(name, bucket))
            .sort((a, b) => b.dollars - a.dollars),
        sessions,
        since: options.since,
    };
}

function dollars(value: number): string {
    return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatRow(row: CostRow, nameWidth: number): string {
    const perRun = (value: number): number => (row.runs === 0 ? 0 : value / row.runs);
    const written = row.usage.cacheWrite5m + row.usage.cacheWrite1h;
    const context = row.turns === 0 ? 0 : (row.usage.cacheRead + written + row.usage.input) / row.turns;
    const rebuild = written === 0 ? 0 : (100 * row.idleRebuildTokens) / written;

    return [
        row.name.padEnd(nameWidth),
        String(row.runs).padStart(6),
        perRun(row.turns).toFixed(1).padStart(8),
        String(Math.round(perRun(row.usage.output))).padStart(9),
        `${Math.round(context / 1000)}k`.padStart(8),
        perRun(row.minutes).toFixed(1).padStart(8),
        dollars(perRun(row.dollars)).padStart(9),
        dollars(row.dollars).padStart(9),
        `${rebuild.toFixed(0)}%`.padStart(8),
    ].join("  ");
}

/** Renders the report: totals and the main-thread share first, then a row per agent type by cost. */
export function formatRunCost(report: RunCostReport): string {
    const subagents = report.rows.reduce((sum, row) => sum + row.dollars, 0);
    const total = subagents + report.main.dollars;
    const share = (value: number): string => (total === 0 ? "0%" : `${((100 * value) / total).toFixed(0)}%`);
    const nameWidth = Math.max(11, ...report.rows.map((row) => row.name.length));
    const header = [
        "agent".padEnd(nameWidth),
        "runs".padStart(6),
        "turns/r".padStart(8),
        "output/r".padStart(9),
        "ctx/turn".padStart(8),
        "min/r".padStart(8),
        "$/run".padStart(9),
        "$ total".padStart(9),
        "idle-rb".padStart(8),
    ].join("  ");

    return [
        `Since ${report.since}  Sessions: ${report.sessions}  API-equivalent cost: ${dollars(total)}`,
        `  main thread ${dollars(report.main.dollars)} (${share(report.main.dollars)}), `
            + `subagents ${dollars(subagents)} (${share(subagents)})`,
        "",
        header,
        formatRow(report.main, nameWidth),
        ...report.rows.map((row) => formatRow(row, nameWidth)),
        "",
        "ctx/turn: input plus cache read and write per turn. min/r: active minutes, idle gaps over five minutes left "
            + "out. idle-rb: share of cache writes that rewrote at least half the context after more than five idle "
            + "minutes; on a subagent that is the five-minute TTL expiring, on the main thread (one-hour TTL) mostly "
            + "compactions.",
    ].join("\n");
}
