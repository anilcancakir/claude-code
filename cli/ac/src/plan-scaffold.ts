import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The H2 sections of the plan file, in the order `plan-template.md` defines them. The order is
// the point: a scaffold cannot forget it, and downstream readers (the reviewers, the executor's
// Phase 1b parse) locate sections by heading.
export const PLAN_SECTIONS = [
    "Research Summary",
    "Codebase Conventions",
    "Reuse Map",
    "Work Objectives",
    "Tier Calibration",
    "Execution Strategy",
    "Steps",
    "Risks Accepted",
    "Cross-Project Observations",
    "Deferred Ideas",
] as const;

export type ScaffoldResult = {
    created: boolean;
    planPath: string;
};

export function buildSkeleton(slug: string): string {
    const lines: string[] = [
        `# Plan: ${slug}`,
        "",
        "**Complexity**: <standard | complex>",
        "**Steps**: <N>",
        "**Waves**: <N>",
        "**Codebase State**: <disciplined | transitional | legacy | chaotic | greenfield>",
        "**Generated**: <ISO timestamp>",
        "",
    ];
    for (const section of PLAN_SECTIONS) {
        lines.push(`## ${section}`, "", "<fill>", "");
    }
    return lines.join("\n");
}

/**
 * Creates the plan directory tree and writes the skeleton.
 *
 * Idempotent by design: an existing `plan.md` is left untouched, so a resumed run cannot clobber
 * a plan the planner already filled in. The directories are created either way, which is what
 * makes the call safe to repeat.
 */
export function scaffoldPlan(slug: string, opts: { dir: string }): ScaffoldResult {
    const planDir = join(opts.dir, ".ac", "plans", slug);
    mkdirSync(join(planDir, "research"), { recursive: true });
    mkdirSync(join(planDir, "evidence"), { recursive: true });

    const planPath = join(planDir, "plan.md");
    if (existsSync(planPath)) {
        return { created: false, planPath };
    }
    writeFileSync(planPath, buildSkeleton(slug), "utf8");
    return { created: true, planPath };
}
