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
    mkdirSync(join(projectDir, ".ac", "state"), { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
        join(projectDir, ".ac", "state", "active-execution.json"),
        JSON.stringify({
            session_id: SESSION_ID,
            started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            pid: process.pid,
            wave_files: [join(projectDir, "src", "declared.ts")],
        }),
    );
});

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
