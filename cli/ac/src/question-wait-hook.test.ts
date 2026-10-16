import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
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

function run(cmd: string[], stdin: string, env: Record<string, string> = {}): HookResult {
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
            ...env,
        },
    });

    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function runGuard(script: string, transcript: string = "", session: string = SESSION): HookResult {
    return run(["sh", script], payload(session, transcript));
}

// Sources the lib the way the guards do and calls one function; the exit code is the function's.
function runLib(call: string, session: string): HookResult {
    return run(["sh", "-c", `. "${LIB}"; ${call} "$1"`, "sh", session], "");
}

function payload(session: string, transcript: string = "", extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        cwd: project,
        transcript_path: transcript,
        stop_hook_active: false,
        background_tasks: [],
        ...extra,
    });
}

function latchPath(session: string = SESSION): string {
    return join(scratch, `ac-question-wait-${session}`);
}

function writeLatch(epochOffsetSeconds: number = 0): number {
    const epoch = Math.floor(Date.now() / 1000) + epochOffsetSeconds;
    writeFileSync(latchPath(), `${epoch}\n`);

    return epoch;
}

// A transcript whose mtime sits a fixed number of seconds after the latch epoch: the waiting turn writes
// its one line right after the hook armed the latch, and a user reply plus more work moves it far past.
function writeTranscript(latchEpoch: number, secondsAfterLatch: number): string {
    const path = join(root, "transcript.jsonl");
    const mtime = latchEpoch + secondsAfterLatch;
    writeFileSync(path, "{}\n");
    utimesSync(path, mtime, mtime);

    return path;
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

test("a transcript touched more than 120 seconds after the latch means the user is back, so the guards block", () => {
    seedAutoRun();
    seedExecuteRun();
    const transcript = writeTranscript(writeLatch(-400), 300);

    expectBlock(runGuard(GUARD, transcript));
    expectBlock(runGuard(AUTO_GUARD, transcript));
});

test("a transcript touched within 120 seconds of the latch still allows every guard", () => {
    seedAutoRun();
    seedExecuteRun();
    const transcript = writeTranscript(writeLatch(-30), 5);

    expectAllow(runGuard(GUARD, transcript));
    expectAllow(runGuard(AUTO_GUARD, transcript));
    expect(existsSync(latchPath())).toBe(true);
});

test("an unreadable transcript path leaves the latch age to decide", () => {
    seedAutoRun();
    seedExecuteRun();
    writeLatch();
    const missing = join(root, "absent.jsonl");

    expectAllow(runGuard(GUARD, missing));
    expectAllow(runGuard(AUTO_GUARD, missing));
});

// The announce guard only reaches the latch after its early exits, so the stub judge and an ending the
// regex stage matches are what make these tests mean something: without a latch it must block.
function announceEnv(): Record<string, string> {
    const bin = join(root, "judge-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"structured_output":{"ok":false}}'\n`,
        { mode: 0o755 },
    );
    expect(Bun.which("rg")).not.toBeNull();
    expect(Bun.which("perl")).not.toBeNull();

    return { PATH: `${bin}:${process.env.PATH ?? ""}`, ANTHROPIC_BASE_URL: "", CLAUDE_CODE_ENTRYPOINT: "cli" };
}

function runAnnounce(transcript: string = ""): HookResult {
    const stdin = payload(SESSION, transcript, {
        last_assistant_message: "I fixed the parser and the tests pass.\n\nWant me to continue with the docs?",
    });

    return run(["sh", ANNOUNCE_GUARD], stdin, announceEnv());
}

function expectAnnounceBlock(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: string } };
    expect(output.hookSpecificOutput?.hookEventName).toBe("Stop");
}

test("stop-guard-announce.sh blocks an offer without a latch and stays silent with a fresh one", () => {
    expectAnnounceBlock(runAnnounce());

    rmSync(join(scratch, `ac-announce-guard-${SESSION}`), { force: true });
    writeLatch();
    expectAllow(runAnnounce());
    expect(existsSync(latchPath())).toBe(true);
});

test("stop-guard-announce.sh blocks once the transcript shows the user came back", () => {
    const transcript = writeTranscript(writeLatch(-400), 300);

    expectAnnounceBlock(runAnnounce(transcript));
});

test("stop-guard-announce.sh stays silent when the transcript is fresh against the latch", () => {
    const transcript = writeTranscript(writeLatch(-30), 5);

    expectAllow(runAnnounce(transcript));
});
