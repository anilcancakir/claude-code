import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: one `decision: block` per agent while a background task
// that agent started is still running, and silence on everything else.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "subagentstop-background-guard.sh",
);

// A real subagent transcript (a Bash that outgrew its timeout and was moved to the background,
// plus one string-valued toolUseResult). It lives under ~/.claude, so CI does not have it.
const REAL_TRANSCRIPT = join(
    process.env.HOME ?? "",
    ".claude",
    "projects",
    "-Users-anilcan-Code-fluttersdk-uptizm--claude-worktrees-lane-incidents",
    "4aa48001-3d6d-458a-a0bd-e8ccb70ccbc9",
    "subagents",
    "agent-a0695b32819c524d1.jsonl",
);
const REAL_TRANSCRIPT_TASK_ID = "b6mf8dpjh";

let root: string;
let scratchTmp: string;
let transcript: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-subagentstop-guard-"));
    scratchTmp = join(root, "tmp");
    mkdirSync(scratchTmp);
    transcript = join(root, "agent.jsonl");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

interface BackgroundTask {
    id: string;
    type?: string;
    status: string;
    description?: string;
    command?: string;
}

function runHook(stdin: string): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            TMPDIR: scratchTmp,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "ac:plan-worker-junior",
        agent_id: "agent1",
        stop_hook_active: false,
        agent_transcript_path: transcript,
        background_tasks: [],
        session_crons: [],
        ...overrides,
    });
}

function shellTask(id: string, command: string, status = "running"): BackgroundTask {
    return { id, type: "shell", status, description: command, command };
}

function shellStarted(id: string): string {
    return JSON.stringify({
        type: "user",
        message: {
            content: [
                {
                    type: "tool_result",
                    content: `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output`,
                },
            ],
        },
        toolUseResult: { backgroundTaskId: id, stdout: "", stderr: "", interrupted: false },
    });
}

function monitorStarted(id: string): string {
    return JSON.stringify({
        type: "user",
        message: {
            content: [{ type: "tool_result", content: `Monitor started (task ${id}, expires in 30m).` }],
        },
        toolUseResult: { taskId: id, timeoutMs: 1800000, persistent: false },
    });
}

function stringResult(): string {
    return JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "Error: Exit code 2" }] },
        toolUseResult: "Error: Exit code 2\nsome output",
    });
}

function writeTranscript(...records: string[]): void {
    writeFileSync(transcript, `${records.join("\n")}\n`);
}

function blockReason(stdout: string): string {
    const output = JSON.parse(stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

const SILENT: HookResult = { exitCode: 0, stdout: "" };

test("an own running shell blocks, naming the id, its command and the report instruction", () => {
    writeTranscript(stringResult(), shellStarted("bg1"));

    const result = runHook(payload({ background_tasks: [shellTask("bg1", "npm run dev -- --port 4000")] }));
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("bg1");
    expect(reason).toContain("npm run dev -- --port 4000");
    expect(reason).toContain("TaskStop");
    expect(reason).toContain("repeat your complete final report");
});

test("a second stop for the same agent id is silent", () => {
    writeTranscript(shellStarted("bg1"));
    const stdin = payload({ background_tasks: [shellTask("bg1", "sleep 600")] });

    blockReason(runHook(stdin).stdout);

    expect(runHook(stdin)).toEqual(SILENT);
});

test("a distinct agent id is blocked independently", () => {
    writeTranscript(shellStarted("bg1"));
    const tasks = [shellTask("bg1", "sleep 600")];

    blockReason(runHook(payload({ background_tasks: tasks })).stdout);

    blockReason(runHook(payload({ agent_id: "agent2", background_tasks: tasks })).stdout);
});

test("a running id this agent did not start is silent", () => {
    writeTranscript(shellStarted("bg1"));

    expect(runHook(payload({ background_tasks: [shellTask("other9", "sleep 600")] }))).toEqual(SILENT);
});

test("an own id that is no longer running is silent", () => {
    writeTranscript(shellStarted("bg1"));

    expect(runHook(payload({ background_tasks: [shellTask("bg1", "sleep 1", "completed")] }))).toEqual(SILENT);
});

test("a Monitor taskId that is still running blocks", () => {
    writeTranscript(monitorStarted("mon1"));

    const result = runHook(payload({ background_tasks: [shellTask("mon1", "tail -f /var/log/app.log")] }));

    expect(blockReason(result.stdout)).toContain("mon1");
});

test("a task type the guard has not seen before still blocks", () => {
    writeTranscript(monitorStarted("mon1"));

    const task: BackgroundTask = { id: "mon1", type: "monitor", status: "running", description: "watch the log" };

    expect(blockReason(runHook(payload({ background_tasks: [task] })).stdout)).toContain("mon1");
});

test("an id found only in the tool result text blocks", () => {
    writeTranscript(
        JSON.stringify({
            type: "user",
            message: {
                content: [
                    {
                        type: "tool_result",
                        content: [{ type: "text", text: "Command did not complete and was moved to the background (ID: txt1)." }],
                    },
                ],
            },
            toolUseResult: "plain string result",
        }),
    );

    expect(blockReason(runHook(payload({ background_tasks: [shellTask("txt1", "make")] })).stdout)).toContain("txt1");
});

test("an id mentioned only in assistant text is not owned", () => {
    writeTranscript(
        JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "It was moved to the background (ID: bg1)." }] },
        }),
    );

    expect(runHook(payload({ background_tasks: [shellTask("bg1", "make")] }))).toEqual(SILENT);
});

