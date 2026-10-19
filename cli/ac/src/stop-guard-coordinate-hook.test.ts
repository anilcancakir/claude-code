import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// stop-guard-coordinate.sh blocks a coordinator run that tries to end its turn with no verdict, and
// allows on every condition where ending the turn is correct or the run is not this session's.
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac", "hooks");
const GUARD = join(HOOKS, "stop-guard-coordinate.sh");

const SESSION = "sess-coord-1";
const SLUG = "ship-auth";
const HOUR_MS = 3_600_000;

let root: string;
let project: string;
let scratch: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-stop-guard-coordinate-"));
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
    stderr: string;
}

interface Marker {
    slug: string;
    session_id: string;
    started_at: string;
    phase: string;
    note: string;
}

interface Bundle {
    id: string;
    title: string;
    status: string;
}

const BUNDLES: Bundle[] = [
    { id: "b1", title: "Token storage", status: "pending" },
    { id: "b2", title: "Session refresh", status: "executing" },
    { id: "b3", title: "Login form", status: "merged" },
    { id: "b4", title: "Legacy cookie", status: "dropped" },
];

function runGuard(
    session: string = SESSION,
    extra: Record<string, unknown> = {},
    env: Record<string, string> = {},
): HookResult {
    const result = Bun.spawnSync(["sh", GUARD], {
        stdin: Buffer.from(payload(session, extra)),
        env: {
            ...process.env,
            TMPDIR: scratch,
            CLAUDE_PROJECT_DIR: "",
            AC_COORDINATE_MAX_BLOCKS: "",
            ...env,
        },
    });

    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function payload(session: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        cwd: project,
        transcript_path: "",
        stop_hook_active: false,
        background_tasks: [],
        ...extra,
    });
}

function isoAgo(hours: number): string {
    return new Date(Date.now() - hours * HOUR_MS).toISOString().replace(/\.\d+Z$/, "Z");
}

function runDir(slug: string = SLUG): string {
    return join(project, ".ac", "coord", slug);
}

function counterPath(slug: string = SLUG): string {
    return join(runDir(slug), "stop-guard-coordinate.json");
}

function writeMarker(overrides: Partial<Marker> = {}): void {
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    const marker: Marker = {
        slug: SLUG,
        session_id: SESSION,
        started_at: isoAgo(1),
        phase: "dispatch",
        note: "lanes running",
        ...overrides,
    };
    writeFileSync(join(project, ".ac", "state", "active-coordinate.json"), JSON.stringify(marker));
}

function seedRun(marker: Partial<Marker> = {}, bundles: Bundle[] = BUNDLES): void {
    writeMarker(marker);
    mkdirSync(runDir(marker.slug ?? SLUG), { recursive: true });
    writeFileSync(join(runDir(marker.slug ?? SLUG), "state.json"), JSON.stringify({ slug: SLUG, bundles }));
}

function writeLatch(): void {
    writeFileSync(join(scratch, `ac-question-wait-${SESSION}`), `${Math.floor(Date.now() / 1000)}\n`);
}

function expectAllow(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
}

function expectBlock(result: HookResult): { decision: string; reason: string; systemMessage: string } {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { decision: string; reason: string; systemMessage: string };
    expect(output.decision).toBe("block");

    return output;
}

test("blocks while bundles are open and the reason names them, never the closed ones", () => {
    seedRun();

    const output = expectBlock(runGuard());

    expect(output.reason).toContain(SLUG);
    expect(output.reason).toMatch(/\bb1\b/);
    expect(output.reason).toMatch(/\bb2\b/);
    expect(output.reason).not.toMatch(/\bb3\b/);
    expect(output.reason).not.toMatch(/\bb4\b/);
    expect(output.systemMessage).toContain("1/3");
});

test("allows when there is no marker", () => {
    expectAllow(runGuard());
});

test("allows when another session owns the marker", () => {
    seedRun({ session_id: "sess-other" });

    expectAllow(runGuard());
});

test("allows when started_at is older than 72 hours and blocks just inside it", () => {
    seedRun({ started_at: isoAgo(73) });
    expectAllow(runGuard());

    seedRun({ started_at: isoAgo(71) });
    expectBlock(runGuard());
});

test("allows when the run directory is missing", () => {
    writeMarker();

    expectAllow(runGuard());
});

test("allows once verdict.md exists", () => {
    seedRun();
    writeFileSync(join(runDir(), "verdict.md"), "# Verdict\n");

    expectAllow(runGuard());
});

test("allows while a subagent background task runs, which is how a parked lane counts", () => {
    seedRun();

    expectAllow(runGuard(SESSION, { background_tasks: [{ type: "subagent" }] }));
    expect(existsSync(counterPath())).toBe(false);
});

test("a task that wakes nothing does not allow the stop", () => {
    seedRun();

    expectBlock(runGuard(SESSION, { background_tasks: [{ type: "teammate" }] }));
});

test("allows while the question-wait latch is armed and does not consume it", () => {
    seedRun();
    writeLatch();

    expectAllow(runGuard());
    expect(existsSync(join(scratch, `ac-question-wait-${SESSION}`))).toBe(true);
});

test("a slug containing a slash is rejected before any path is built from it", () => {
    seedRun({ slug: "a/b" });

    expectAllow(runGuard());
    expect(readdirSync(runDir("a/b")).sort()).toEqual(["state.json"]);
});

test("a slug containing dot-dot segments never reaches the filesystem", () => {
    seedRun({ slug: "../escape" });

    expectAllow(runGuard());
    expect(readdirSync(join(project, ".ac", "escape"))).toEqual(["state.json"]);
});

test("the block budget is three per phase, then the guard latches open", () => {
    seedRun();

    for (const n of [1, 2, 3]) {
        expect(expectBlock(runGuard()).systemMessage).toContain(`${n}/3`);
    }

    const spent = runGuard();
    expectAllow(spent);
    expect(spent.stderr).toContain("budget");
    expect((JSON.parse(readFileSync(counterPath(), "utf8")) as { spent: boolean }).spent).toBe(true);

    expectAllow(runGuard());
});

test("a phase change resets the count and clears a spent latch", () => {
    seedRun();
    for (let i = 0; i < 4; i++) {
        runGuard();
    }
    expectAllow(runGuard());

    const marker = JSON.parse(readFileSync(join(project, ".ac", "state", "active-coordinate.json"), "utf8")) as Marker;
    writeMarker({ ...marker, phase: "integrate" });

    expect(expectBlock(runGuard()).systemMessage).toContain("1/3");
});

test("AC_COORDINATE_MAX_BLOCKS overrides the budget", () => {
    seedRun();

    expectBlock(runGuard(SESSION, {}, { AC_COORDINATE_MAX_BLOCKS: "1" }));
    expectAllow(runGuard(SESSION, {}, { AC_COORDINATE_MAX_BLOCKS: "1" }));
});

test("blocks in the roadmap phase before state.json exists", () => {
    writeMarker({ phase: "roadmap" });
    mkdirSync(runDir(), { recursive: true });

    const output = expectBlock(runGuard());

    expect(output.reason).toContain("roadmap");
});

test("the gating phase names the verdict as the next action", () => {
    seedRun({ phase: "gating" }, BUNDLES.slice(2));

    const output = expectBlock(runGuard());

    expect(output.reason).toContain(`.ac/coord/${SLUG}/verdict.md`);
});
