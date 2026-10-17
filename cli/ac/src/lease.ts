import { execFile, spawn, spawnSync } from "node:child_process";
import {
    closeSync,
    constants,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * The closed set of things a lease can stop. Each kind maps to exactly one argv in `stopCommand`;
 * there is no free-form stop string, so a lease file can never name a command to run.
 */
export const LEASE_KINDS = [
    "pid",
    "adb-emu",
    "simctl",
    "playwright",
] as const;

export type LeaseKind = (typeof LEASE_KINDS)[number];

/**
 * One line of `<tmpdir>/ac-leases/<session>.jsonl`. The field names are a contract: the session
 * hooks' tests write these lines directly. `ownerPid` plus `ownerLstart` identify the claude
 * process that took the lease, which is how `--stale` tells a dead session from a live one.
 */
export interface Lease {
    session: string;
    kind: LeaseKind;
    pid?: number;
    lstart?: string;
    command?: string;
    match?: string;
    serial?: string;
    udid?: string;
    pwSession?: string;
    label?: string;
    ownerPid: number;
    ownerLstart: string;
    createdAt: string;
}

/** Raw `lease add` options, unvalidated, as the CLI parser hands them over. */
export interface LeaseAddInput {
    kind: string;
    pid?: string;
    match?: string;
    serial?: string;
    udid?: string;
    pwSession?: string;
    label?: string;
}

export interface LeaseSweepInput {
    session?: string;
    reason?: string;
    stale?: boolean;
    detach?: boolean;
}

/** Each probe returns undefined when the pid is gone, which is how `ps` reports it (no output, exit 1). */
export interface ProcessProbe {
    lstart(pid: number): string | undefined;
    command(pid: number): string | undefined;
    comm(pid: number): string | undefined;
    ppid(pid: number): number | undefined;
    pgid(pid: number): number | undefined;
}

export type RunOutcome =
    | { status: "ok" }
    | { status: "missing" }
    | { status: "failed"; detail: string };

/** Everything that touches the host, injectable so tests need no claude ancestor, adb, xcrun or playwright-cli. */
export interface LeaseDeps {
    env: Record<string, string | undefined>;
    leaseDir: string;
    probe: ProcessProbe;
    /** Pid of the claude process that owns this session, or undefined when none is an ancestor. */
    findOwner: () => number | undefined;
    run: (file: string, args: string[]) => Promise<RunOutcome>;
    kill: (target: number, signal: NodeJS.Signals) => void;
    /** Starts `ac <argv>` in a new session with no stdio and returns without waiting for it. */
    spawnDetached: (argv: string[]) => void;
    now: () => Date;
}

export type SweepStatus = "stopped" | "skipped" | "failed";

export interface SweepOutcome {
    file: string;
    target: string;
    status: SweepStatus;
    detail: string;
}

export interface SweepReport {
    outcomes: SweepOutcome[];
    filesRemoved: string[];
    malformed: number;
    detached: boolean;
}

/** Invalid input or an unsafe lease store. The CLI prints the message as one stderr line and exits 1. */
export class LeaseError extends Error {
    override name = "LeaseError";
}

const SERIAL_PATTERN = /^emulator-[0-9]+$/;
const UDID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const PW_SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** A session id becomes a file name, so it may not start with a dot (no `..`, no hidden files). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PID_PATTERN = /^[1-9][0-9]*$/;
const STOP_TIMEOUT_MILLIS = 10_000;
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

export function defaultLeaseDeps(): LeaseDeps {
    const probe = psProbe();
    return {
        env: process.env,
        leaseDir: join(tmpdir(), "ac-leases"),
        probe,
        findOwner: () => findClaudeAncestor(probe),
        run: runArgv,
        kill: (target: number, signal: NodeJS.Signals): void => {
            process.kill(target, signal);
        },
        spawnDetached: relaunchDetached,
        now: () => new Date(),
    };
}

/**
 * Validates a lease, pins the owning claude process and, for a pid, the target's identity, then
 * appends one line to the session's lease file.
 *
 * @throws LeaseError on an invalid target, a missing session or owner, a pid that is dead, does not
 * match, or predates the owner, and on a lease store that is a symlink, foreign or writable by others.
 */
export function addLease(input: LeaseAddInput, deps: LeaseDeps): Lease {
    // 1. Reject a malformed target before touching the host, so a typo costs nothing.
    const target = parseTarget(input);

    // 2. The session id names the file; without one there is nothing to sweep at session end.
    const session = deps.env.CLAUDE_CODE_SESSION_ID;
    if (session === undefined || session === "") {
        throw new LeaseError("CLAUDE_CODE_SESSION_ID is not set; lease add must run inside a Claude Code session");
    }
    assertSessionId(session);

    // 3. The owner's pid plus start time is what `--stale` later checks for liveness.
    const ownerPid = deps.findOwner();
    if (ownerPid === undefined) {
        throw new LeaseError("no claude process found among this process's ancestors");
    }
    const ownerLstart = deps.probe.lstart(ownerPid);
    if (ownerLstart === undefined) {
        throw new LeaseError(`owning claude process ${ownerPid} is not running`);
    }

    // 4. A pid lease pins start time and command now, so a sweep never signals a reused pid.
    const identity = target.kind === "pid" ? pinProcess(target, ownerLstart, deps.probe) : {};

    const lease: Lease = {
        session,
        ...target,
        ...identity,
        ...(input.label === undefined ? {} : { label: input.label }),
        ownerPid,
        ownerLstart,
        createdAt: deps.now().toISOString(),
    };

    // 5. Append under the private store checks; a symlinked or shared store could redirect the write.
    ensureLeaseDir(deps.leaseDir);
    appendLine(join(deps.leaseDir, `${session}.jsonl`), JSON.stringify(lease) + "\n");

    return lease;
}

/**
 * Stops what a session leased, then deletes its file. With `stale`, does the same for every lease
 * file whose owning claude process is gone. A target that another live session's file also leases
 * is left running. `reason: "resume"` is a no-op, and `detach` relaunches the sweep in the
 * background and returns at once, because SessionEnd hooks share a 1.5 s budget.
 *
 * @throws LeaseError on an invalid session id or an unsafe lease store.
 */
export async function sweepLeases(input: LeaseSweepInput, deps: LeaseDeps): Promise<SweepReport> {
    const report: SweepReport = {
        outcomes: [],
        filesRemoved: [],
        malformed: 0,
        detached: false,
    };

    // 1. A resumed session is still the same session; its leases stay live.
    if (input.reason === "resume") {
        return report;
    }

    // 2. Resolve which session to sweep before detaching, so the child gets an explicit id.
    const session = input.session ?? (input.stale === true ? undefined : deps.env.CLAUDE_CODE_SESSION_ID);
    if (session === undefined && input.stale !== true) {
        throw new LeaseError("lease sweep needs --session, --stale or CLAUDE_CODE_SESSION_ID");
    }
    if (session !== undefined) {
        assertSessionId(session);
    }

    // 3. Hand the real work to a detached child and return inside the hook budget.
    if (input.detach === true) {
        deps.spawnDetached(relaunchArgv(session, input));
        report.detached = true;
        return report;
    }

    // 4. A store that does not exist has nothing to sweep; one that exists must be private.
    if (lstatOrUndefined(deps.leaseDir) === undefined) {
        return report;
    }
    assertPrivate(deps.leaseDir, "directory");

    const files = new Set<string>();
    if (session !== undefined) {
        files.add(`${session}.jsonl`);
    }
    if (input.stale === true) {
        for (const name of staleFiles(deps, report)) {
            files.add(name);
        }
    }

    // 5. Sweep each file, then delete it; entries another live session holds stay running.
    for (const name of files) {
        await sweepFile(name, deps, report);
    }

    return report;
}

type Target =
    | { kind: "pid"; pid: number; match: string }
    | { kind: "adb-emu"; serial: string }
    | { kind: "simctl"; udid: string }
    | { kind: "playwright"; pwSession: string };

function parseTarget(input: LeaseAddInput): Target {
    switch (input.kind) {
        case "pid": {
            if (input.pid === undefined || !PID_PATTERN.test(input.pid)) {
                throw new LeaseError(`--pid must be a positive integer, got "${input.pid ?? ""}"`);
            }
            if (input.match === undefined || input.match === "") {
                throw new LeaseError("--match is required for a pid lease");
            }
            return {
                kind: "pid",
                pid: Number(input.pid),
                match: input.match,
            };
        }
        case "adb-emu":
            return {
                kind: "adb-emu",
                serial: requirePattern("--serial", input.serial, SERIAL_PATTERN),
            };
        case "simctl":
            return {
                kind: "simctl",
                udid: requirePattern("--udid", input.udid, UDID_PATTERN),
            };
        case "playwright":
            return {
                kind: "playwright",
                pwSession: requirePattern("--session", input.pwSession, PW_SESSION_PATTERN),
            };
        default:
            throw new LeaseError(`--kind must be one of ${LEASE_KINDS.join(", ")}, got "${input.kind}"`);
    }
}

function requirePattern(flag: string, value: string | undefined, pattern: RegExp): string {
    if (value === undefined || !pattern.test(value)) {
        throw new LeaseError(`${flag} must match ${pattern.source}, got "${value ?? ""}"`);
    }
    return value;
}

function assertSessionId(session: string): void {
    if (!SESSION_ID_PATTERN.test(session)) {
        throw new LeaseError(`session id must match ${SESSION_ID_PATTERN.source}, got "${session}"`);
    }
}

function pinProcess(
    target: { pid: number; match: string },
    ownerLstart: string,
    probe: ProcessProbe,
): { lstart: string; command: string } {
    const lstart = probe.lstart(target.pid);
    const command = probe.command(target.pid);
    if (lstart === undefined || command === undefined) {
        throw new LeaseError(`pid ${target.pid} is not running`);
    }
    if (!command.includes(target.match)) {
        throw new LeaseError(`pid ${target.pid} command does not contain --match "${target.match}"`);
    }
    const started = parseLstart(lstart);
    const ownerStarted = parseLstart(ownerLstart);
    if (started === undefined || ownerStarted === undefined) {
        throw new LeaseError(`cannot read start times for pid ${target.pid} ("${lstart}", owner "${ownerLstart}")`);
    }
    if (started < ownerStarted) {
        throw new LeaseError(`pid ${target.pid} started before the owning claude process; it is not this session's`);
    }
    return {
        lstart,
        command,
    };
}

/** Parses `ps -o lstart=` under LC_ALL=C (`Sat Oct 17 21:54:05 2026`) to epoch millis, local time. */
function parseLstart(lstart: string): number | undefined {
    const parts = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart);
    if (parts === null) {
        return undefined;
    }
    const month = MONTHS.indexOf(parts[1] ?? "");
    if (month < 0) {
        return undefined;
    }
    return new Date(
        Number(parts[6]),
        month,
        Number(parts[2]),
        Number(parts[3]),
        Number(parts[4]),
        Number(parts[5]),
    ).getTime();
}

