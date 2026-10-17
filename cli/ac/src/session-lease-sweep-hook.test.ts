import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, but CI only runs `bun test` here, so this is where
// its contract is pinned: SessionEnd returns inside the 1.5 s budget and the detached sweep stops
// the session's leased process, `resume` leaves it, SessionStart `startup` sweeps dead owners only,
// and a missing tool changes nothing. The bundle must be built; `lease add` is bypassed because it
// needs a claude ancestor, so lease lines are written directly with the field names of lease.ts.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "session-lease-sweep.sh",
);

const HOOK_BUDGET_MILLIS = 1_000;
const SWEEP_WAIT_MILLIS = 5_000;
const STAYS_RUNNING_MILLIS = 1_500;

let scratch: string;
let leaseDir: string;
let spawned: Bun.Subprocess[];

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac-lease-hook-"));
    leaseDir = join(scratch, "ac-leases");
    mkdirSync(leaseDir, { mode: 0o700 });
    spawned = [];
});

afterEach(() => {
    for (const proc of spawned) {
        proc.kill("SIGKILL");
    }
    rmSync(scratch, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    millis: number;
}

function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const started = Date.now();
    const result = Bun.spawnSync(["/bin/sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            TMPDIR: scratch,
            // Keeps the sandbox store candidate inside scratch, never this machine's /tmp/claude-<uid>.
            CLAUDE_CODE_TMPDIR: join(scratch, "sandbox"),
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        millis: Date.now() - started,
    };
}

function sessionEnd(session: string, reason: string): string {
    return JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: session,
        reason,
    });
}

function sessionStart(source: string): string {
    return JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "fresh",
        source,
    });
}

function lstartOf(pid: number): string {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
        env: {
            ...process.env,
            LC_ALL: "C",
        },
    });

    return result.stdout.toString().trim();
}

/** A `sleep` that the sweep is allowed to stop; killed in afterEach whatever the outcome. */
function startSleeper(seconds: number): { proc: Bun.Subprocess; command: string } {
    const proc = Bun.spawn(["sleep", String(seconds)]);
    spawned.push(proc);

    return {
        proc,
        command: `sleep ${seconds}`,
    };
}

function writePidLease(
    session: string,
    target: { proc: Bun.Subprocess; command: string },
    owner: { pid: number; lstart: string },
): void {
    const lease = {
        session,
        kind: "pid",
        pid: target.proc.pid,
        lstart: lstartOf(target.proc.pid),
        command: target.command,
        match: target.command,
        ownerPid: owner.pid,
        ownerLstart: owner.lstart,
        createdAt: new Date().toISOString(),
    };
    writeFileSync(join(leaseDir, `${session}.jsonl`), JSON.stringify(lease) + "\n", { mode: 0o600 });
}

function liveOwner(): { pid: number; lstart: string } {
    return {
        pid: process.pid,
        lstart: lstartOf(process.pid),
    };
}

/** `exited` resolves once Bun has reaped the child, so a zombie left by SIGTERM does not count as running. */
async function exitsWithin(proc: Bun.Subprocess, millis: number): Promise<boolean> {
    return Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(millis).then(() => false),
    ]);
}

