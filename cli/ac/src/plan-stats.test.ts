import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
