import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPlanStats, formatPlanStats, summarisePlan } from "./plan-stats.ts";

const roots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-plan-stats-"));
    roots.push(root);
    return root;
}

/** Writes a plan at `<root>/<project>/.ac/plans/<slug>/plan.md`, the real corpus layout. */
function writePlan(root: string, project: string, slug: string, body: string): string {
    const dir = join(root, project, ".ac", "plans", slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "plan.md");
    writeFileSync(path, body);
    return path;
}

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
        }
    }
});

describe("summarisePlan", () => {
    test("reads the frontmatter fields and every step tier", () => {
        const body = [
            "# Plan: Something",
            "",
            "**Complexity**: complex",
            "**Codebase State**: disciplined",
            "",
            "## Steps",
            "",
            "- [ ] **Step 1**: do a thing",
            "    - **Tier**: junior",
            "- [ ] **Step 2**: do another",
            "    - **Tier**: senior",
            "- [ ] **Step 3**: mechanical",
            "    - **Tier**: quick",
        ].join("\n");

        const summary = summarisePlan(body);

        expect(summary.complexity).toBe("complex");
        expect(summary.codebaseState).toBe("disciplined");
        expect(summary.tiers).toEqual(["junior", "senior", "quick"]);
    });

    test("tolerates a plan with no steps and no frontmatter", () => {
        const summary = summarisePlan("# Plan: empty\n");

        expect(summary.complexity).toBeUndefined();
        expect(summary.codebaseState).toBeUndefined();
        expect(summary.tiers).toEqual([]);
    });

    test("accepts every step-field shape the corpus actually carries", () => {
        // The template's step layout changed over time, so the same field appears indented or not,
        // with a bullet or without, and sometimes with a trailing period. A stricter anchor dropped
        // 259 of 1,860 real steps.
        const body = [
            "## Steps",
            "    - **Tier**: junior",
            "**Tier**: senior",
            "- **Tier**: quick",
            "- **Tier**: junior-high.",
            "    - **Tier**: n/a",
        ].join("\n");

        expect(summarisePlan(body).tiers).toEqual(["junior", "senior", "quick", "junior-high"]);
    });

    test("ignores a Tier mentioned outside a step bullet", () => {
        // Reference prose routinely names tiers ("route senior work to ..."), and counting those
        // would inflate whichever tier the documentation happens to discuss most.
        const body = [
            "## Tier Calibration",
            "",
            "Assign **Tier**: senior only for cross-layer work.",
            "",
            "## Steps",
            "",
            "- [ ] **Step 1**: a thing",
            "    - **Tier**: junior",
        ].join("\n");

        expect(summarisePlan(body).tiers).toEqual(["junior"]);
    });
});

describe("collectPlanStats", () => {
    test("walks a corpus and rolls the distributions up", () => {
        const root = freshRoot();
        writePlan(root, "alpha", "one", [
            "**Complexity**: complex",
            "**Codebase State**: disciplined",
            "## Steps",
            "- [ ] **Step 1**: a",
            "    - **Tier**: senior",
            "- [ ] **Step 2**: b",
            "    - **Tier**: junior",
        ].join("\n"));
        writePlan(root, "beta", "two", [
            "**Complexity**: standard",
            "**Codebase State**: greenfield",
            "## Steps",
            "- [ ] **Step 1**: c",
            "    - **Tier**: junior",
        ].join("\n"));

        const stats = collectPlanStats(root);

        expect(stats.plans).toBe(2);
        expect(stats.steps).toBe(3);
        expect(stats.tiers).toEqual([
            { count: 2, name: "junior" },
            { count: 1, name: "senior" },
        ]);
        expect(stats.complexity).toEqual([
            { count: 1, name: "complex" },
            { count: 1, name: "standard" },
        ]);
    });

    test("returns an empty result for a root holding no plans", () => {
        const stats = collectPlanStats(freshRoot());

        expect(stats.plans).toBe(0);
        expect(stats.steps).toBe(0);
        expect(stats.tiers).toEqual([]);
    });
});