function ensureLeaseDir(dir: string): void {
    try {
        mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
        if (!isErrno(error, "EEXIST")) {
            throw error;
        }
    }
    assertPrivate(dir, "directory");
}

function appendLine(path: string, line: string): void {
    if (lstatOrUndefined(path) !== undefined) {
        assertPrivate(path, "file");
    }
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    const fd = openSync(path, flags, 0o600);
    try {
        writeSync(fd, line);
    } finally {
        closeSync(fd);
    }
}

/** Refuses a symlink, the wrong file type, another user's entry, or group/other write bits. */
function assertPrivate(path: string, type: "directory" | "file"): void {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
        throw new LeaseError(`${path} is a symlink; refusing to use it as a lease ${type}`);
    }
    if (type === "directory" ? !stats.isDirectory() : !stats.isFile()) {
        throw new LeaseError(`${path} is not a ${type}`);
    }
    if (stats.uid !== currentUid()) {
        throw new LeaseError(`${path} is owned by uid ${stats.uid}, not by this user`);
    }
    if ((stats.mode & 0o022) !== 0) {
        throw new LeaseError(`${path} is group or other writable (mode ${(stats.mode & 0o777).toString(8)})`);
    }
}

function currentUid(): number {
    if (process.getuid === undefined) {
        throw new LeaseError("leases need a POSIX host with process.getuid");
    }
    return process.getuid();
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
    try {
        return lstatSync(path);
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return undefined;
        }
        throw error;
    }
}

