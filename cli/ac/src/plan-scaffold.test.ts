import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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
    const result = scaffoldPlan("demo-slug", { dir: root });
    expect(result.created).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/plan.md"))).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/research"))).toBe(true);
    expect(existsSync(join(root, ".ac/plans/demo-slug/evidence"))).toBe(true);
});

test("the emitted path points at the plan file", () => {
    const root = freshRoot();
    const result = scaffoldPlan("demo-slug", { dir: root });
    expect(result.planPath).toBe(join(root, ".ac/plans/demo-slug/plan.md"));
});

// Resume safety: a second run must not clobber a plan the planner already filled in. This is
// the whole reason the subcommand exists rather than a bare `mkdir -p` plus `Write`.

test("a second invocation is a no-op and leaves the file byte-identical", () => {
    const root = freshRoot();
    const first = scaffoldPlan("demo-slug", { dir: root });
    const filled = "# Plan: already written by the planner\n";
    Bun.write(first.planPath, filled);
    const before = readFileSync(first.planPath, "utf8");
    const second = scaffoldPlan("demo-slug", { dir: root });
    expect(second.created).toBe(false);
    expect(readFileSync(first.planPath, "utf8")).toBe(before);
});

// The skeleton's job is to make the header order impossible to get wrong, so the order is
// asserted rather than assumed.

test("the skeleton emits the template's H2 sections in order", () => {
    const skeleton = buildSkeleton("demo-slug");
    const emitted = skeleton
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3).trim());
    expect(emitted).toEqual([...PLAN_SECTIONS]);
});

test("the skeleton carries every frontmatter field the executor parses", () => {
    const skeleton = buildSkeleton("demo-slug");
    for (const field of ["**Complexity**", "**Steps**", "**Waves**", "**Codebase State**", "**Generated**"]) {
        expect(skeleton).toContain(field);
    }
});

test("the skeleton offers only the two live complexity values", () => {
    expect(buildSkeleton("demo-slug")).toContain("<standard | complex>");
});
