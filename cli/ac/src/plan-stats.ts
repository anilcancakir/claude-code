import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
        } else if (entry === "plan.md" && path.includes(`${join(".ac", "plans")}`)) {
            out.push(path);
        }
    }
}

/**
 * Walks a directory tree and rolls every plan file's distributions up.
 *
 * @param root Directory to scan. Every `.ac/plans/<slug>/plan.md` beneath it is included.
 * @returns Counts for tiers, complexity and codebase state, plus the plan and step totals.
 */
export function collectPlanStats(root: string): PlanStats {
    const files: string[] = [];
    findPlanFiles(root, files, 0);

    const tiers = new Map<string, number>();
    const complexity = new Map<string, number>();
    const codebaseState = new Map<string, number>();
    let steps = 0;

    for (const file of files) {
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        const summary = summarisePlan(text);
        for (const tier of summary.tiers) {
            tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
            steps += 1;
        }
        if (summary.complexity !== undefined) {
            complexity.set(summary.complexity, (complexity.get(summary.complexity) ?? 0) + 1);
        }
        if (summary.codebaseState !== undefined) {
            codebaseState.set(summary.codebaseState, (codebaseState.get(summary.codebaseState) ?? 0) + 1);
        }
    }

    return {
        codebaseState: toSortedCounts(codebaseState),
        complexity: toSortedCounts(complexity),
        plans: files.length,
        steps,
        tiers: toSortedCounts(tiers),
    };
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

/** Renders the corpus distributions, each count beside its share of the relevant total. */
export function formatPlanStats(stats: PlanStats): string {
    const planTotal = stats.complexity.reduce((sum, entry) => sum + entry.count, 0);
    const stateTotal = stats.codebaseState.reduce((sum, entry) => sum + entry.count, 0);
    return [
        `Plans: ${stats.plans}`,
        `Steps: ${stats.steps}`,
        ...renderSection("Tier distribution:", stats.tiers, stats.steps),
        ...renderSection("Complexity:", stats.complexity, planTotal),
        ...renderSection("Codebase state:", stats.codebaseState, stateTotal),
    ].join("\n");
}