function isErrno(error: unknown, code: string): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

type LeaseFile = {
    name: string;
    leases: Lease[];
};

/**
 * Reads every other private lease file. A file that fails the store checks is left out: it cannot
 * be trusted to name a target, and leaving it out only ever means stopping more of our own leases.
 */
function readOtherFiles(exclude: string, deps: LeaseDeps, report: SweepReport): LeaseFile[] {
    const files: LeaseFile[] = [];
    for (const name of readdirSync(deps.leaseDir)) {
        if (name === exclude || !name.endsWith(".jsonl")) {
            continue;
        }
        const leases = readLeaseFile(join(deps.leaseDir, name), report, false);
        if (leases !== undefined) {
            files.push({
                name,
                leases,
            });
        }
    }
    return files;
}

/** Returns undefined for a missing file, and for an unsafe one unless `strict`, which throws instead. */
function readLeaseFile(path: string, report: SweepReport, strict: boolean): Lease[] | undefined {
    if (lstatOrUndefined(path) === undefined) {
        return undefined;
    }
    try {
        assertPrivate(path, "file");
    } catch (error) {
        if (strict || !(error instanceof LeaseError)) {
            throw error;
        }
        return undefined;
    }
    const leases: Lease[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        const lease = parseLeaseLine(line);
        if (lease === undefined) {
            report.malformed += 1;
            continue;
        }
        leases.push(lease);
    }
    return leases;
}

