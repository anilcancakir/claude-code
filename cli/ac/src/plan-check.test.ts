import { expect, test } from "bun:test";
import { checkPlan, countSteps, formatCheckResult, type Finding } from "./plan-check.ts";
import { buildSkeleton } from "./plan-scaffold.ts";

function errors(findings: Finding[]): string[] {
    return findings.filter((finding) => finding.severity === "error").map((finding) => finding.message);
}

function wellFormed(): string {
    return [
        "# Plan: demo",
        "",
        "**Steps**: 2",
        "**Waves**: 1",
        "**Auto mode**: false",
        "",
        "## Steps",
        "",
        "### Wave 1: the only wave",
        "",
        "- [ ] **Step 1**: extract the request class",
        "    - **Type**: code",
        "    - **Tier**: junior",
        "    - **Why this tier**: rule-2-context: one rule set moved into a class.",
        "    - **References**: /repo/vendor/pkg/StoreTeamRequest.php:12, the shape to follow",
        "    - **Files**: /repo/app/Http/Requests/StoreThing.php",
        "    - **Description**: Move the inline array into a FormRequest.",
        "    - **Done when**: `rg -q 'validate\\(' app/` exits 1.",
        "    - **QA**: POST an invalid payload, assert 422.",
        "    - **Must NOT**: change any bound while moving it.",
        "",
        "- [ ] **Step 2**: prove the suite is green",
        "    - **Type**: verification",
        "    - **Files**: (no source edits; runs commands)",
        "    - **Description**: Run the backend suite and capture it.",
        "    - **Commands**: bin/check backend",
        "    - **Done when**: exit 0.",
        "    - **QA**: the captured log ends with OK.",
        "    - **Evidence**: .ac/plans/demo/evidence/step-2-suite.log",
        "    - **Must NOT**: edit source to make it pass.",
        "",
    ].join("\n");
}

test("a well-formed plan produces no findings", () => {
    expect(checkPlan(wellFormed())).toEqual([]);
});

// The regression this module exists for. Measured on one real 18-step plan: the planner wrote
// `#### Step N` headings with no checkbox and `Type: implementation`, which left Layer D and the
// Stop hook with nothing to count and gave Phase 2c no branch to route on.

test("step headings written without a checkbox are reported as the missing prefix", () => {
    const source = [
        "# Plan: demo",
        "",
        "**Steps**: 2",
        "**Waves**: 1",
        "**Auto mode**: false",
        "",
        "## Steps",
        "",
        "### Wave 1: the only wave",
        "",
        "#### Step 1: extract the request class",
        "",
        "**Type**: implementation",
        "",
        "#### Step 2: extract the other one",
        "",
        "**Type**: implementation",
        "",
    ].join("\n");
    const found = errors(checkPlan(source));
    expect(found.some((message) => message.includes("found 0 checkbox lines"))).toBe(true);
    expect(found.some((message) => message.includes("missing their `- [ ] ` prefix"))).toBe(true);
});

// The same symptom, a different disease. Asserting "missing prefix" when the steps are simply not
// in the file steers the reader toward inventing checkboxes for steps nobody wrote, and a model
// that "fixes" the frontmatter to match instead silently runs a two-step plan.

test("a truncated plan is named as truncated rather than as a missing prefix", () => {
    const source = [
        "# Plan: demo",
        "",
        "**Steps**: 18",
        "**Waves**: 1",
        "**Auto mode**: false",
        "",
        "## Steps",
        "",
        "### Wave 1: the only wave",
        "",
        "#### Step 1: the only one written",
        "",
    ].join("\n");
    const found = errors(checkPlan(source));
    expect(found.some((message) => message.includes("17 step(s) are absent"))).toBe(true);
    expect(found.some((message) => message.includes("missing their"))).toBe(false);
});

// The hooks grep `'^- \[ \] '` with the trailing space (stop-guard.sh:121 and :130). A checkbox
// this gate accepts but the guard cannot see is worse than no gate: the plan passes and its
// progress signal is already dead.

test("a checkbox without the space the hooks require is not a step", () => {
    const source = wellFormed().replace("- [ ] **Step 1**:", "- [ ]**Step 1**:");
    expect(errors(checkPlan(source)).some((message) => message.includes("found 1 checkbox lines"))).toBe(true);
});

test("the Auto mode frontmatter field is required and boolean", () => {
    expect(errors(checkPlan(wellFormed().replace("**Auto mode**: false\n", "")))
        .some((message) => message.includes("no `**Auto mode**:` line"))).toBe(true);
    expect(errors(checkPlan(wellFormed().replace("**Auto mode**: false", "**Auto mode**: <true|false>")))
        .some((message) => message.includes("must be true or false"))).toBe(true);
});

test("a worker step with no References warns", () => {
    const source = wellFormed().replace(
        "    - **References**: /repo/vendor/pkg/StoreTeamRequest.php:12, the shape to follow\n",
        "",
    );
    const findings = checkPlan(source);
    expect(errors(findings)).toEqual([]);
    expect(findings.some((finding) => finding.message.includes("no `References` field"))).toBe(true);
});