describe("formatPlanStats", () => {
    test("renders counts with their share of the total", () => {
        const root = freshRoot();
        writePlan(root, "alpha", "one", [
            "## Steps",
            "- [ ] **Step 1**: a",
            "    - **Tier**: senior",
            "- [ ] **Step 2**: b",
            "    - **Tier**: junior",
        ].join("\n"));

        const rendered = formatPlanStats(collectPlanStats(root));

        expect(rendered).toContain("Plans: 1");
        expect(rendered).toContain("Steps: 2");
        expect(rendered).toContain("50.0%");
    });
});

describe("execution outcomes", () => {
    const plan = [
        "## Steps",
        "- [x] **Step 1**: a",
        "    - **Tier**: junior",
        "- [x] **Step 2**: b",
        "    - **Tier**: junior",
        "- [x] **Step 3**: c",
        "    - **Tier**: senior",
    ].join("\n");

    test("counts retries per tier and remediation lines from the wisdom file beside the plan", () => {
        const root = freshRoot();
        const planPath = writePlan(root, "alpha", "one", plan);
        writeFileSync(join(planPath, "..", "wisdom.md"), [
            "## Wave 1",
            "- [RETRY] Step 2 junior: rung 1, missed the null branch",
            "- [RETRY] Step 2 junior: rung 2, still failing the suite",
            "- [REMEDIATION] Step 3: added the missing export",
            "- A plain wisdom line naming [RETRY] mid-sentence is not a record",
        ].join("\n"));

        const stats = collectPlanStats(root);

        expect(stats.executed).toBe(1);
        expect(stats.retries).toEqual([{ count: 2, name: "junior" }]);
        expect(stats.remediations).toBe(1);
        expect(formatPlanStats(stats)).toContain("Retries per tier");
    });

    test("reads lane plans archived under .ac/coord/<slug>/bundles and skips failed attempts", () => {
        const root = freshRoot();
        for (const id of ["b1", "b2-failed-1"]) {
            const dir = join(root, "app", ".ac", "coord", "ship", "bundles", id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "plan.md"), plan);
            writeFileSync(join(dir, "wisdom.md"), "- [RETRY] Step 3 senior: terminal, suite red\n");
        }

        const stats = collectPlanStats(root);

        expect(stats.plans).toBe(1);
        expect(stats.retries).toEqual([{ count: 1, name: "senior" }]);
    });

    test("sums the Review lines of review-log.md per reviewer and counts remediations per tier", () => {
        const root = freshRoot();
        const planPath = writePlan(root, "alpha", "one", plan);
        writeFileSync(join(planPath, "..", "wisdom.md"), [
            "- [REMEDIATION] Step 2 junior: wired the missing export",
            "- [REMEDIATION] Step - -: fixed a cross-step import",
        ].join("\n"));
        writeFileSync(join(planPath, "..", "review-log.md"), [
            "## Run 2026-10-27T10:00:00Z",
            "Review: ac:plan-code-review CRITICAL 0 IMPORTANT 2 MINOR 3",
            "Review: ac:oracle CRITICAL 1 IMPORTANT 0 MINOR 1",
            "## Run 2026-10-27T12:00:00Z",
            "Review: ac:plan-code-review CRITICAL 1 IMPORTANT 1 MINOR 0",
        ].join("\n"));

        const stats = collectPlanStats(root);

        expect(stats.remediations).toBe(2);
        expect(stats.remediationTiers).toEqual([{ count: 1, name: "junior" }]);
        expect(stats.reviews).toEqual([
            { critical: 1, important: 3, minor: 3, name: "ac:plan-code-review", runs: 2 },
            { critical: 1, important: 0, minor: 1, name: "ac:oracle", runs: 1 },
        ]);
        const text = formatPlanStats(stats);
        expect(text).toContain("Review findings per run");
        expect(text).toContain("ac:plan-code-review");
    });

    test("--since keeps only plans written on or after the date", () => {
        const root = freshRoot();
        const old = writePlan(root, "alpha", "old", plan);
        writePlan(root, "alpha", "new", plan);
        const before = new Date("2026-09-01T00:00:00Z");
        utimesSync(old, before, before);

        expect(collectPlanStats(root, { since: "2026-10-01" }).plans).toBe(1);
        expect(collectPlanStats(root).plans).toBe(2);
    });

    test("counts untagged remediation lines and malformed retry lines, and names the count in the text", () => {
        const root = freshRoot();
        const planPath = writePlan(root, "alpha", "one", plan);
        writeFileSync(join(planPath, "..", "wisdom.md"), [
            "- [REMEDIATION] Step 2 junior: tagged fix",
            "- [REMEDIATION] Step 3: no tier",
            "- [RETRY] Step 2 junior: rung 1, tagged",
            "- [RETRY] Step 2: rung 1, no tier",
            "- [RETRY] rung 2, no step either",
            "- [REMEDIATION] Step - -: a fix no step owns is tagged",
            "- A plain line naming [RETRY] mid-sentence is prose",
        ].join("\n"));

        const stats = collectPlanStats(root);

        expect(stats.remediations).toBe(3);
        expect(stats.retries).toEqual([{ count: 1, name: "junior" }]);
        expect(stats.untagged).toBe(3);
        expect(formatPlanStats(stats)).toContain("Untagged records (no tier on a [REMEDIATION], malformed [RETRY]): 3");
    });
});

