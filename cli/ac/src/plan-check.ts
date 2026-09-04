import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The three `Type:` values `/ac:execute` Phase 2c routes on. It has no branch for anything else. */
export const STEP_TYPES = ["code", "infra", "verification"] as const;

/** The four worker tiers `/ac:execute` Phase 1c maps to a subagent. */
export const STEP_TIERS = ["quick", "junior", "junior-high", "senior"] as const;

/**
 * Fields a worker step carries. `Type` is checked separately because its value decides which of the
 * two sets below applies.
 */
const WORKER_FIELDS = ["Files", "Description", "Done when", "QA", "Must NOT"] as const;

/**
 * Fields a verification step carries. Shorter than the worker set on purpose: a verification step
 * spawns nothing, so `QA` (a worker's scenario) and `Must NOT` (a worker's guardrail) have no
 * consumer, and `Files` is by definition empty. Requiring them would make the check noise on a
 * correctly written step, which is how a check earns the habit of being overridden.
 *
 * Each of these three has a consumer that reads it: the orchestrator runs `Commands`, captures to
 * `Evidence`, and holds `Done when` at the wave barrier. `Description` is deliberately absent, since
 * on a step whose `Commands` are right there it carries a reader and nothing else; it warns below.
 */
const VERIFICATION_FIELDS = ["Commands", "Done when", "Evidence"] as const;

/**
 * An `error` breaks a downstream consumer: the executor cannot route the step, or a control it
 * depends on retires silently. A `warning` is shape drift a reader absorbs but a reviewer should
 * see. Only errors set the exit code, so the check stays worth running rather than worth skipping.
 */
export type Severity = "error" | "warning";

export type Finding = {
    severity: Severity;
    scope: string;
    message: string;
};

export type CheckResult = {
    planPath: string;
    findings: Finding[];
    errorCount: number;
    warningCount: number;
    /** Total steps found, and how many are already ticked. Phase 1g holds both for Layer D. */
    stepCount: number;
    checkedCount: number;
};

type ParsedStep = {
    label: string;
    title: string;
    checked: boolean;
    fields: Map<string, string>;
};

/**
 * A step line exactly as the hooks see it: anchored at column 0, with the space after the bracket.
 *
 * `stop-guard.sh:109` and `:118` both grep `'^- \[ \] '` including that trailing space, so a line
 * written `- [ ]**Step 1**: x` is a step to a human, a step to a lenient parser, and invisible to
 * the guard that reads outstanding work. Accepting it here would mean this gate blessing a plan
 * whose progress signal is already dead, which is the exact failure the gate exists to catch.
 */
const STEP_LINE = /^- \[([ xX])\] (.*)$/;

/** Tolerates the template's nested `    - **Name**: value` and the flat `**Name**: value` drift. */
const FIELD_LINE = /^\s*(?:-\s*)?\*\*([^*]+)\*\*\s*:\s*(.*)$/;

/** The heading shape a planner reaches for when it writes steps from memory instead of the template. */
const STEP_HEADING = /^#{2,6}\s+Step\s+\d+\b/;

const WAVE_HEADING = /^#{2,6}\s+Wave\s+\d+\b/;

/**
 * Reads a numeric frontmatter field, keeping "the line is absent" and "the line still holds the
 * scaffold's `<N>`" apart. They need different sentences: one says write the line, the other says
 * you already have it and never filled it in.
 */
function readFrontmatterNumber(source: string, field: string): number | "placeholder" | null {
    const match = new RegExp(`^\\*\\*${field}\\*\\*\\s*:\\s*(.*)$`, "m").exec(source);
    if (match === null || match[1] === undefined) {
        return null;
    }
    const value = match[1].trim();
    return /^\d+$/.test(value) ? Number.parseInt(value, 10) : "placeholder";
}