test("the scaffold's step-shape comment left in a filled plan warns", () => {
    const source = wellFormed().replace("## Steps\n", "## Steps\n\n<!-- Keep this shape and delete this stub. -->\n");
    const findings = checkPlan(source);
    expect(errors(findings)).toEqual([]);
    expect(findings.some((finding) => finding.message.includes("step-shape comment is still in the file"))).toBe(true);
});

test("an unknown Type is an error naming the three that route", () => {
    const source = wellFormed().replace("**Type**: code", "**Type**: implementation");
    const found = errors(checkPlan(source));
    expect(found.some((message) => message.includes("Type is `implementation`"))).toBe(true);
});

test("the flat field style still parses, because indentation breaks no consumer", () => {
    const source = wellFormed().replaceAll("\n    - **", "\n**");
    expect(checkPlan(source)).toEqual([]);
});

test("a checkbox count that disagrees with the frontmatter is an error", () => {
    const source = wellFormed().replace("**Steps**: 2", "**Steps**: 3");
    expect(errors(checkPlan(source)).some((message) => message.includes("frontmatter says 3, found 2"))).toBe(true);
});

test("ticked steps still count toward the total", () => {
    const source = wellFormed().replace("- [ ] **Step 1**", "- [x] **Step 1**");
    expect(checkPlan(source)).toEqual([]);
});

test("a code step with no Tier is an error", () => {
    const source = wellFormed().replace("    - **Tier**: junior\n", "");
    expect(errors(checkPlan(source)).some((message) => message.includes("no `Tier` field"))).toBe(true);
});

test("a verification step with no Evidence is an error", () => {
    const source = wellFormed().replace(
        "    - **Evidence**: .ac/plans/demo/evidence/step-2-suite.log\n",
        "",
    );
    expect(errors(checkPlan(source)).some((message) => message.includes("no `Evidence` field"))).toBe(true);
});

// The error set is exactly "a downstream consumer parses this". A verification step spawns no
// worker, so Files, QA and Must NOT have no consumer and Description has only a human one. Flagging
// them would put four findings on the four correctly written verification steps of one real plan,
// which is how a gate teaches its user to skim it.

test("a verification step needs no Files, QA or Must NOT", () => {
    const source = wellFormed()
        .replace("    - **Files**: (no source edits; runs commands)\n", "")
        .replace("    - **QA**: the captured log ends with OK.\n", "")
        .replace("    - **Must NOT**: edit source to make it pass.\n", "");
    expect(checkPlan(source)).toEqual([]);
});

test("a verification step with no Description warns rather than errors", () => {
    const source = wellFormed().replace("    - **Description**: Run the backend suite and capture it.\n", "");
    const findings = checkPlan(source);
    expect(errors(findings)).toEqual([]);
    expect(findings.some((finding) => finding.message.includes("no `Description` field"))).toBe(true);
});

test("a missing required field is an error rather than a warning", () => {
    const source = wellFormed().replace("    - **QA**: POST an invalid payload, assert 422.\n", "");
    expect(errors(checkPlan(source)).some((message) => message.includes("no `QA` field"))).toBe(true);
});

// A wave heading count that drifts from the frontmatter misleads the Phase 2a render but breaks no
// parse, so it warns rather than blocks.

test("a wave count mismatch warns rather than errors", () => {
    const source = wellFormed().replace("**Waves**: 1", "**Waves**: 2");
    const findings = checkPlan(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
});

// The scaffold and the checker are two halves of one contract: the stub plants the shape and the
// checker catches it left behind. An unfilled skeleton must never read as a pass.

test("the untouched scaffold fails the check", () => {
    const findings = checkPlan(buildSkeleton("demo-slug", false));
    expect(findings.filter((finding) => finding.severity === "error").length).toBeGreaterThan(0);
});

test("the scaffold's step stub declares every field the checker requires", () => {
    // The stub's values are placeholders on purpose, so it fails the check as a whole. What must
    // hold is that none of its findings is a MISSING field: a planner who fills the stub in cannot
    // then be told it left a field out. Anything the checker requires, the stub has to name.
    const found = errors(checkPlan(buildSkeleton("demo-slug", false)));
    expect(found.filter((message) => message.startsWith("no `"))).toEqual([]);
});

// Phase 1g is told to hold the step counts for Layer D, so they print on every exit. A clean run
// that printed only a pass line left that instruction with nothing to read.

test("the formatter reports the counts on a clean plan too", () => {
    const rendered = formatCheckResult({
        planPath: "/repo/.ac/plans/demo/plan.md",
        findings: [],
        errorCount: 0,
        warningCount: 0,
        stepCount: 18,
        checkedCount: 4,
    });
    expect(rendered).toContain("OK.");
    expect(rendered).toContain("18 steps, 4 checked, 14 unchecked");
});

test("countSteps separates ticked steps from the total", () => {
    const source = wellFormed().replace("- [ ] **Step 1**", "- [x] **Step 1**");
    expect(countSteps(source)).toEqual({ checkedCount: 1, stepCount: 2 });
});
