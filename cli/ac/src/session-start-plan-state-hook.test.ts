import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// session-start-plan-state.sh surfaces an active plan as resume context. The coordinator note is the
// addition under test: it appears only for the session that owns active-coordinate.json, and the
// execute-marker output stays exactly what it was.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "session-start-plan-state.sh",
);

const SESSION = "sess-ss-1";
const PLAN = "demo-plan";

let root: string;
let project: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-session-start-plan-state-"));
    project = join(root, "project");
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function runHook(session: string = SESSION, source: string = "resume"): string {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(
            JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: project, source }),
        ),
        env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });
    expect(result.exitCode).toBe(0);

    return result.stdout.toString();
}

function context(stdout: string): string {
    const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");

    return output.hookSpecificOutput.additionalContext;
}

function writeCoordinateMarker(fields: Record<string, unknown> = {}): void {
    writeFileSync(
        join(project, ".ac", "state", "active-coordinate.json"),
        JSON.stringify({
            slug: "ship-auth",
            session_id: SESSION,
            started_at: "2026-10-19T08:00:00Z",
            phase: "dispatch",
            note: "b1 executing, b2 waiting on b1",
            ...fields,
        }),
    );
}

function writePlan(): void {
    mkdirSync(join(project, ".ac", "plans", PLAN), { recursive: true });
    writeFileSync(join(project, ".ac", "plans", PLAN, "plan.md"), "# Plan\n\n- [ ] **Step 1**: first\n- [x] **Step 2**: second\n");
}

test("surfaces the slug, phase and note of a coordinator run this session owns", () => {
    mkdirSync(join(project, ".ac", "plans"), { recursive: true });
    writeCoordinateMarker();

    const text = context(runHook());

    expect(text).toContain("/ac:coordinate");
    expect(text).toContain("ship-auth");
    expect(text).toContain("dispatch");
    expect(text).toContain("b1 executing, b2 waiting on b1");
});

test("surfaces the coordinator note when no .ac/plans directory exists", () => {
    writeCoordinateMarker();

    expect(context(runHook())).toContain("ship-auth");
});

test("adds the coordinator note after the active plan block without changing it", () => {
    writePlan();
    const without = context(runHook());

    writeCoordinateMarker();
    const withNote = context(runHook());

    expect(withNote).toContain("Active plan: demo-plan (1 of 2 steps checked, 1 unchecked)");
    expect(withNote).toContain("ship-auth");
    expect(withNote.startsWith(without)).toBe(true);
});

test("stays silent about a coordinator run another session owns", () => {
    mkdirSync(join(project, ".ac", "plans"), { recursive: true });
    writeCoordinateMarker({ session_id: "sess-other" });

    expect(runHook()).toBe("");
});

test("a slug outside the allowed charset is never used in a path or surfaced", () => {
    writePlan();
    writeCoordinateMarker({ slug: "../escape" });

    const text = context(runHook());

    expect(text).not.toContain("escape");
    expect(text).toContain("Active plan: demo-plan");
});

test("an execute marker alone produces the same output as before", () => {
    writePlan();
    writeFileSync(
        join(project, ".ac", "state", "active-execution.json"),
        JSON.stringify({ slug: PLAN, session_id: SESSION, current_wave: 2, note: "wave two" }),
    );

    const text = context(runHook());

    expect(text).toContain("Marker .ac/state/active-execution.json reports wave 2");
    expect(text).toContain("Marker note: wave two");
    expect(text).not.toContain("coordinate");
});
