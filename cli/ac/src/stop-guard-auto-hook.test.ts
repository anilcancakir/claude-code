import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The auto Stop guard over each away source: one owner per phase. Over a coordinator run the
// coordinator's own guard owns every stop while its marker lives, and the coordinator's verdict is
// the away run's verdict; over any other source the verdict lives in .ac/auto/<slug>/.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "stop-guard-auto.sh",
);

const SESSION = "sess-sga-1";
const SLUG = "demo";

let root: string;
let project: string;
let scratch: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-stop-guard-auto-"));
    project = join(root, "project");
    scratch = join(root, "tmp");
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runGuard(session: string = SESSION): HookResult {
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
            AC_AUTO_MAX_BLOCKS: "",
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function isoAgo(hours: number): string {
    return new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function writeAutoMarker(fields: Record<string, unknown>): void {
    writeFileSync(
        join(project, ".ac", "state", "active-auto.json"),
        JSON.stringify({
            session_id: SESSION,
            slug: SLUG,
            started_at: isoAgo(0),
            phase: "gating",
            ...fields,
        }),
    );
}

function seedAwayOverCoordinator(startedAt: string = isoAgo(0)): void {
    mkdirSync(join(project, ".ac", "coord", SLUG), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-coordinate.json"),
        JSON.stringify({ session_id: SESSION, slug: SLUG, started_at: startedAt, phase: "dispatch" }),
    );
    writeAutoMarker({
        started_at: startedAt,
        phase: "executing",
        source: "coordinate",
        source_ref: SLUG,
        allowed_outward: [],
        decisions: `.ac/away/${SLUG}/decisions.md`,
    });
}

function blockReason(result: HookResult): string {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

function expectAllow(result: HookResult): void {
    expect(result).toEqual({
        exitCode: 0,
        stdout: "",
    });
}

test("without a marker the guard is silent", () => {
    expectAllow(runGuard());
});

test("a run of another source blocks until .ac/auto/<slug>/verdict.md exists, then once for the close", () => {
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeAutoMarker({ source: "new" });

    expect(blockReason(runGuard())).toContain(`.ac/auto/${SLUG}/verdict.md`);

    writeFileSync(join(project, ".ac", "auto", SLUG, "verdict.md"), "# Verdict\n");
    const closing = blockReason(runGuard());
    expect(closing).toContain("judged but not closed");
    expect(closing).toContain("Phase 4");

    expectAllow(runGuard());
});

test("an execute source whose execute marker is gone is told to gate", () => {
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeAutoMarker({ phase: "executing", source: "execute", source_ref: SLUG });

    expect(blockReason(runGuard())).toContain("has ended (its marker is gone)");
});

test("an execute source still running gets the note, not the gate", () => {
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-execution.json"),
        JSON.stringify({ session_id: SESSION, slug: SLUG, started_at: isoAgo(0) }),
    );
    writeAutoMarker({ phase: "executing", source: "execute", source_ref: SLUG });

    expect(blockReason(runGuard())).toContain("this is a note rather than an instruction");
});

test("over a live coordinator run this session owns, the coordinator guard owns the stop", () => {
    seedAwayOverCoordinator();

    expectAllow(runGuard());
    expect(existsSync(join(project, ".ac", "coord", SLUG, "stop-guard-auto.json"))).toBe(false);
});

test("a coordinator marker owned by another session does not take the stop away from this guard", () => {
    seedAwayOverCoordinator();
    writeFileSync(
        join(project, ".ac", "state", "active-coordinate.json"),
        JSON.stringify({ session_id: "sess-other", slug: SLUG, started_at: isoAgo(0), phase: "dispatch" }),
    );

    expect(blockReason(runGuard())).toContain(`.ac/coord/${SLUG}/verdict.md`);
});

test("once the coordinator run closed without a verdict, the guard asks for the gate on its criteria", () => {
    seedAwayOverCoordinator();
    writeFileSync(join(project, ".ac", "coord", SLUG, "criteria.md"), "---\n---\n");
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));

    const reason = blockReason(runGuard());

    expect(reason).toContain(`.ac/coord/${SLUG}/criteria.md`);
    expect(reason).toContain(`.ac/coord/${SLUG}/verdict.md`);
});

test("a coordinator run that ended before its lock asks for the marker to go, not for a gate", () => {
    seedAwayOverCoordinator();
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));

    const reason = blockReason(runGuard());

    expect(reason).toContain("before its roadmap lock");
    expect(reason).toContain("Delete .ac/state/active-auto.json");
});

test("the coordinator verdict leaves one closing block for an away run over it", () => {
    seedAwayOverCoordinator();
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));
    writeFileSync(join(project, ".ac", "coord", SLUG, "verdict.md"), "# Verdict\n");

    expect(blockReason(runGuard())).toContain(`.ac/coord/${SLUG}/stop-guard-auto.json`);
    expectAllow(runGuard());
});

test("an away run over a coordinator run keeps guarding for 72 hours and no longer", () => {
    seedAwayOverCoordinator(isoAgo(48));
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));
    blockReason(runGuard());

    seedAwayOverCoordinator(isoAgo(73));
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));
    expectAllow(runGuard());
});

test("a source_ref that is not a plain name leaves the guard silent", () => {
    seedAwayOverCoordinator();
    rmSync(join(project, ".ac", "state", "active-coordinate.json"));
    writeAutoMarker({ phase: "executing", source: "coordinate", source_ref: "../demo" });

    expectAllow(runGuard());
});

test("a marker owned by another session is never blocked on", () => {
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeAutoMarker({ session_id: "sess-other" });

    expectAllow(runGuard());
});
