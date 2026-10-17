import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    addLease,
    defaultLeaseDeps,
    LeaseError,
    releaseLeases,
    sweepLeases,
} from "./lease.ts";
import type { LeaseDeps, ProcessProbe, RunOutcome } from "./lease.ts";

const INDEX = new URL("./index.ts", import.meta.url).pathname;
const ORIGINAL_TMPDIR = process.env.TMPDIR;

let scratch = "";
let session = "";
const bunChildren: Subprocess[] = [];
const nodeChildren: ChildProcess[] = [];

beforeEach(() => {
    scratch = mkdtempSync(join(ORIGINAL_TMPDIR ?? "/tmp", "ac-lease-test-"));
    process.env.TMPDIR = scratch;
    session = `test-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
    while (bunChildren.length > 0) {
        bunChildren.pop()?.kill("SIGKILL");
    }
    while (nodeChildren.length > 0) {
        nodeChildren.pop()?.kill("SIGKILL");
    }
    process.env.TMPDIR = ORIGINAL_TMPDIR;
    rmSync(scratch, { force: true, recursive: true });
});

type RunCall = {
    file: string;
    args: string[];
};

/** Deps against the scratch TMPDIR, the test runner as the owning claude process, and a recording executor. */
function testDeps(overrides: Partial<LeaseDeps> = {}, outcome: RunOutcome = { status: "ok" }): {
    deps: LeaseDeps;
    runs: RunCall[];
    relaunches: string[][];
} {
    const runs: RunCall[] = [];
    const relaunches: string[][] = [];
    const defaults = defaultLeaseDeps();
    const deps: LeaseDeps = {
        ...defaults,
        env: {
            CLAUDE_CODE_SESSION_ID: session,
        },
        // A scratch sandbox store, so no test ever reads this machine's real /tmp/claude-<uid> store.
        sandboxLeaseDir: sandboxDir(),
        // The runner may sit on a terminal when a person runs the suite; its children would inherit it.
        probe: {
            ...defaults.probe,
            tty: (): string => "??",
        },
        // No real adb is ever asked for an AVD name.
        output: (): string | undefined => undefined,
        findOwner: () => process.pid,
        run: async (file: string, args: string[]): Promise<RunOutcome> => {
            runs.push({
                file,
                args,
            });
            return outcome;
        },
        spawnDetached: (argv: string[]): void => {
            relaunches.push(argv);
        },
        ...overrides,
    };
    return {
        deps,
        runs,
        relaunches,
    };
}

function leaseDir(): string {
    return join(scratch, "ac-leases");
}

function sandboxDir(): string {
    return join(scratch, "sandbox", "claude-test", "ac-leases");
}

function leaseFile(id: string = session, dir: string = leaseDir()): string {
    return join(dir, `${id}.jsonl`);
}

function storedLeases(id: string = session, dir: string = leaseDir()): Record<string, unknown>[] {
    return readFileSync(leaseFile(id, dir), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function startSleep(): Subprocess {
    const child = Bun.spawn(
        [
            "sleep",
            "300",
        ],
        {
            stdio: [
                "ignore",
                "ignore",
                "ignore",
            ],
        },
    );
    bunChildren.push(child);
    return child;
}

async function exitsWithin(child: Subprocess, millis: number): Promise<boolean> {
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), millis));
    return Promise.race([
        child.exited.then(() => true),
        timeout,
    ]);
}

function isAlive(pid: number): boolean {
    return Bun.spawnSync([
        "ps",
        "-o",
        "pid=",
        "-p",
        String(pid),
    ]).exitCode === 0;
}

/** Writes a lease directory and file by hand, the way Step 6's hook test does. */
function writeLeaseLines(id: string, lines: Record<string, unknown>[], dir: string = leaseDir()): void {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    chmodSync(dir, 0o700);
    writeFileSync(leaseFile(id, dir), lines.map((line) => JSON.stringify(line) + "\n").join(""), { mode: 0o600 });
    chmodSync(leaseFile(id, dir), 0o600);
}

function ownLstart(): string {
    const lstart = defaultLeaseDeps().probe.lstart(process.pid);
    if (lstart === undefined) {
        throw new Error("cannot read the test runner's start time");
    }
    return lstart;
}

async function deadPid(): Promise<number> {
    const child = Bun.spawn([
        "true",
    ]);
    await child.exited;
    return child.pid;
}

function serialLease(id: string, ownerPid: number, ownerLstart: string): Record<string, unknown> {
    return {
        session: id,
        kind: "adb-emu",
        serial: "emulator-5554",
        ownerPid,
        ownerLstart,
        createdAt: new Date().toISOString(),
    };
}

test("the lease directory follows TMPDIR", () => {
    expect(defaultLeaseDeps().leaseDir).toBe(leaseDir());
});

test("a pid lease on a live child is recorded, and the sweep stops the child and deletes the file", async () => {
    const child = startSleep();
    const { deps } = testDeps();

    const lease = addLease(
        {
            kind: "pid",
            pid: String(child.pid),
            match: "sleep 300",
            label: "fixture",
        },
        deps,
    );

    expect(lease.session).toBe(session);
    expect(lease.pid).toBe(child.pid);
    expect(lease.ownerPid).toBe(process.pid);
    expect(lease.command).toContain("sleep 300");
    expect(statSync(leaseDir()).mode & 0o777).toBe(0o700);
    expect(statSync(leaseFile()).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(readFileSync(leaseFile(), "utf8").trim()) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
        "command",
        "createdAt",
        "kind",
        "label",
        "lstart",
        "match",
        "ownerLstart",
        "ownerPid",
        "pid",
        "session",
    ]);

    const report = await sweepLeases({ session }, deps);

    expect(await exitsWithin(child, 3000)).toBe(true);
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
        "stopped",
    ]);
    expect(existsSync(leaseFile())).toBe(false);
});

test("a pid lease whose command does not contain --match is rejected", () => {
    const child = startSleep();
    const { deps } = testDeps();

    expect(() => addLease(
        {
            kind: "pid",
            pid: String(child.pid),
            match: "node server.js",
        },
        deps,
    )).toThrow(LeaseError);
    expect(existsSync(leaseFile())).toBe(false);
});

test("a pid lease on a dead pid is rejected", async () => {
    const { deps } = testDeps();
    const pid = await deadPid();

    expect(() => addLease(
        {
            kind: "pid",
            pid: String(pid),
            match: "true",
        },
        deps,
    )).toThrow(/not running/);
});

test("a pid lease on a process that started before the owner is rejected", () => {
    const probe: ProcessProbe = {
        ...defaultLeaseDeps().probe,
        lstart: (pid: number): string => (pid === 4242 ? "Sat Oct 17 10:00:00 2026" : "Sat Oct 17 11:00:00 2026"),
        command: (): string => "sleep 300",
    };
    const { deps } = testDeps({
        probe,
        findOwner: () => 1111,
    });

    expect(() => addLease(
        {
            kind: "pid",
            pid: "4242",
            match: "sleep 300",
        },
        deps,
    )).toThrow(/started before/);
});

test.each([
    [
        {
            kind: "adb-emu",
            serial: "foo",
        },
        /serial/,
    ],
    [
        {
            kind: "playwright",
            pwSession: "a;b",
        },
        /session/,
    ],
    [
        {
            kind: "simctl",
            udid: "not-a-uuid",
        },
        /udid/,
    ],
    [
        {
            kind: "docker",
        },
        /kind/,
    ],
    [
        {
            kind: "pid",
            pid: "12x",
            match: "x",
        },
        /pid/,
    ],
])("an invalid target %p is rejected", (input, message) => {
    const { deps } = testDeps();

    expect(() => addLease(input, deps)).toThrow(message);
    expect(existsSync(leaseFile())).toBe(false);
});

test("add without CLAUDE_CODE_SESSION_ID is rejected", () => {
    const { deps } = testDeps({ env: {} });

    expect(() => addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    )).toThrow(/CLAUDE_CODE_SESSION_ID/);
});

test("add without an owning claude process is rejected", () => {
    const { deps } = testDeps({ findOwner: () => undefined });

    expect(() => addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    )).toThrow(/claude process/);
});

test("a lease directory that is a symlink is refused by add and by sweep", async () => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, leaseDir());
    const { deps, runs } = testDeps();

    expect(() => addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    )).toThrow(/symlink/);
    expect(existsSync(join(target, `${session}.jsonl`))).toBe(false);

    writeFileSync(join(target, `${session}.jsonl`), JSON.stringify(serialLease(session, 1, "x")) + "\n");
    await expect(sweepLeases({ session }, deps)).rejects.toThrow(/symlink/);
    expect(runs).toEqual([]);
});

test("a lease file with mode 0666 is refused by add and by sweep", async () => {
    writeLeaseLines(session, [
        serialLease(session, 999_999, "x"),
    ]);
    chmodSync(leaseFile(), 0o666);
    const { deps, runs } = testDeps();

    expect(() => addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5556",
        },
        deps,
    )).toThrow(/writable/);
    await expect(sweepLeases({ session }, deps)).rejects.toThrow(/writable/);
    expect(runs).toEqual([]);
    expect(existsSync(leaseFile())).toBe(true);
});

test("a target another live session still leases is skipped, and the file is still deleted", async () => {
    writeLeaseLines(session, [
        serialLease(session, await deadPid(), "Sat Oct 17 09:00:00 2026"),
    ]);
    writeLeaseLines("test-other-live", [
        serialLease("test-other-live", process.pid, ownLstart()),
    ]);
    const { deps, runs } = testDeps();

    const report = await sweepLeases({ session }, deps);

    expect(runs).toEqual([]);
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
        "skipped",
    ]);
    expect(existsSync(leaseFile())).toBe(false);
    expect(existsSync(leaseFile("test-other-live"))).toBe(true);
});

test("a target whose other lessee is dead is stopped with argv", async () => {
    writeLeaseLines(session, [
        serialLease(session, process.pid, ownLstart()),
    ]);
    writeLeaseLines("test-other-dead", [
        serialLease("test-other-dead", await deadPid(), "Sat Oct 17 09:00:00 2026"),
    ]);
    const { deps, runs } = testDeps();

    await sweepLeases({ session }, deps);

    expect(runs).toEqual([
        {
            file: "adb",
            args: [
                "-s",
                "emulator-5554",
                "emu",
                "kill",
            ],
        },
    ]);
});

test("simctl and playwright leases stop through their own argv, never close-all", async () => {
    const { deps, runs } = testDeps();
    addLease(
        {
            kind: "simctl",
            udid: "0A1B2C3D-4E5F-6789-ABCD-EF0123456789",
        },
        deps,
    );
    addLease(
        {
            kind: "playwright",
            pwSession: "qa-run.1",
        },
        deps,
    );

    await sweepLeases({ session }, deps);

    expect(runs).toEqual([
        {
            file: "xcrun",
            args: [
                "simctl",
                "shutdown",
                "0A1B2C3D-4E5F-6789-ABCD-EF0123456789",
            ],
        },
        {
            file: "playwright-cli",
            args: [
                "-s=qa-run.1",
                "close",
            ],
        },
    ]);
});

test("a missing binary is skipped and the file is still deleted", async () => {
    const { deps } = testDeps({}, { status: "missing" });
    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );

    const report = await sweepLeases({ session }, deps);

    expect(report.outcomes[0]?.status).toBe("skipped");
    expect(existsSync(leaseFile())).toBe(false);
});

test("a pid lease whose recorded lstart differs from the live process is skipped and survives", async () => {
    const child = startSleep();
    const { deps } = testDeps();
    writeLeaseLines(session, [
        {
            session,
            kind: "pid",
            pid: child.pid,
            lstart: "Sat Oct 17 09:00:00 2026",
            command: "sleep 300",
            match: "sleep 300",
            ownerPid: process.pid,
            ownerLstart: ownLstart(),
            createdAt: new Date().toISOString(),
        },
    ]);

    const report = await sweepLeases({ session }, deps);

    expect(report.outcomes[0]?.status).toBe("skipped");
    expect(await exitsWithin(child, 300)).toBe(false);
    expect(isAlive(child.pid)).toBe(true);
});

test("a pid that leads its own process group is stopped through the group", async () => {
    const child = nodeSpawn(
        "sleep",
        [
            "300",
        ],
        {
            detached: true,
            stdio: "ignore",
        },
    );
    nodeChildren.push(child);
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("spawn failed");
    }
    const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
    const signals: number[] = [];
    const { deps } = testDeps({
        kill: (target: number, signal: NodeJS.Signals): void => {
            signals.push(target);
            process.kill(target, signal);
        },
    });
    addLease(
        {
            kind: "pid",
            pid: String(pid),
            match: "sleep 300",
        },
        deps,
    );

    await sweepLeases({ session }, deps);

    expect(signals).toEqual([
        -pid,
    ]);
    expect(await Promise.race([
        exited,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])).toBe(true);
});

test("--reason resume changes nothing", async () => {
    const child = startSleep();
    const { deps, runs } = testDeps();
    addLease(
        {
            kind: "pid",
            pid: String(child.pid),
            match: "sleep 300",
        },
        deps,
    );
    const before = readFileSync(leaseFile(), "utf8");

    const report = await sweepLeases(
        {
            session,
            reason: "resume",
            detach: true,
        },
        deps,
    );

    expect(report.outcomes).toEqual([]);
    expect(runs).toEqual([]);
    expect(readFileSync(leaseFile(), "utf8")).toBe(before);
    expect(isAlive(child.pid)).toBe(true);
});

test("--detach relaunches the sweep without --detach and sweeps nothing itself", async () => {
    const { deps, runs, relaunches } = testDeps();
    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );

    const report = await sweepLeases(
        {
            session,
            reason: "logout",
            stale: true,
            detach: true,
        },
        deps,
    );

    expect(report.detached).toBe(true);
    expect(runs).toEqual([]);
    expect(existsSync(leaseFile())).toBe(true);
    expect(relaunches).toEqual([
        [
            "lease",
            "sweep",
            "--session",
            session,
            "--reason",
            "logout",
            "--stale",
        ],
    ]);
});

test("--stale sweeps only the files whose owner is gone", async () => {
    writeLeaseLines("test-stale-owner", [
        serialLease("test-stale-owner", await deadPid(), "Sat Oct 17 09:00:00 2026"),
    ]);
    writeLeaseLines("test-live-owner", [
        {
            ...serialLease("test-live-owner", process.pid, ownLstart()),
            serial: "emulator-5556",
        },
    ]);
    const { deps, runs } = testDeps({ env: {} });

    await sweepLeases({ stale: true }, deps);

    expect(runs).toEqual([
        {
            file: "adb",
            args: [
                "-s",
                "emulator-5554",
                "emu",
                "kill",
            ],
        },
    ]);
    expect(existsSync(leaseFile("test-stale-owner"))).toBe(false);
    expect(existsSync(leaseFile("test-live-owner"))).toBe(true);
});

test("a sweep session id that could leave the lease directory is rejected", async () => {
    const { deps } = testDeps();

    await expect(sweepLeases({ session: "../x" }, deps)).rejects.toThrow(LeaseError);
});

test("the CLI registers lease add and rejects an invalid serial with one stderr line", () => {
    const result = Bun.spawnSync(
        [
            "bun",
            INDEX,
            "lease",
            "add",
            "--kind",
            "adb-emu",
            "--serial",
            "foo",
        ],
        {
            env: {
                ...process.env,
                TMPDIR: scratch,
                CLAUDE_CODE_SESSION_ID: session,
            },
        },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(existsSync(leaseFile())).toBe(false);
});

test("the CLI sweep with --reason resume exits 0 and leaves the file", async () => {
    // A dead pid, so a broken resume guard would find nothing real to stop on this machine.
    writeLeaseLines(session, [
        {
            session,
            kind: "pid",
            pid: await deadPid(),
            lstart: "Sat Oct 17 09:00:00 2026",
            command: "true",
            match: "true",
            ownerPid: process.pid,
            ownerLstart: ownLstart(),
            createdAt: new Date().toISOString(),
        },
    ]);

    const result = Bun.spawnSync(
        [
            "bun",
            INDEX,
            "lease",
            "sweep",
            "--session",
            session,
            "--reason",
            "resume",
        ],
        {
            env: {
                ...process.env,
                TMPDIR: scratch,
            },
        },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(leaseFile())).toBe(true);
});

/** A probe where every pid is alive with one start time and runs `sleep 300`; tests using it never signal for real. */
function fakeProbe(lstart: string): ProcessProbe {
    return {
        lstart: (): string => lstart,
        command: (): string => "sleep 300",
        comm: (): string => "sleep",
        ppid: (): undefined => undefined,
        pgid: (): undefined => undefined,
        tty: (): string => "??",
    };
}

function fakePidLease(id: string, pid: number, ownerLstart: string): Record<string, unknown> {
    return {
        session: id,
        kind: "pid",
        pid,
        lstart: "Sat Oct 17 12:00:00 2026",
        command: "sleep 300",
        match: "sleep 300",
        ownerPid: 4000,
        ownerLstart,
        createdAt: new Date().toISOString(),
    };
}

const ADB_KILL_5554: RunCall = {
    file: "adb",
    args: [
        "-s",
        "emulator-5554",
        "emu",
        "kill",
    ],
};

test("--stale stops only the entries whose own owner is gone and keeps the live owner's in the file", async () => {
    writeLeaseLines("test-resumed", [
        serialLease("test-resumed", await deadPid(), "Sat Oct 17 09:00:00 2026"),
        {
            ...serialLease("test-resumed", process.pid, ownLstart()),
            serial: "emulator-5556",
        },
    ]);
    const { deps, runs } = testDeps({ env: {} });

    await sweepLeases({ stale: true }, deps);

    expect(runs).toEqual([
        ADB_KILL_5554,
    ]);
    expect(storedLeases("test-resumed").map((lease) => lease.serial)).toEqual([
        "emulator-5556",
    ]);
});

test("--stale leaves a dead owner's target that a live entry in the same file still leases", async () => {
    writeLeaseLines("test-resumed", [
        serialLease("test-resumed", await deadPid(), "Sat Oct 17 09:00:00 2026"),
        serialLease("test-resumed", process.pid, ownLstart()),
    ]);
    const { deps, runs } = testDeps({ env: {} });

    const report = await sweepLeases({ stale: true }, deps);

    expect(runs).toEqual([]);
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
        "skipped",
    ]);
    expect(storedLeases("test-resumed").map((lease) => lease.ownerPid)).toEqual([
        process.pid,
    ]);
});

test("release removes only the matching entry, and a later sweep stops nothing for it", async () => {
    const { deps, runs } = testDeps();
    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );
    addLease(
        {
            kind: "simctl",
            udid: "0A1B2C3D-4E5F-6789-ABCD-EF0123456789",
        },
        deps,
    );

    const released = releaseLeases(
        {
            kind: "simctl",
            udid: "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
        },
        deps,
    );

    expect(released.removed).toBe(1);
    expect(storedLeases().map((lease) => lease.kind)).toEqual([
        "adb-emu",
    ]);

    await sweepLeases({ session }, deps);

    expect(runs).toEqual([
        ADB_KILL_5554,
    ]);
});

test("release of a pid lease works after the process is gone and deletes the emptied file", async () => {
    const child = startSleep();
    const { deps } = testDeps();
    addLease(
        {
            kind: "pid",
            pid: String(child.pid),
            match: "sleep 300",
        },
        deps,
    );
    child.kill("SIGKILL");
    await child.exited;

    const released = releaseLeases(
        {
            kind: "pid",
            pid: String(child.pid),
            match: "sleep 300",
        },
        deps,
    );

    expect(released.removed).toBe(1);
    expect(existsSync(leaseFile())).toBe(false);
});

test("release without CLAUDE_CODE_SESSION_ID is rejected", () => {
    const { deps } = testDeps({ env: {} });

    expect(() => releaseLeases(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    )).toThrow(/CLAUDE_CODE_SESSION_ID/);
});

test("an adb-emu lease records the AVD name and is skipped when a different emulator holds the serial", async () => {
    let avd = "Pixel_A";
    const asked: string[][] = [];
    const { deps, runs } = testDeps({
        output: (file: string, args: string[]): string => {
            asked.push([
                file,
                ...args,
            ]);
            return `${avd}\r\nOK\r\n`;
        },
    });

    const lease = addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );
    avd = "Pixel_B";
    const report = await sweepLeases({ session }, deps);

    expect(lease.avd).toBe("Pixel_A");
    expect(asked[0]).toEqual([
        "adb",
        "-s",
        "emulator-5554",
        "emu",
        "avd",
        "name",
    ]);
    expect(runs).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({
        status: "skipped",
        detail: "a different emulator now holds emulator-5554",
    });
});

test("an adb-emu lease whose AVD name still matches is stopped, and one that cannot be read is skipped", async () => {
    let avd: string | undefined = "Pixel_A\nOK\n";
    const { deps, runs } = testDeps({ output: (): string | undefined => avd });
    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );

    await sweepLeases({ session }, deps);
    expect(runs).toEqual([
        ADB_KILL_5554,
    ]);

    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );
    avd = undefined;
    const report = await sweepLeases({ session }, deps);

    expect(runs).toHaveLength(1);
    expect(report.outcomes[0]?.status).toBe("skipped");
});

test("a pid lease on a process with a controlling terminal is refused, and one without is accepted", () => {
    const child = startSleep();
    const withTty = (tty: string): LeaseDeps => testDeps({
        probe: {
            ...defaultLeaseDeps().probe,
            tty: (): string => tty,
        },
    }).deps;
    const input = {
        kind: "pid",
        pid: String(child.pid),
        match: "sleep 300",
    };

    expect(() => addLease(input, withTty("ttys003"))).toThrow(/terminal ttys003/);
    expect(existsSync(leaseFile())).toBe(false);
    expect(addLease(input, withTty("??")).pid).toBe(child.pid);
});

test("add refuses pid 1", () => {
    const { deps } = testDeps();

    expect(() => addLease(
        {
            kind: "pid",
            pid: "1",
            match: "launchd",
        },
        deps,
    )).toThrow(/greater than 1/);
});

test("a stored pid lease for pid 1 is malformed and never signalled", async () => {
    const signals: number[] = [];
    const { deps } = testDeps({
        kill: (target: number): void => {
            signals.push(target);
        },
    });
    writeLeaseLines(session, [
        {
            session,
            kind: "pid",
            pid: 1,
            lstart: "Sat Oct 17 09:00:00 2026",
            command: "launchd",
            match: "launchd",
            ownerPid: process.pid,
            ownerLstart: ownLstart(),
            createdAt: new Date().toISOString(),
        },
    ]);

    const report = await sweepLeases({ session }, deps);

    expect(report.malformed).toBe(1);
    expect(signals).toEqual([]);
});

test("a kill refused with EPERM is a failed outcome kept in its file, and the sweep goes on", async () => {
    const live = "Sat Oct 17 12:00:00 2026";
    writeLeaseLines("test-first", [
        fakePidLease("test-first", 4242, "Sat Oct 17 08:00:00 2026"),
        fakePidLease("test-first", 4343, "Sat Oct 17 08:00:00 2026"),
    ]);
    writeLeaseLines("test-second", [
        fakePidLease("test-second", 4444, "Sat Oct 17 08:00:00 2026"),
    ]);
    const signalled: number[] = [];
    const { deps } = testDeps({
        env: {},
        probe: fakeProbe(live),
        kill: (target: number): void => {
            if (target === 4242) {
                throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
            }
            signalled.push(target);
        },
    });

    const report = await sweepLeases({ stale: true }, deps);

    expect(report.outcomes.map((outcome) => outcome.status).sort()).toEqual([
        "failed",
        "stopped",
        "stopped",
    ]);
    expect(signalled.sort()).toEqual([
        4343,
        4444,
    ]);
    expect(storedLeases("test-first").map((lease) => lease.pid)).toEqual([
        4242,
    ]);
    expect(existsSync(leaseFile("test-second"))).toBe(false);
});

test("a failed stop keeps its entry and the stopped one is dropped", async () => {
    const { deps } = testDeps({
        run: async (file: string): Promise<RunOutcome> => (
            file === "adb"
                ? {
                    status: "failed",
                    detail: "adb: device offline",
                }
                : { status: "ok" }
        ),
    });
    addLease(
        {
            kind: "adb-emu",
            serial: "emulator-5554",
        },
        deps,
    );
    addLease(
        {
            kind: "simctl",
            udid: "0A1B2C3D-4E5F-6789-ABCD-EF0123456789",
        },
        deps,
    );

    const report = await sweepLeases({ session }, deps);

    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
        "failed",
        "stopped",
    ]);
    expect(storedLeases().map((lease) => lease.kind)).toEqual([
        "adb-emu",
    ]);
});

test("a --session sweep finds the session's lease in the sandbox store", async () => {
    writeLeaseLines(
        session,
        [
            serialLease(session, process.pid, ownLstart()),
        ],
        sandboxDir(),
    );
    const { deps, runs } = testDeps();

    await sweepLeases({ session }, deps);

    expect(runs).toEqual([
        ADB_KILL_5554,
    ]);
    expect(existsSync(leaseFile(session, sandboxDir()))).toBe(false);
});

test("two store paths that resolve to one directory are swept once", async () => {
    writeLeaseLines(session, [
        serialLease(session, process.pid, ownLstart()),
    ]);
    symlinkSync(scratch, join(scratch, "alias"));
    const { deps, runs } = testDeps({ sandboxLeaseDir: join(scratch, "alias", "ac-leases") });

    await sweepLeases({ session }, deps);

    expect(runs).toEqual([
        ADB_KILL_5554,
    ]);
});

test("the sandbox store follows CLAUDE_CODE_TMPDIR and defaults to /tmp", () => {
    const original = process.env.CLAUDE_CODE_TMPDIR;
    const uid = process.getuid?.();
    try {
        process.env.CLAUDE_CODE_TMPDIR = join(scratch, "cct");
        expect(defaultLeaseDeps().sandboxLeaseDir).toBe(join(scratch, "cct", `claude-${uid}`, "ac-leases"));
        delete process.env.CLAUDE_CODE_TMPDIR;
        expect(defaultLeaseDeps().sandboxLeaseDir).toBe(`/tmp/claude-${uid}/ac-leases`);
    } finally {
        if (original === undefined) {
            delete process.env.CLAUDE_CODE_TMPDIR;
        } else {
            process.env.CLAUDE_CODE_TMPDIR = original;
        }
    }
});

test("the CLI registers lease release and removes the matching entry", () => {
    writeLeaseLines(session, [
        serialLease(session, process.pid, ownLstart()),
    ]);

    const result = Bun.spawnSync(
        [
            "bun",
            INDEX,
            "lease",
            "release",
            "--kind",
            "adb-emu",
            "--serial",
            "emulator-5554",
        ],
        {
            env: {
                ...process.env,
                TMPDIR: scratch,
                CLAUDE_CODE_TMPDIR: join(scratch, "sandbox"),
                CLAUDE_CODE_SESSION_ID: session,
            },
        },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("released 1");
    expect(existsSync(leaseFile())).toBe(false);
});