describe("flow runs", () => {
    function writeFlowRun(root: string, run: string, files: Record<string, string>): void {
        const dir = join(root, "app", ".ac", "flow", run);
        mkdirSync(dir, { recursive: true });
        for (const [name, body] of Object.entries(files)) {
            writeFileSync(join(dir, name), body);
        }
    }

    test("keeps a flow run's records out of the tier shares, adds its Review lines, and reports the flow part", () => {
        const root = freshRoot();
        writeFlowRun(root, "2026-11-03-demo", {
            "review-log.md": "Review: ac:oracle CRITICAL 1 IMPORTANT 2 MINOR 3\n",
            "wisdom.md": [
                "## Wave 1",
                "[REMEDIATION] Step 2 junior-high: restored a dropped import",
                "[RETRY] Step 1 junior: rung 1, missed the null branch",
                "[REMEDIATION] Step 3: no tier",
            ].join("\n"),
        });
        writeFlowRun(root, "2026-11-03-notes-only", { "notes.md": "[REMEDIATION] Step 1 junior: not a flow record file" });

        const stats = collectPlanStats(root);

        expect(stats.plans).toBe(0);
        expect(stats.flowRuns).toBe(1);
        expect(stats.flowRecords).toBe(3);
        expect(stats.flowUntagged).toBe(1);
        expect(stats.flowReviews).toBe(1);
        expect(stats.flowRemediationTiers).toEqual([{ count: 1, name: "junior-high" }]);
        expect(stats.flowRetries).toEqual([{ count: 1, name: "junior" }]);
        expect(stats.remediations).toBe(0);
        expect(stats.remediationTiers).toEqual([]);
        expect(stats.retries).toEqual([]);
        expect(stats.untagged).toBe(0);
        expect(stats.reviews).toEqual([{ critical: 1, important: 2, minor: 3, name: "ac:oracle", runs: 1 }]);

        const text = formatPlanStats(stats);
        expect(text).toContain("Flow runs (.ac/flow; records kept out of the tier shares, Review lines included): 1");
        expect(text).toContain("3 records (remediations junior-high 1; retries junior 1), 1 untagged, 1 Review lines");
    });

    test("a flow run with only a review-log counts, and flow totals sit beside a plan's", () => {
        const root = freshRoot();
        const planPath = writePlan(root, "app", "one", "## Steps\n- [x] **Step 1**: a\n    - **Tier**: senior\n");
        writeFileSync(join(planPath, "..", "wisdom.md"), "- [RETRY] Step 1 senior: terminal, red\n");
        writeFlowRun(root, "2026-11-03-review-only", {
            "review-log.md": "Review: ac:oracle CRITICAL 0 IMPORTANT 1 MINOR 0\n",
        });

        const stats = collectPlanStats(root);

        expect(stats.flowRuns).toBe(1);
        expect(stats.flowRecords).toBe(0);
        expect(stats.retries).toEqual([{ count: 1, name: "senior" }]);
        expect(stats.reviews).toEqual([{ critical: 0, important: 1, minor: 0, name: "ac:oracle", runs: 1 }]);
    });
});