test("SessionEnd returns inside the budget and the detached sweep stops the leased process", async () => {
    const sleeper = startSleeper(300);
    writePidLease("t1", sleeper, liveOwner());

    const result = runHook(sessionEnd("t1", "prompt_input_exit"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.millis).toBeLessThan(HOOK_BUDGET_MILLIS);
    expect(await exitsWithin(sleeper.proc, SWEEP_WAIT_MILLIS)).toBe(true);
});

test("SessionEnd with reason resume leaves the leased process running", async () => {
    const sleeper = startSleeper(301);
    writePidLease("t1", sleeper, liveOwner());

    const result = runHook(sessionEnd("t1", "resume"));

    expect(result).toMatchObject({
        exitCode: 0,
        stdout: "",
    });
    expect(await exitsWithin(sleeper.proc, STAYS_RUNNING_MILLIS)).toBe(false);
});

test("SessionStart sweeps leases of a dead owner on startup only, and keeps a live owner's", async () => {
    const orphan = startSleeper(302);
    const owned = startSleeper(303);
    writePidLease(
        "dead",
        orphan,
        {
            pid: 999_999,
            lstart: "Mon Jan  1 00:00:00 2024",
        },
    );
    writePidLease("live", owned, liveOwner());

    const resumed = runHook(sessionStart("resume"));
    expect(resumed).toMatchObject({
        exitCode: 0,
        stdout: "",
    });
    expect(await exitsWithin(orphan.proc, STAYS_RUNNING_MILLIS)).toBe(false);

    const started = runHook(sessionStart("startup"));
    expect(started).toMatchObject({
        exitCode: 0,
        stdout: "",
    });
    expect(await exitsWithin(orphan.proc, SWEEP_WAIT_MILLIS)).toBe(true);
    expect(await exitsWithin(owned.proc, STAYS_RUNNING_MILLIS)).toBe(false);
});

test("a missing node exits silently and sweeps nothing", async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    for (const tool of ["jq", "cat", "dirname"]) {
        const path = Bun.which(tool);
        expect(path).not.toBeNull();
        symlinkSync(path as string, join(bin, tool));
    }
    chmodSync(bin, 0o700);
    const sleeper = startSleeper(304);
    writePidLease("t1", sleeper, liveOwner());

    const result = runHook(
        sessionEnd("t1", "other"),
        { PATH: bin },
    );

    expect(result).toMatchObject({
        exitCode: 0,
        stdout: "",
        stderr: "",
    });
    expect(await exitsWithin(sleeper.proc, STAYS_RUNNING_MILLIS)).toBe(false);
});

/** A PATH with the tools the hook needs and a fake `node` that only records that it was started. */
function fakeNodePath(): { path: string; marker: string } {
    const bin = join(scratch, "fake-bin");
    const marker = join(scratch, "node-started");
    mkdirSync(bin);
    for (const tool of ["jq", "cat", "dirname", "id"]) {
        const path = Bun.which(tool);
        expect(path).not.toBeNull();
        symlinkSync(path as string, join(bin, tool));
    }
    writeFileSync(join(bin, "node"), `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o700 });
    chmodSync(bin, 0o700);

    return {
        path: bin,
        marker,
    };
}

test("SessionEnd without the session's lease file in either store exits 0 without starting node", () => {
    const fake = fakeNodePath();
    writeFileSync(join(leaseDir, "other.jsonl"), "", { mode: 0o600 });

    const result = runHook(sessionEnd("t1", "other"), { PATH: fake.path });

    expect(result).toMatchObject({
        exitCode: 0,
        stdout: "",
        stderr: "",
    });
    expect(existsSync(fake.marker)).toBe(false);
});

test("SessionStart startup with no lease file in either store exits 0 without starting node", () => {
    const fake = fakeNodePath();
    rmSync(leaseDir, { recursive: true });

    const result = runHook(sessionStart("startup"), { PATH: fake.path });

    expect(result.exitCode).toBe(0);
    expect(existsSync(fake.marker)).toBe(false);
});

test("a lease file in either store starts the sweep", () => {
    const fake = fakeNodePath();
    const sandboxStore = join(scratch, "sandbox", `claude-${process.getuid?.()}`, "ac-leases");
    mkdirSync(sandboxStore, { mode: 0o700, recursive: true });
    writeFileSync(join(sandboxStore, "t1.jsonl"), "", { mode: 0o600 });

    runHook(sessionEnd("t1", "other"), { PATH: fake.path });
    runHook(sessionStart("startup"), { PATH: fake.path });

    expect(readFileSync(fake.marker, "utf8").split("\n").filter((line) => line !== "")).toEqual([
        expect.stringContaining("lease sweep --session t1 --reason other --detach"),
        expect.stringContaining("lease sweep --stale --detach"),
    ]);
});