/**
 * Splits the file into step blocks anchored on the checkbox lines.
 *
 * A block runs from its checkbox to the next checkbox or the next heading, whichever comes first,
 * so a step at the end of a wave does not swallow the following wave's heading and fields.
 */
function parseSteps(lines: string[]): ParsedStep[] {
    const steps: ParsedStep[] = [];
    let current: ParsedStep | null = null;

    for (const line of lines) {
        const stepMatch = STEP_LINE.exec(line);
        if (stepMatch !== null) {
            const raw = (stepMatch[2] ?? "").trim();
            // Both the template's bold `**Step 1**: title` and the unbolded `Step 1: title` that
            // hand-repaired plans carry. The label is the identifier a reader greps the plan with,
            // so a step whose number cannot be read falls back to its truncated title rather than
            // to a position, which shifts the moment a step is inserted.
            const titleMatch = /^\*{0,2}Step\s+(\S+?)\*{0,2}\s*:\s*(.*)$/.exec(raw);
            current = {
                label: titleMatch === null ? raw.slice(0, 40) : `Step ${(titleMatch[1] ?? "").trim()}`,
                title: titleMatch === null ? raw : (titleMatch[2] ?? "").trim(),
                checked: (stepMatch[1] ?? " ") !== " ",
                fields: new Map<string, string>(),
            };
            steps.push(current);
            continue;
        }

        if (current === null) {
            continue;
        }

        if (line.startsWith("#")) {
            current = null;
            continue;
        }

        const fieldMatch = FIELD_LINE.exec(line);
        if (fieldMatch !== null && fieldMatch[1] !== undefined) {
            current.fields.set(fieldMatch[1].trim(), (fieldMatch[2] ?? "").trim());
        }
    }

    return steps;
}

function isPlaceholder(value: string): boolean {
    return value === "" || (value.startsWith("<") && value.endsWith(">"));
}

function checkCounts(source: string, lines: string[], steps: ParsedStep[], findings: Finding[]): void {
    // 1. The checkbox count against the frontmatter. This is the comparison every Layer D tick and
    //    the Stop hook's outstanding-step read both rest on, so a mismatch invalidates both.
    const declaredSteps = readFrontmatterNumber(source, "Steps");
    if (declaredSteps === null || declaredSteps === "placeholder") {
        findings.push({
            severity: "error",
            scope: "frontmatter",
            message: declaredSteps === null
                ? "no `**Steps**:` line. The executor compares every checkbox count against it."
                : "`**Steps**:` still holds the scaffold placeholder; it must be the step count.",
        });
    } else if (steps.length !== declaredSteps) {
        // The hint decides which repair the reader reaches for, so it has to tell "written without
        // the prefix" apart from "not written at all". They look identical from the checkbox count
        // and only the heading count separates them; asserting the first when it is the second
        // steers toward inventing checkboxes for steps that were never in the file.
        const headings = lines.filter((line) => STEP_HEADING.test(line)).length;
        let hint = "";
        if (steps.length === 0 && headings === declaredSteps) {
            hint = ` All ${headings} \`Step N\` headings are present, so the step lines are missing their \`- [ ] \` prefix.`;
        } else if (steps.length === 0 && headings > 0) {
            hint = ` Only ${headings} \`Step N\` heading(s) are present, so ${declaredSteps - headings} step(s) are absent from the body rather than merely unticked. The plan is truncated; do not repair the count.`;
        }
        findings.push({
            severity: "error",
            scope: "steps",
            message: `frontmatter says ${declaredSteps}, found ${steps.length} checkbox lines.${hint}`,
        });
    }

    // 2. The wave count. The executor reads it as the number of barriers the run will pass, and it
    //    renders it at Phase 2a before the user approves the shape of the run.
    const declaredWaves = readFrontmatterNumber(source, "Waves");
    const waveHeadings = lines.filter((line) => WAVE_HEADING.test(line)).length;
    if (declaredWaves === null || declaredWaves === "placeholder") {
        findings.push({
            severity: "error",
            scope: "frontmatter",
            message: declaredWaves === null
                ? "no `**Waves**:` line."
                : "`**Waves**:` still holds the scaffold placeholder; it must be the wave count.",
        });
    } else if (waveHeadings !== declaredWaves) {
        findings.push({
            severity: "warning",
            scope: "waves",
            message: `frontmatter says ${declaredWaves}, found ${waveHeadings} \`Wave N\` headings.`,
        });
    }
}

