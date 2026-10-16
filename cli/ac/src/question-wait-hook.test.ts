import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The question-wait latch is how a turn that ends to wait for a timed-out AskUserQuestion gets past
// the three Stop guards. The guards are parallel registrations, so the contract pinned here is that
// a fresh latch allows every one of them and that no guard consumes it.
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac", "hooks");
const GUARD = join(HOOKS, "stop-guard.sh");
const AUTO_GUARD = join(HOOKS, "stop-guard-auto.sh");
const ANNOUNCE_GUARD = join(HOOKS, "stop-guard-announce.sh");
const LIB = join(HOOKS, "lib", "question-wait.sh");

const SESSION = "sess-qw-1";
const SLUG = "demo";

let root: string;
let project: string;
let scratch: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-question-wait-"));
    project = join(root, "project");
    scratch = join(root, "tmp");
    mkdirSync(project, { recursive: true });
    mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function run(cmd: string[], stdin: string): HookResult {
    const result = Bun.spawnSync(cmd, {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            TMPDIR: scratch,
            CLAUDE_PROJECT_DIR: "",
            AC_STOP_GUARD_MAX_BLOCKS: "",
            AC_AUTO_MAX_BLOCKS: "",
            AC_ANNOUNCE_JUDGE: "",
            CLAUDE_CODE_ENTRYPOINT: "",
        },
    });

    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function runGuard(script: string, session: string = SESSION): HookResult {
    return run(["sh", script], payload(session));
}

// Sources the lib the way the guards do and calls one function; the exit code is the function's.
function runLib(call: string, session: string): HookResult {
    return run(["sh", "-c", `. "${LIB}"; ${call} "$1"`, "sh", session], "");
}

function payload(session: string): string {
    return JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        cwd: project,
        transcript_path: "",
        stop_hook_active: false,
        background_tasks: [],
    });
}

function latchPath(session: string = SESSION): string {
    return join(scratch, `ac-question-wait-${session}`);
}

function writeLatch(epochOffsetSeconds: number = 0): void {
    const epoch = Math.floor(Date.now() / 1000) + epochOffsetSeconds;
    writeFileSync(latchPath(), `${epoch}\n`);
}

function isoNow(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function seedAutoRun(): void {
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-auto.json"),
        JSON.stringify({ session_id: SESSION, slug: SLUG, started_at: isoNow(), phase: "executing", pid: 0 }),
    );
}

function seedExecuteRun(): void {
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    mkdirSync(join(project, ".ac", "plans", SLUG), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-execution.json"),
        JSON.stringify({ session_id: SESSION, slug: SLUG, started_at: isoNow(), current_wave: 1, pid: 0 }),
    );
    writeFileSync(join(project, ".ac", "plans", SLUG, "plan.md"), "# Plan\n\n- [ ] **Step 1**: x\n");
}

function expectBlock(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as { decision?: string }).decision).toBe("block");
}

function expectAllow(result: HookResult): void {
    expect(result).toEqual({ exitCode: 0, stdout: "" });
}

test("stop-guard-auto.sh blocks without a latch and allows with a fresh one", () => {
    seedAutoRun();

    expectBlock(runGuard(AUTO_GUARD));

    writeLatch();
    expectAllow(runGuard(AUTO_GUARD));
});

test("stop-guard.sh blocks without a latch and allows with a fresh one", () => {
    seedExecuteRun();

    expectBlock(runGuard(GUARD));

    writeLatch();
    expectAllow(runGuard(GUARD));
});

test("both run guards allow on one latch and neither consumes it", () => {
    seedAutoRun();
    seedExecuteRun();
    writeLatch();

    expectAllow(runGuard(GUARD));
    expectAllow(runGuard(AUTO_GUARD));

    expect(existsSync(latchPath())).toBe(true);
});

test("a latch older than 600 seconds no longer allows the stop", () => {
    seedAutoRun();
    seedExecuteRun();
    writeLatch(-700);

    expectBlock(runGuard(GUARD));
    expectBlock(runGuard(AUTO_GUARD));
});

test("a latch for another session does not allow the stop", () => {
    seedAutoRun();
    writeFileSync(latchPath("sess-other"), `${Math.floor(Date.now() / 1000)}\n`);

    expectBlock(runGuard(AUTO_GUARD));
});

test("a symlinked latch is refused", () => {
    seedAutoRun();
    const target = join(root, "target");
    writeFileSync(target, `${Math.floor(Date.now() / 1000)}\n`);
    Bun.spawnSync(["ln", "-s", target, latchPath()]);

    expectBlock(runGuard(AUTO_GUARD));
});

test("qw_arm writes the epoch, qw_active reads it and qw_clear removes it", () => {
    expect(runLib("qw_active", SESSION).exitCode).not.toBe(0);

    expect(runLib("qw_arm", SESSION).exitCode).toBe(0);
    expect(Number(readFileSync(latchPath(), "utf8").trim())).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
    expect(runLib("qw_active", SESSION).exitCode).toBe(0);
    expect(existsSync(latchPath())).toBe(true);

    expect(runLib("qw_clear", SESSION).exitCode).toBe(0);
    expect(existsSync(latchPath())).toBe(false);
    expect(runLib("qw_active", SESSION).exitCode).not.toBe(0);
});

test("a session id with a slash or dot-dot never creates a file outside TMPDIR", () => {
    for (const session of ["../escape", "a/b", "..", "x y", ""]) {
        expect(runLib("qw_arm", session).exitCode).not.toBe(0);
    }

    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(["project", "tmp"]);
});

test("stop-guard-announce.sh exits silently with a fresh latch", () => {
    writeLatch();

    expectAllow(runGuard(ANNOUNCE_GUARD));
    expect(existsSync(latchPath())).toBe(true);
});
