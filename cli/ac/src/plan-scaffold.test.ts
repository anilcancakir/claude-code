import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkeleton, PLAN_SECTIONS, scaffoldPlan } from "./plan-scaffold.ts";

const roots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-scaffold-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
        }
    }
});

test("a fresh scaffold creates the plan file and both sibling directories", () => {
    const root = freshRoot();
    const result = scaffoldPlan("demo-slug", { autoMode: false, dir: root });
    expect(result.created).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/plan.md"))).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/research"))).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/evidence"))).toBe(true);
});

test("the emitted path points at the plan file", () => {
    const root = freshRoot();
    const result = scaffoldPlan("demo-slug", { autoMode: false, dir: root });
    expect(result.planPath).toBe(join(root, ".ac/plans/demo-slug/plan.md"));
});

// Resume safety: a second run must not clobber a plan the planner already filled in. This is
// the whole reason the subcommand exists rather than a bare `mkdir -p` plus `Write`.

test("a second invocation is a no-op and leaves the file byte-identical", () => {
    const root = freshRoot();
    const first = scaffoldPlan("demo-slug", { autoMode: false, dir: root });
    const filled = "# Plan: already written by the planner\n";
    // Sync write on purpose: an un-awaited async write can land between the two reads below, which
    // makes the assertion race, or never land at all, which makes it pass against the skeleton.
    writeFileSync(first.planPath, filled, "utf8");
    const before = readFileSync(first.planPath, "utf8");
    const second = scaffoldPlan("demo-slug", { autoMode: false, dir: root });
    expect(second.created).toBe(false);
    expect(readFileSync(first.planPath, "utf8")).toBe(before);
});

// The skeleton's job is to make the header order impossible to get wrong, so the order is
// asserted rather than assumed.

test("the skeleton emits the template's H2 sections in order", () => {
    const skeleton = buildSkeleton("demo-slug", false);
    const emitted = skeleton
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3).trim());
    expect(emitted).toEqual([...PLAN_SECTIONS]);
});

test("the skeleton carries every frontmatter field the executor parses", () => {
    const skeleton = buildSkeleton("demo-slug", false);
    for (const field of ["**Steps**", "**Waves**", "**Codebase State**", "**Generated**"]) {
        expect(skeleton).toContain(field);
    }
});

// The step stub exists because the two fields carrying a machine contract, the checkbox and the
// Type enum, otherwise live only in plan-template.md, which a planner that thinks it knows the shape
// never opens. Assert both, since a stub that drops either is the malformation it was added to stop.

test("the Steps section ships a worked stub rather than a bare fill marker", () => {
    const steps = buildSkeleton("demo-slug", false).split("## Steps\n")[1] ?? "";
    expect(steps).toContain("- [ ] **Step 1**:");
    expect(steps).toContain("**Type**: code | infra | verification");
    expect(steps.split("## ")[0]).not.toContain("<fill>");
});

test("every other section still gets the fill marker", () => {
    const skeleton = buildSkeleton("demo-slug", false);
    // One per section minus Steps, which carries the stub instead.
    const fills = skeleton.split("\n").filter((line) => line.trim() === "<fill>").length;
    expect(fills).toBe(PLAN_SECTIONS.length - 1);
});

test("the skeleton carries no complexity field", () => {
    // The field was deleted once its three consumers went: reviewer-tier routing, the oracle default,
    // and the wave-commit gate. Measured across 106 plans it had also stopped classifying anything,
    // with 84% of them landing on the same value.
    expect(buildSkeleton("demo-slug", false)).not.toContain("Complexity");
});