/**
 * Re-validates a stored line with the same patterns `add` applies, since a line is only as safe
 * as the argv it turns into and other code writes these files too.
 */
function parseLeaseLine(line: string): Lease | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.ownerPid !== "number" || typeof entry.ownerLstart !== "string") {
        return undefined;
    }
    const valid = (() => {
        switch (entry.kind) {
            case "pid":
                return Number.isInteger(entry.pid)
                    && (entry.pid as number) > 0
                    && typeof entry.lstart === "string"
                    && typeof entry.match === "string"
                    && entry.match !== "";
            case "adb-emu":
                return typeof entry.serial === "string" && SERIAL_PATTERN.test(entry.serial);
            case "simctl":
                return typeof entry.udid === "string" && UDID_PATTERN.test(entry.udid);
            case "playwright":
                return typeof entry.pwSession === "string" && PW_SESSION_PATTERN.test(entry.pwSession);
            default:
                return false;
        }
    })();
    return valid ? (entry as unknown as Lease) : undefined;
}

function ownerAlive(lease: Lease, probe: ProcessProbe): boolean {
    return probe.lstart(lease.ownerPid) === lease.ownerLstart;
}

function staleFiles(deps: LeaseDeps, report: SweepReport): string[] {
    return readOtherFiles("", deps, report)
        .filter((file) => {
            const owner = file.leases[0];
            return owner !== undefined && !ownerAlive(owner, deps.probe);
        })
        .map((file) => file.name);
}

/** A pid target includes its start time, so a reused pid is a different target. */
function targetKey(lease: Lease): string {
    switch (lease.kind) {
        case "pid":
            return `pid:${lease.pid}:${lease.lstart}`;
        case "adb-emu":
            return `adb-emu:${lease.serial}`;
        case "simctl":
            return `simctl:${(lease.udid ?? "").toUpperCase()}`;
        case "playwright":
            return `playwright:${lease.pwSession}`;
    }
}

async function sweepFile(name: string, deps: LeaseDeps, report: SweepReport): Promise<void> {
    const path = join(deps.leaseDir, name);
    const leases = readLeaseFile(path, report, true);
    if (leases === undefined) {
        return;
    }

    const heldElsewhere = new Set<string>();
    for (const other of readOtherFiles(name, deps, report)) {
        for (const lease of other.leases) {
            if (ownerAlive(lease, deps.probe)) {
                heldElsewhere.add(targetKey(lease));
            }
        }
    }

    for (const lease of leases) {
        const target = targetKey(lease);
        if (heldElsewhere.has(target)) {
            report.outcomes.push({
                file: name,
                target,
                status: "skipped",
                detail: "another live session still leases it",
            });
            continue;
        }
        const [status, detail] = lease.kind === "pid" ? stopProcess(lease, deps) : await stopResource(lease, deps);
        report.outcomes.push({
            file: name,
            target,
            status,
            detail,
        });
    }

    unlinkSync(path);
    report.filesRemoved.push(name);
}

/**
 * SIGTERM only when the live process is still the one leased: same start time, command still
 * carrying `match`. A group leader outside our own group gets the signal to its whole group, so a
 * dev server's workers go with it; anything else gets it alone, so a sweep never signals itself.
 */
