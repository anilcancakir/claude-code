import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// stop-guard.sh reads one marker per running plan from .ac/state/execute/<slug>.json. The contract
// pinned here: a session is blocked only by the markers it owns, a session owning two runs hears about
// both, and each run keeps its own block counter beside its marker.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "stop-guard.sh",
);

const SESSION = "sess-sg-1";
const OTHER = "sess-sg-2";

let root: string;
let project: string;
let scratch: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-stop-guard-"));
    project = join(root, "project");
    scratch = join(root, "tmp");
    mkdirSync(join(project, ".ac", "state", "execute"), { recursive: true });
    mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

interface Block {
    decision: string;
    reason: string;
    systemMessage: string;
}

function runGuard(session: string = SESSION, env: Record<string, string> = {}): HookResult {
    const stdin = JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        cwd: project,
        transcript_path: "",
        stop_hook_active: false,
        background_tasks: [],
    });
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            TMPDIR: scratch,
            CLAUDE_PROJECT_DIR: "",
            AC_STOP_GUARD_MAX_BLOCKS: "",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function isoNow(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function markerPath(slug: string): string {
    return join(project, ".ac", "state", "execute", `${slug}.json`);
}

function counterPath(slug: string): string {
    return join(project, ".ac", "state", "execute", `${slug}.stop-guard.json`);
}

function seedRun(slug: string, session: string = SESSION, wave: number = 1): void {
    mkdirSync(join(project, ".ac", "plans", slug), { recursive: true });
    writeFileSync(join(project, ".ac", "plans", slug, "plan.md"), `# Plan\n\n- [ ] **Step 1**: ${slug} next\n`);
    writeFileSync(
        markerPath(slug),
        JSON.stringify({ slug, session_id: session, started_at: isoNow(), current_wave: wave, pid: 0 }),
    );
}

function block(result: HookResult): Block {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as Block;
    expect(output.decision).toBe("block");

    return output;
}

function expectAllow(result: HookResult): void {
    expect(result).toEqual({
        exitCode: 0,
        stdout: "",
    });
}

test("a single owned run blocks with the same reason as before, naming its per-slug marker", () => {
    seedRun("demo");

    const output = block(runGuard());

    expect(output.reason).toContain("An /ac:execute run for 'demo' is still in flight");
    expect(output.reason).toContain("State from disk: wave 1, 0 of 1 steps checked, 1 unchecked.");
    expect(output.reason).toContain("Next unchecked step: demo next");
    expect(output.reason).toContain("delete .ac/state/execute/demo.json and stop");
    expect(output.systemMessage).toBe("ac stop-guard: blocked stop 1/10 | demo wave 1, 1/1 steps unchecked");
    expect(JSON.parse(readFileSync(counterPath("demo"), "utf8")).blocks).toBe(1);
});

test("no marker means the guard is dormant", () => {
    expectAllow(runGuard());
});

test("two runs of two sessions in one checkout do not affect each other", () => {
    seedRun("mine", SESSION);
    seedRun("theirs", OTHER);

    const mine = block(runGuard(SESSION));
    expect(mine.reason).toContain("'mine'");
    expect(mine.reason).not.toContain("theirs");
    expect(existsSync(counterPath("mine"))).toBe(true);
    expect(existsSync(counterPath("theirs"))).toBe(false);

    const theirs = block(runGuard(OTHER));
    expect(theirs.reason).toContain("'theirs'");
    expect(theirs.reason).not.toContain("mine");
    expect(JSON.parse(readFileSync(counterPath("mine"), "utf8")).blocks).toBe(1);
    expect(JSON.parse(readFileSync(counterPath("theirs"), "utf8")).blocks).toBe(1);
});

test("a session with no marker of its own is not blocked by another session's run", () => {
    seedRun("theirs", OTHER);

    expectAllow(runGuard(SESSION));
});

test("one session owning two runs is blocked with both slugs named and one counter each", () => {
    seedRun("alpha", SESSION, 1);
    seedRun("beta", SESSION, 2);

    const output = block(runGuard());

    expect(output.reason).toContain("'alpha'");
    expect(output.reason).toContain("'beta'");
    expect(output.reason).toContain(".ac/state/execute/alpha.json");
    expect(output.reason).toContain(".ac/state/execute/beta.json");
    expect(output.reason).toContain("Next unchecked step: alpha next");
    expect(output.reason).toContain("Next unchecked step: beta next");
    expect(output.systemMessage).toContain("alpha wave 1");
    expect(output.systemMessage).toContain("beta wave 2");
    expect(JSON.parse(readFileSync(counterPath("alpha"), "utf8")).blocks).toBe(1);
    expect(JSON.parse(readFileSync(counterPath("beta"), "utf8")).blocks).toBe(1);
});

test("counters are per slug: one run's spent budget does not silence the other", () => {
    seedRun("alpha");
    block(runGuard(SESSION, { AC_STOP_GUARD_MAX_BLOCKS: "1" }));
    expectAllow(runGuard(SESSION, { AC_STOP_GUARD_MAX_BLOCKS: "1" }));
    expect(JSON.parse(readFileSync(counterPath("alpha"), "utf8")).spent).toBe(true);

    seedRun("beta");
    const output = block(runGuard(SESSION, { AC_STOP_GUARD_MAX_BLOCKS: "1" }));

    expect(output.reason).toContain("'beta'");
    expect(output.reason).not.toContain("'alpha'");
});

test("a marker file whose name is not a plain slug is ignored", () => {
    seedRun("demo");
    rmSync(markerPath("demo"));
    writeFileSync(
        join(project, ".ac", "state", "execute", "bad slug.json"),
        JSON.stringify({ slug: "demo", session_id: SESSION, started_at: isoNow(), current_wave: 1 }),
    );

    expectAllow(runGuard());
});
