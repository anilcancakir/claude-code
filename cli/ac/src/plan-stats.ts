import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NameCount } from "./run-stats.ts";

/** What one plan file contributes to the corpus rollup. */
export interface PlanSummary {
    readonly complexity: string | undefined;
    readonly codebaseState: string | undefined;
    readonly tiers: readonly string[];
}

/** Distributions across a corpus of plan files. */
export interface PlanStats {
    readonly plans: number;
    readonly steps: number;
    readonly tiers: readonly NameCount[];
    readonly complexity: readonly NameCount[];
    readonly codebaseState: readonly NameCount[];
    /** Plans with a `wisdom.md` beside them, which `/ac:execute` writes once a wave ran. */
    readonly executed: number;
    /** Steps per tier across the executed plans only: the denominator for `retries`. */
    readonly executedTiers: readonly NameCount[];
    /** `[RETRY]` wisdom lines per tier: each is one rung a failed step climbed. */
    readonly retries: readonly NameCount[];
    /** `[REMEDIATION]` wisdom lines: fixes the orchestrator made itself, which no retry count shows. */
    readonly remediations: number;
    /** `[REMEDIATION]` lines that name the step's tier, per tier. */
    readonly remediationTiers: readonly NameCount[];
    /** Findings per reviewer, summed over the `Review:` lines of every `review-log.md`. */
    readonly reviews: readonly ReviewTotals[];
}

/** One reviewer's findings across every review run it took part in. */
export interface ReviewTotals {
    readonly name: string;
    readonly runs: number;
    readonly critical: number;
    readonly important: number;
    readonly minor: number;
}

export interface PlanStatsOptions {
    /** Keep only plans whose `plan.md` was modified on or after this UTC date, `YYYY-MM-DD`. */
    readonly since?: string;
}

// The corpus carries four shapes for the same field, because the template's step layout changed over
// time: indented with a bullet, indented bare, unindented with a bullet, and unindented bare, with an
// optional trailing period. Anchoring on "the line STARTS with the field" accepts all four while still
// excluding the reference prose that names tiers mid-sentence, which would otherwise inflate whichever
// tier the documentation happens to discuss most. A stricter indent-plus-bullet anchor dropped 259 of
// 1,860 real steps when measured against the corpus.
const STEP_TIER = /^\s*(?:-\s+)?\*\*Tier\*\*:\s*([a-z-]+)/;

// `n/a` appears on steps that carry no tier, which is the shape verification steps use. It is an
// absence, not a fifth tier, and counting it would put it in the distribution beside the real ones.
const NOT_A_TIER = new Set(["n"]);
const COMPLEXITY = /^\*\*Complexity\*\*:\s*([a-z]+)/;
const CODEBASE_STATE = /^\*\*Codebase State\*\*:\s*([a-z]+)/;

// The records `/ac:execute` writes into wisdom.md. Anchored at the line start for the same reason as
// STEP_TIER: a wisdom line that mentions a tag mid-sentence is prose, not a record.
// Only the four tier names count as a tier: older free-form lines read "Step 4 bridge: ...".
const TIER = "(quick|junior-high|junior|senior)";
const RETRY_LINE = new RegExp(`^\\s*(?:-\\s+)?\\[RETRY\\]\\s+Step\\s+\\S+\\s+${TIER}:`);
const REMEDIATION_LINE = new RegExp(`^\\s*(?:-\\s+)?\\[REMEDIATION\\](?:\\s+Step\\s+\\S+\\s+${TIER}:)?`);
const REVIEW_LINE = /^Review:\s+(\S+)\s+CRITICAL\s+(\d+)\s+IMPORTANT\s+(\d+)\s+MINOR\s+(\d+)/;

// A lane's plan is archived to `.ac/coord/<slug>/bundles/<id>/` when its worktree is removed; a re-dispatched
// bundle keeps the failed attempt beside it as `<id>-failed-<n>`, which never executed to the end.
const LANE_ARCHIVE = /[\\/]\.ac[\\/]coord[\\/][^\\/]+[\\/]bundles[\\/]([^\\/]+)[\\/]plan\.md$/;

