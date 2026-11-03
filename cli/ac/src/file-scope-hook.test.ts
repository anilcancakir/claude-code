import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, but CI only runs `bun test` here, so this is where its
// contract is pinned: a subagent is denied outside the wave's files, except the lane orchestrator, which
// runs the execute phases itself and edits files its wave never declared.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "pretooluse-file-scope.sh",
);

const SESSION_ID = "session-under-test";

let root: string;
let projectDir: string;
let target: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-file-scope-"));
    projectDir = join(root, "project");
    target = join(projectDir, "src", "outside.ts");
    mkdirSync(join(projectDir, ".ac", "state", "execute"), { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeMarker("demo", [join(projectDir, "src", "declared.ts")]);
});

function writeMarker(slug: string, waveFiles: string[], session: string = SESSION_ID): void {
    writeFileSync(
        join(projectDir, ".ac", "state", "execute", `${slug}.json`),
        JSON.stringify({
            slug,
            session_id: session,
            started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            pid: process.pid,
            wave_files: waveFiles,
        }),
    );
}

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(stdin: string): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            TMPDIR: root,
            CLAUDE_PROJECT_DIR: "",
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: target },
        session_id: SESSION_ID,
        cwd: projectDir,
        ...overrides,
    });
}

function isDenied(result: HookResult): boolean {
    return result.stdout.includes('"permissionDecision":"deny"');
}

test("denies a plan-worker editing outside the wave files", () => {
    const result = runHook(payload({ agent_id: "agent1", agent_type: "ac:plan-worker-junior" }));

    expect(result.exitCode).toBe(0);
    expect(isDenied(result)).toBe(true);
});

test("allows the ac:lane orchestrator to edit outside the wave files", () => {
    const result = runHook(payload({ agent_id: "agent1", agent_type: "ac:lane" }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("allows the bare lane orchestrator to edit outside the wave files", () => {
    const result = runHook(payload({ agent_id: "agent1", agent_type: "lane" }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("allows the main thread, which carries no agent_id", () => {
    const result = runHook(payload());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("does not exempt a lane-prefixed agent that is not the lane orchestrator", () => {
    const result = runHook(payload({ agent_id: "agent1", agent_type: "ac:lane-helper" }));

    expect(result.exitCode).toBe(0);
    expect(isDenied(result)).toBe(true);
});

const WORKER = { agent_id: "agent1", agent_type: "ac:plan-worker-junior" };

function workerEditing(file: string, session: string = SESSION_ID): string {
    return payload({ ...WORKER, session_id: session, tool_input: { file_path: file } });
}

test("another session's marker in the same checkout neither scopes nor widens this session", () => {
    writeMarker("other-plan", [target], "sess-other");

    expect(isDenied(runHook(workerEditing(target)))).toBe(true);
    expect(runHook(workerEditing(target, "sess-other")).stdout).toBe("");
    expect(isDenied(runHook(workerEditing(join(projectDir, "src", "declared.ts"), "sess-other")))).toBe(true);
});

test("a session with no marker of its own is not scoped by another session's marker", () => {
    expect(runHook(workerEditing(target, "sess-third")).stdout).toBe("");
});

test("a session owning two markers may edit the union of their wave files", () => {
    writeMarker("second-plan", [target]);

    expect(runHook(workerEditing(target)).stdout).toBe("");
    expect(runHook(workerEditing(join(projectDir, "src", "declared.ts"))).stdout).toBe("");
    expect(isDenied(runHook(workerEditing(join(projectDir, "src", "third.ts"))))).toBe(true);
});

test("a marker file whose name is not a plain slug is ignored", () => {
    writeMarker("bad slug", [target]);

    expect(isDenied(runHook(payload(WORKER)))).toBe(true);
});

test("the per-slug stop-guard counter is not read as a marker", () => {
    rmSync(join(projectDir, ".ac", "state", "execute", "demo.json"));
    writeMarker("demo.stop-guard", [join(projectDir, "src", "declared.ts")]);

    expect(runHook(payload(WORKER)).stdout).toBe("");
});
