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

// The one section whose shape a downstream tool parses rather than reads. It ships as a worked stub
// instead of `<fill>` because the two fields that carry a machine contract, the `- [ ]` checkbox and
// the `Type` enum, otherwise live only in `plan-template.md`, and a planner that believes it already
// knows the step shape never opens that file. Measured once on a real 18-step plan: no checkbox on
// any step and `Type: implementation` on 14 of them, which cost the executor a user gate and 18
// repair edits before its first worker spawned.
const STEPS_STUB = `<!-- Keep this shape and delete this stub once the real steps are written.

     The \`- [ ] **Step N**:\` line is the executor's per-step record: Layer D ticks it and the Stop
     hook counts it, so a step written without one is invisible to both and the run loses its only
     progress signal.

     \`Type\` is one of these three and nothing else. The executor routes on it and has no branch for
     another value:
       code          source edits in the project; takes Tier and Why-this-tier, spawns a worker.
       infra         server ops, SSH, deployment; takes Tier and Why-this-tier, spawns a worker.
       verification  runs commands and captures evidence, no source edits. Omits Tier and
                     Why-this-tier, takes Commands and Evidence, runs orchestrator-direct.

     Field-by-field reference, including the per-tier Description budgets: plan-template.md under
     \`## Steps\`. Validate the finished section with \`ac plan-check <slug>\`. -->

- [ ] **Step 1**: <imperative title>
    - **Type**: code | infra | verification
    - **Tier**: quick | junior | junior-high | senior (omit when Type is verification)
    - **Why this tier**: <rule-1-cross-layer | rule-2-context | rule-3-codebase-state | rule-4-detail | rule-5-criticality | rule-none, then a colon and one sentence> (omit when Type is verification)
    - **Files**: <absolute paths, one per line; for verification: "(no source edits; runs commands)">
    - **Description**: <what to do and why, grounded in research. Stands alone: the worker sees this field and no other step, so name a path or a file:line rather than "Step 4's parser".>
    - **References**:
        - <file_path:line_number>, <pattern to follow>
    - **Commands**: <verification steps only: explicit command list, one per line>
    - **Done when**:
        - <executable criterion: greppable, testable, or LSP-checkable, provable by one command under 60 seconds>
    - **QA**: <tool + concrete steps + exact expected assertion>
    - **Evidence**: <verification steps only: paths under .ac/plans/<slug>/evidence/<step-id>-<scenario>.<ext>>
    - **Must NOT**:
        - <step-specific scope exclusion>`;

export type ScaffoldResult = {
    created: boolean;
    planPath: string;
};

/**
 * Builds the plan skeleton.
 *
 * `autoMode` is the Stage 4 `Lock all?` answer and it is required rather than defaulted. Stage 5's
 * first action is this call, so a run that skipped Stage 4 cannot get past it without noticing that
 * it has no answer to pass. Measured once: the planner ended its turn on the Stage 4 render, the
 * user typed "continue", and the resumed turn went straight to Stage 5 with the gate never asked,
 * so the decision was simply absent for the rest of the run. Persisting it in the frontmatter also
 * survives the compaction that lost it, which an in-context variable does not.
 */
export function buildSkeleton(slug: string, autoMode: boolean): string {
    const lines: string[] = [
        `# Plan: ${slug}`,
        "",
        "**Steps**: <N>",
        "**Waves**: <N>",
        "**Codebase State**: <disciplined | transitional | legacy | chaotic | greenfield>",
        `**Auto mode**: ${autoMode}`,
        "**Generated**: <ISO timestamp>",
        "",
    ];
    for (const section of PLAN_SECTIONS) {
        lines.push(`## ${section}`, "", section === "Steps" ? STEPS_STUB : "<fill>", "");
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
export function scaffoldPlan(slug: string, opts: { autoMode: boolean; dir: string }): ScaffoldResult {
    const planDir = join(opts.dir, ".ac", "plans", slug);
    mkdirSync(join(planDir, "research"), { recursive: true });
    mkdirSync(join(planDir, "evidence"), { recursive: true });

    const planPath = join(planDir, "plan.md");
    if (existsSync(planPath)) {
        return { created: false, planPath };
    }
    writeFileSync(planPath, buildSkeleton(slug, opts.autoMode), "utf8");
    return { created: true, planPath };
}