function checkStep(step: ParsedStep, findings: Finding[]): void {
    if (isPlaceholder(step.title)) {
        findings.push({
            severity: "error",
            scope: step.label,
            message: "the title is still the scaffold placeholder. Delete the stub or fill it in.",
        });
    }

    const type = step.fields.get("Type") ?? "";
    const isVerification = type === "verification";

    if (!(STEP_TYPES as readonly string[]).includes(type)) {
        findings.push({
            severity: "error",
            scope: step.label,
            message: type === ""
                ? "no `Type` field. `/ac:execute` routes on it and cannot spawn without one."
                : `Type is \`${type}\`; must be one of ${STEP_TYPES.join(", ")}.`,
        });
    }

    const required: readonly string[] = isVerification ? VERIFICATION_FIELDS : WORKER_FIELDS;
    for (const field of required) {
        const value = step.fields.get(field);
        if (value === undefined) {
            findings.push({severity: "error", scope: step.label, message: `no \`${field}\` field.`});
            continue;
        }
        // A field header with its list under it is the template's own shape for `Done when` and
        // `Must NOT`, so an empty value there is only a finding when the following lines are empty
        // too, which the block parse cannot see. Flag the angle-bracket placeholder instead.
        if (value.startsWith("<") && value.endsWith(">")) {
            findings.push({
                severity: "warning",
                scope: step.label,
                message: `\`${field}\` is still a placeholder.`,
            });
        }
    }

    if (isVerification) {
        if (!step.fields.has("Description")) {
            findings.push({
                severity: "warning",
                scope: step.label,
                message: "no `Description` field. The Phase 2a render and the final report show the title alone.",
            });
        }
        if (step.fields.has("Tier")) {
            findings.push({
                severity: "warning",
                scope: step.label,
                message: "verification steps spawn no worker, so `Tier` has no effect. Drop it.",
            });
        }
        return;
    }

    const tier = step.fields.get("Tier") ?? "";
    if (!(STEP_TIERS as readonly string[]).includes(tier)) {
        findings.push({
            severity: "error",
            scope: step.label,
            message: tier === ""
                ? "no `Tier` field. A code or infra step spawns a tier-routed worker."
                : `Tier is \`${tier}\`; must be one of ${STEP_TIERS.join(", ")}.`,
        });
    }
    if (!step.fields.has("Why this tier")) {
        findings.push({severity: "warning", scope: step.label, message: "no `Why this tier` field."});
    }
    // Inlined verbatim into the worker briefing (`worker-briefing-template.md:91`), so it has a
    // machine consumer like the five required fields. It warns rather than errors because a step
    // that genuinely follows no existing pattern is a real shape, unlike a step with no `Files`.
    if (!step.fields.has("References")) {
        findings.push({
            severity: "warning",
            scope: step.label,
            message: "no `References` field. The worker briefing inlines it, so the worker gets no pattern to follow.",
        });
    }
}

/**
 * Validates a plan file's machine-readable shape and returns every deviation.
 *
 * Pure over the file's text so the rules stay testable without a filesystem. It checks only what a
 * downstream consumer parses; prose quality is the Stage 5.5 reviewer's job, not this one's.
 */