/** Extracts the frontmatter fields and every step tier from one plan file's text. */
export function summarisePlan(text: string): PlanSummary {
    let complexity: string | undefined;
    let codebaseState: string | undefined;
    const tiers: string[] = [];

    for (const line of text.split("\n")) {
        const tier = STEP_TIER.exec(line);
        if (tier?.[1] !== undefined) {
            if (!NOT_A_TIER.has(tier[1])) {
                tiers.push(tier[1]);
            }
            continue;
        }
        if (complexity === undefined) {
            complexity = COMPLEXITY.exec(line)?.[1];
        }
        if (codebaseState === undefined) {
            codebaseState = CODEBASE_STATE.exec(line)?.[1];
        }
    }

    return { codebaseState, complexity, tiers };
}

function toSortedCounts(counts: Map<string, number>): NameCount[] {
    return [...counts.entries()]
        .map(([name, count]): NameCount => ({ count, name }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

// Directories that never hold a plan and are expensive to descend into.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", ".next"]);

/** Collects every plan file under a root, at any nesting depth, matching the `.ac/plans` layout. */
function findPlanFiles(root: string, out: string[], depth: number): void {
    if (depth > 6) {
        return;
    }

    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) {
            continue;
        }
        const path = join(root, entry);
        let isDirectory: boolean;
        try {
            isDirectory = statSync(path).isDirectory();
        } catch {
            // A symlink to nowhere, or a file removed mid-walk. Neither is worth failing the scan.
            continue;
        }
        if (isDirectory) {
            findPlanFiles(path, out, depth + 1);
        } else if (entry === "plan.md" && isPlanPath(path)) {
            out.push(path);
        }
    }
}

function isPlanPath(path: string): boolean {
    if (path.includes(join(".ac", "plans"))) {
        return true;
    }
    const archived = LANE_ARCHIVE.exec(path)?.[1];
    return archived !== undefined && !archived.includes("-failed-");
}

/**
 * Walks a directory tree and rolls every plan file's distributions up.
 *
 * @param root Directory to scan. Every `.ac/plans/<slug>/plan.md` beneath it is included.
 * @returns Counts for tiers, complexity and codebase state, plus the plan and step totals.
 */
export function collectPlanStats(root: string, options: PlanStatsOptions = {}): PlanStats {
    const files: string[] = [];
    findPlanFiles(root, files, 0);

    const tiers = new Map<string, number>();
    const executedTiers = new Map<string, number>();
    const retries = new Map<string, number>();
    const complexity = new Map<string, number>();
    const codebaseState = new Map<string, number>();
    let plans = 0;
    let steps = 0;
    let executed = 0;
    let remediations = 0;
    const remediationTiers = new Map<string, number>();
    const reviews = new Map<string, { runs: number; critical: number; important: number; minor: number }>();

    for (const file of files) {
        if (options.since !== undefined && modifiedOn(file) < options.since) {
            continue;
        }
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        plans += 1;
        const summary = summarisePlan(text);
        for (const tier of summary.tiers) {
            bump(tiers, tier);
            steps += 1;
        }
        if (summary.complexity !== undefined) {
            bump(complexity, summary.complexity);
        }
        if (summary.codebaseState !== undefined) {
            bump(codebaseState, summary.codebaseState);
        }

        const wisdom = readSibling(file, "wisdom.md");
        if (wisdom === undefined) {
            continue;
        }
        executed += 1;
        for (const tier of summary.tiers) {
            bump(executedTiers, tier);
        }
        for (const line of wisdom.split("\n")) {
            const retry = RETRY_LINE.exec(line);
            if (retry?.[1] !== undefined) {
                bump(retries, retry[1]);
                continue;
            }
            const remediation = REMEDIATION_LINE.exec(line);
            if (remediation !== null) {
                remediations += 1;
                if (remediation[1] !== undefined) {
                    bump(remediationTiers, remediation[1]);
                }
            }
        }

        for (const line of readSibling(file, "review-log.md")?.split("\n") ?? []) {
            const review = REVIEW_LINE.exec(line);
            if (review?.[1] === undefined) {
                continue;
            }
            const totals = reviews.get(review[1]) ?? { critical: 0, important: 0, minor: 0, runs: 0 };
            reviews.set(review[1], {
                critical: totals.critical + Number(review[2]),
                important: totals.important + Number(review[3]),
                minor: totals.minor + Number(review[4]),
                runs: totals.runs + 1,
            });
        }
    }

    return {
        codebaseState: toSortedCounts(codebaseState),
        complexity: toSortedCounts(complexity),
        executed,
        executedTiers: toSortedCounts(executedTiers),
        plans,
        remediationTiers: toSortedCounts(remediationTiers),
        remediations,
        retries: toSortedCounts(retries),
        reviews: [...reviews.entries()]
            .map(([name, totals]): ReviewTotals => ({ name, ...totals }))
            .sort((a, b) => (b.runs - a.runs) || a.name.localeCompare(b.name)),
        steps,
        tiers: toSortedCounts(tiers),
    };
}

function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function modifiedOn(path: string): string {
    try {
        return statSync(path).mtime.toISOString().slice(0, 10);
    } catch {
        return "";
    }
}

function readSibling(planPath: string, name: string): string | undefined {
    try {
        return readFileSync(join(dirname(planPath), name), "utf8");
    } catch {
        // No wisdom file means the plan never reached an execute wave; that is the "not executed" answer.
        return undefined;
    }
}

function renderSection(title: string, entries: readonly NameCount[], total: number): string[] {
    if (entries.length === 0) {
        return [];
    }
    const width = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
    return [
        title,
        ...entries.map((entry) => {
            const share = total === 0 ? 0 : (100 * entry.count) / total;
            return `  ${entry.name.padEnd(width)}  ${String(entry.count).padStart(5)}  ${share.toFixed(1)}%`;
        }),
    ];
}

function renderPerStep(title: string, entries: readonly NameCount[], stats: PlanStats): string[] {
    if (entries.length === 0) {
        return [];
    }
    const width = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
    return [
        title,
        ...entries.map((entry) => {
            const steps = stats.executedTiers.find((tier) => tier.name === entry.name)?.count ?? 0;
            const share = steps === 0 ? 0 : (100 * entry.count) / steps;
            return `  ${entry.name.padEnd(width)}  ${String(entry.count).padStart(5)}  ${share.toFixed(1)}%`;
        }),
    ];
}

/** Renders the corpus distributions, each count beside its share of the relevant total. */
export function formatPlanStats(stats: PlanStats): string {
    const planTotal = stats.complexity.reduce((sum, entry) => sum + entry.count, 0);
    const stateTotal = stats.codebaseState.reduce((sum, entry) => sum + entry.count, 0);
    const lines = [
        `Plans: ${stats.plans}`,
        `Steps: ${stats.steps}`,
        ...renderSection("Tier distribution:", stats.tiers, stats.steps),
        ...renderSection("Complexity:", stats.complexity, planTotal),
        ...renderSection("Codebase state:", stats.codebaseState, stateTotal),
    ];

    if (stats.executed > 0) {
        lines.push(
            `Executed plans (wisdom.md present): ${stats.executed}`,
            `Remediation lines: ${stats.remediations}`,
            ...renderPerStep(
                "Remediations per tier (share of that tier's executed steps):",
                stats.remediationTiers,
                stats,
            ),
            // A step a legacy codebase reroutes from quick to junior retries under junior, so the shares lean
            // toward junior there; the denominator is the tier the plan declared.
            ...renderPerStep(
                "Retries per tier (rungs and terminal failures, share of that tier's executed steps):",
                stats.retries,
                stats,
            ),
        );
    }

    if (stats.reviews.length > 0) {
        const width = stats.reviews.reduce((max, entry) => Math.max(max, entry.name.length), 0);
        lines.push("Review findings per run (CRITICAL / IMPORTANT / MINOR):");
        for (const review of stats.reviews) {
            const per = (value: number): string => (value / review.runs).toFixed(2);
            lines.push(
                `  ${review.name.padEnd(width)}  runs ${String(review.runs).padStart(4)}  `
                    + `${per(review.critical)} / ${per(review.important)} / ${per(review.minor)}`,
            );
        }
    }

    return lines.join("\n");
}