function stopProcess(lease: Lease, deps: LeaseDeps): [SweepStatus, string] {
    const pid = lease.pid as number;
    const lstart = deps.probe.lstart(pid);
    if (lstart === undefined) {
        return ["skipped", "already gone"];
    }
    if (lstart !== lease.lstart) {
        return ["skipped", `pid reused (started ${lstart}, leased ${lease.lstart})`];
    }
    const command = deps.probe.command(pid);
    if (command === undefined || !command.includes(lease.match as string)) {
        return ["skipped", "command no longer matches"];
    }
    const pgid = deps.probe.pgid(pid);
    const ownPgid = deps.probe.pgid(process.pid);
    const target = pgid === pid && pgid !== ownPgid ? -pid : pid;
    try {
        deps.kill(target, "SIGTERM");
    } catch (error) {
        if (isErrno(error, "ESRCH")) {
            return ["skipped", "exited before the signal"];
        }
        throw error;
    }
    return ["stopped", target < 0 ? `SIGTERM to process group ${pid}` : `SIGTERM to pid ${pid}`];
}

async function stopResource(lease: Lease, deps: LeaseDeps): Promise<[SweepStatus, string]> {
    const [file, args] = stopCommand(lease);
    const outcome = await deps.run(file, args);
    switch (outcome.status) {
        case "ok":
            return ["stopped", `${file} ${args.join(" ")}`];
        case "missing":
            return ["skipped", `${file} is not installed`];
        case "failed":
            return ["failed", outcome.detail];
    }
}

function stopCommand(lease: Lease): [string, string[]] {
    switch (lease.kind) {
        case "adb-emu":
            return [
                "adb",
                [
                    "-s",
                    lease.serial as string,
                    "emu",
                    "kill",
                ],
            ];
        case "simctl":
            return [
                "xcrun",
                [
                    "simctl",
                    "shutdown",
                    lease.udid as string,
                ],
            ];
        case "playwright":
            return [
                "playwright-cli",
                [
                    `-s=${lease.pwSession as string}`,
                    "close",
                ],
            ];
        case "pid":
            throw new LeaseError("a pid lease is stopped by signal, not by command");
    }
}

function relaunchArgv(session: string | undefined, input: LeaseSweepInput): string[] {
    return [
        "lease",
        "sweep",
        ...(session === undefined ? [] : ["--session", session]),
        ...(input.reason === undefined ? [] : ["--reason", input.reason]),
        ...(input.stale === true ? ["--stale"] : []),
    ];
}

/** setsid via `detached`, so the sweep outlives the claude process that ran the SessionEnd hook. */
function relaunchDetached(argv: string[]): void {
    const script = process.argv[1];
    if (script === undefined) {
        throw new LeaseError("cannot relaunch: the ac entry script path is unknown");
    }
    const child = spawn(
        process.execPath,
        [
            ...process.execArgv,
            script,
            ...argv,
        ],
        {
            detached: true,
            stdio: "ignore",
        },
    );
    child.unref();
}

function runArgv(file: string, args: string[]): Promise<RunOutcome> {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: STOP_TIMEOUT_MILLIS }, (error) => {
            if (error === null) {
                resolve({ status: "ok" });
            } else if (error.code === "ENOENT") {
                resolve({ status: "missing" });
            } else {
                resolve({
                    status: "failed",
                    detail: error.message.trim(),
                });
            }
        });
    });
}

function psProbe(): ProcessProbe {
    const field = (pid: number, name: string, wide: boolean = false): string | undefined => {
        const result = spawnSync(
            "ps",
            [
                ...(wide ? ["-ww"] : []),
                "-o",
                `${name}=`,
                "-p",
                String(pid),
            ],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    LC_ALL: "C",
                },
            },
        );
        const value = result.status === 0 ? result.stdout.trim() : "";
        return value === "" ? undefined : value;
    };
    const integer = (value: string | undefined): number | undefined => (
        value === undefined ? undefined : Number.parseInt(value, 10)
    );
    return {
        lstart: (pid: number) => field(pid, "lstart"),
        command: (pid: number) => field(pid, "command", true),
        comm: (pid: number) => field(pid, "comm", true),
        ppid: (pid: number) => integer(field(pid, "ppid")),
        pgid: (pid: number) => integer(field(pid, "pgid")),
    };
}

/** Walks up from the parent; the nearest ancestor whose executable basename is `claude` owns the session. */
function findClaudeAncestor(probe: ProcessProbe): number | undefined {
    let pid = process.ppid;
    while (pid > 1) {
        const comm = probe.comm(pid);
        if (comm === undefined) {
            return undefined;
        }
        if (basename(comm) === "claude") {
            return pid;
        }
        const parent = probe.ppid(pid);
        if (parent === undefined) {
            return undefined;
        }
        pid = parent;
    }
    return undefined;
}