test("a malformed transcript line does not hide a later own id", () => {
    writeFileSync(transcript, `not json\n${shellStarted("bg1")}\n`);

    expect(blockReason(runHook(payload({ background_tasks: [shellTask("bg1", "make")] })).stdout)).toContain("bg1");
});

test("stop_hook_active true is silent", () => {
    writeTranscript(shellStarted("bg1"));

    expect(
        runHook(payload({ stop_hook_active: true, background_tasks: [shellTask("bg1", "sleep 600")] })),
    ).toEqual(SILENT);
});

test("a main-thread payload without agent_type is silent", () => {
    writeTranscript(shellStarted("bg1"));
    const main = JSON.parse(payload({ background_tasks: [shellTask("bg1", "sleep 600")] })) as Record<string, unknown>;
    delete main.agent_type;
    delete main.agent_id;

    expect(runHook(JSON.stringify(main))).toEqual(SILENT);
});

test("a non-ac agent type is silent", () => {
    writeTranscript(shellStarted("bg1"));

    expect(
        runHook(payload({ agent_type: "general-purpose", background_tasks: [shellTask("bg1", "sleep 600")] })),
    ).toEqual(SILENT);
});

test("a bare ac agent name blocks like the namespaced one", () => {
    writeTranscript(shellStarted("bg1"));

    const result = runHook(payload({ agent_type: "plan-worker-junior-high", background_tasks: [shellTask("bg1", "x")] }));

    expect(blockReason(result.stdout)).toContain("bg1");
});

test("an unsafe agent id is silent", () => {
    writeTranscript(shellStarted("bg1"));

    expect(runHook(payload({ agent_id: "../escape", background_tasks: [shellTask("bg1", "x")] }))).toEqual(SILENT);
});

test("a missing transcript fails open", () => {
    expect(runHook(payload({ background_tasks: [shellTask("bg1", "sleep 600")] }))).toEqual(SILENT);
});

test("an unparseable payload fails open", () => {
    expect(runHook("{not json")).toEqual(SILENT);
});

test("a block leaves its marker under TMPDIR", () => {
    writeTranscript(shellStarted("bg1"));

    blockReason(runHook(payload({ background_tasks: [shellTask("bg1", "sleep 600")] })).stdout);

    expect(existsSync(join(scratchTmp, "ac-subagent-stop", "agent1"))).toBe(true);
});

test.skipIf(!existsSync(REAL_TRANSCRIPT))("a real transcript's moved-to-background id blocks once marked running", () => {
    copyFileSync(REAL_TRANSCRIPT, transcript);

    const result = runHook(
        payload({ background_tasks: [shellTask(REAL_TRANSCRIPT_TASK_ID, "composer test -- --filter=Incident")] }),
    );

    expect(blockReason(result.stdout)).toContain(REAL_TRANSCRIPT_TASK_ID);
});