export function checkPlan(source: string): Finding[] {
    const findings: Finding[] = [];
    const lines = source.split("\n");
    const steps = parseSteps(lines);

    checkCounts(source, lines, steps, findings);
    for (const step of steps) {
        checkStep(step, findings);
    }

    if (lines.some((line) => line.trim() === "<fill>")) {
        findings.push({
            severity: "error",
            scope: "sections",
            message: "at least one section is still the scaffold's `<fill>` placeholder.",
        });
    }

    // The stub's own comment block. Its steps can all be replaced with real ones while the twenty
    // lines explaining the shape stay behind, which no other check sees: the comment carries no
    // field and no checkbox, so it ships into a plan that otherwise passes.
    if (lines.some((line) => line.includes("<!-- Keep this shape"))) {
        findings.push({
            severity: "warning",
            scope: "sections",
            message: "the scaffold's step-shape comment is still in the file. Delete it.",
        });
    }

    // Written by `plan-scaffold --auto-mode`, which takes it from the Stage 4 answer. A plan that
    // lost the value lost the gate, and Stage 6a reads this field rather than an in-context
    // variable precisely because compaction is what ate it the one time this failed.
    const autoMode = /^\*\*Auto mode\*\*\s*:\s*(.*)$/m.exec(source)?.[1]?.trim();
    if (autoMode === undefined) {
        findings.push({
            severity: "error",
            scope: "frontmatter",
            message: "no `**Auto mode**:` line. Stage 6a reads it to decide whether to chain into /ac:execute.",
        });
    } else if (autoMode !== "true" && autoMode !== "false") {
        findings.push({
            severity: "error",
            scope: "frontmatter",
            message: `\`**Auto mode**\` is \`${autoMode}\`; must be true or false.`,
        });
    }

    return findings;
}

/**
 * Counts the steps and the ticked ones.
 *
 * Phase 1g holds both: the total is what every later Layer D comparison runs against, and the
 * difference is what earlier runs completed on a resume. It is reported on a clean exit too, since
 * an exit code alone gives the caller nothing to hold.
 */
export function countSteps(source: string): { checkedCount: number; stepCount: number } {
    const steps = parseSteps(source.split("\n"));
    return {
        checkedCount: steps.filter((step) => step.checked).length,
        stepCount: steps.length,
    };
}

/**
 * Resolves the slug or path to a plan file and checks it.
 *
 * Throws when the file does not exist, because a caller asking to validate a plan that is not there
 * has a different problem from a plan that is malformed, and reporting it as zero findings would
 * read as a pass.
 */
export function runPlanCheck(target: string, opts: { dir: string }): CheckResult {
    const planPath = target.includes("/")
        ? target
        : join(opts.dir, ".ac", "plans", target, "plan.md");

    if (!existsSync(planPath)) {
        throw new Error(`Plan not found at ${planPath}`);
    }

    const source = readFileSync(planPath, "utf8");
    const findings = checkPlan(source);
    return {
        planPath,
        findings,
        errorCount: findings.filter((finding) => finding.severity === "error").length,
        warningCount: findings.filter((finding) => finding.severity === "warning").length,
        ...countSteps(source),
    };
}

/** Renders one line per finding plus the counts, in a shape a reader and a grep both handle. */
export function formatCheckResult(result: CheckResult): string {
    const lines = [`plan-check: ${result.planPath}`, ""];

    for (const finding of result.findings) {
        const tag = finding.severity === "error" ? "ERROR" : "WARN ";
        lines.push(`${tag}  ${finding.scope}: ${finding.message}`);
    }

    if (result.findings.length > 0) {
        lines.push("");
    } else {
        lines.push("OK. Shape matches what /ac:execute parses.", "");
    }

    // The counts print on every exit, clean included. Phase 1g is told to hold them, and on a clean
    // run the only other output was a pass line, which left that instruction unexecutable.
    const unchecked = result.stepCount - result.checkedCount;
    lines.push(
        `${result.stepCount} steps, ${result.checkedCount} checked, ${unchecked} unchecked`
            + ` | ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
    );
    return lines.join("\n");
}
