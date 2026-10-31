import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: a write to a memory file is denied, naming the writer
// skill, until the transcript shows that skill was loaded; every other path and every payload it
// cannot read passes silently.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "pretooluse-memory-file-gate.sh",
);

let root: string;
let transcript: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-memory-gate-"));
    transcript = join(root, "transcript.jsonl");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            AC_MEMORY_FILE_GATE: "",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(filePath: string, transcriptPath: string | null = transcript): string {
    return JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
            file_path: filePath,
        },
        ...(transcriptPath === null ? {} : { transcript_path: transcriptPath }),
    });
}

function toolUse(name: string, input: Record<string, string>): string {
    return JSON.stringify({
        type: "assistant",
        message: {
            content: [{ type: "tool_use", id: "t1", name, input }],
        },
    });
}

function writeTranscript(...lines: string[]): void {
    writeFileSync(transcript, `${lines.join("\n")}\n`);
}

function denyReason(stdout: string): string {
    const output = JSON.parse(stdout) as {
        hookSpecificOutput?: {
            hookEventName?: string;
            permissionDecision?: string;
            permissionDecisionReason?: string;
        };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");

    return output.hookSpecificOutput?.permissionDecisionReason ?? "";
}

const SILENT: HookResult = { exitCode: 0, stdout: "" };
const RULE_FILE = "/tmp/x/.claude/rules/a.md";

test("a rule file with no skill in the transcript is denied with the skill and an existing SKILL.md path", () => {
    writeTranscript(toolUse("Read", { file_path: "/tmp/x/src/index.ts" }));

    const result = runHook(payload(RULE_FILE));
    const reason = denyReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain(RULE_FILE);
    expect(reason).toContain("ac:claude-md-rules-creator");

    const skillPath = /Read (\S+SKILL\.md),/.exec(reason)?.[1] ?? "";
    expect(skillPath.endsWith("/skills/claude-md-rules-creator/SKILL.md")).toBe(true);
    expect(existsSync(skillPath)).toBe(true);
});

test("a Skill call for the right skill allows the write", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:claude-md-rules-creator" }));

    expect(runHook(payload("/tmp/x/CLAUDE.md"))).toEqual(SILENT);
});

test("a Skill call written with a space after the colon allows the write", () => {
    writeTranscript(
        '{"type":"assistant","message":{"content":[{"type": "tool_use", "name": "Skill", "input": {"skill": "ac:claude-md-rules-creator"}}]}}',
    );

    expect(runHook(payload("/tmp/x/CLAUDE.md"))).toEqual(SILENT);
});

test("a Skill call for a different skill is denied", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:project-md-writer" }));

    expect(denyReason(runHook(payload("/tmp/x/CLAUDE.md")).stdout)).toContain("ac:claude-md-rules-creator");
});

test("a Read of the skill body allows the write", () => {
    writeTranscript(
        toolUse("Read", { file_path: "/plugins/ac/skills/claude-md-rules-creator/SKILL.md" }),
    );

    expect(runHook(payload(RULE_FILE))).toEqual(SILENT);
});

test("a subagent's Read of the skill body in its own transcript allows the write", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:project-md-writer" }));
    const agentDir = join(root, "transcript", "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
        join(agentDir, "agent-a123.jsonl"),
        `${toolUse("Read", { file_path: "/plugins/ac/skills/claude-md-rules-creator/SKILL.md" })}\n`,
    );
    const subagentPayload = JSON.stringify({ ...JSON.parse(payload(RULE_FILE)), agent_id: "a123" });

    expect(runHook(subagentPayload)).toEqual(SILENT);
});

test("a Read of another skill body is denied", () => {
    writeTranscript(toolUse("Read", { file_path: "/plugins/ac/skills/project-md-writer/SKILL.md" }));

    denyReason(runHook(payload(RULE_FILE)).stdout);
});

test("the init-project slash command counts as loading the rules skill for CLAUDE.md", () => {
    writeTranscript(
        JSON.stringify({
            type: "user",
            message: { content: "<command-message>init-project</command-message>\n<command-name>/ac:init-project</command-name>" },
        }),
    );

    expect(runHook(payload("/tmp/x/CLAUDE.md"))).toEqual(SILENT);
});

test("the init-project slash command does not stand in for the PROJECT.md skill", () => {
    writeTranscript(
        JSON.stringify({ type: "user", message: { content: "<command-name>/ac:init-project</command-name>" } }),
    );

    expect(denyReason(runHook(payload("/tmp/x/PROJECT.md")).stdout)).toContain("ac:project-md-writer");
});

test("a slash command for the skill itself allows the write", () => {
    writeTranscript(
        JSON.stringify({ type: "user", message: { content: "<command-name>/ac:design-md-writer</command-name>" } }),
    );

    expect(runHook(payload("/tmp/x/DESIGN.md"))).toEqual(SILENT);
});

test("PROJECT.md maps to ac:project-md-writer", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:claude-md-rules-creator" }));

    const reason = denyReason(runHook(payload("/tmp/x/PROJECT.md")).stdout);

    expect(reason).toContain("ac:project-md-writer");
    expect(reason).toContain("/skills/project-md-writer/SKILL.md");
});

test("DESIGN.md maps to ac:design-md-writer", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:claude-md-rules-creator" }));

    const reason = denyReason(runHook(payload("/tmp/x/DESIGN.md")).stdout);

    expect(reason).toContain("ac:design-md-writer");
    expect(reason).toContain("/skills/design-md-writer/SKILL.md");
});

test("CLAUDE.local.md and AGENTS.md are governed by the rules skill", () => {
    writeTranscript(toolUse("Read", { file_path: "/tmp/x/src/index.ts" }));

    expect(denyReason(runHook(payload("/tmp/x/CLAUDE.local.md")).stdout)).toContain("ac:claude-md-rules-creator");
    expect(denyReason(runHook(payload("/tmp/x/AGENTS.md")).stdout)).toContain("ac:claude-md-rules-creator");
});

test("skipped paths pass silently even with no skill loaded", () => {
    writeTranscript(toolUse("Read", { file_path: "/tmp/x/src/index.ts" }));

    for (const path of [
        "/home/me/.claude/projects/-tmp-x/memory/CLAUDE.md",
        "/tmp/x/node_modules/pkg/CLAUDE.md",
        "/tmp/x/vendor/pkg/.claude/rules/a.md",
        "/tmp/x/references/repo/CLAUDE.md",
        "/home/me/.claude/plugins/cache/ac/CLAUDE.md",
        "/repo/plugins/ac/skills/claude-md-rules-creator/examples/CLAUDE.md",
    ]) {
        expect(runHook(payload(path))).toEqual(SILENT);
    }
});

test("a file that is not a memory file passes silently", () => {
    writeTranscript(toolUse("Read", { file_path: "/tmp/x/src/index.ts" }));

    for (const path of ["/tmp/x/src/index.ts", "/tmp/x/CLAUDE.template.md", "/tmp/x/docs/notes.md", "/tmp/x/.claude/rules/a.txt"]) {
        expect(runHook(payload(path))).toEqual(SILENT);
    }
});

test("AC_MEMORY_FILE_GATE=0 turns the gate off", () => {
    writeTranscript(toolUse("Read", { file_path: "/tmp/x/src/index.ts" }));

    expect(runHook(payload(RULE_FILE), { AC_MEMORY_FILE_GATE: "0" })).toEqual(SILENT);
});

test("a missing or unreadable transcript fails open", () => {
    expect(runHook(payload(RULE_FILE, null))).toEqual(SILENT);
    expect(runHook(payload(RULE_FILE, join(root, "absent.jsonl")))).toEqual(SILENT);
});

test("an unparseable or empty payload fails open", () => {
    expect(runHook("not json")).toEqual(SILENT);
    expect(runHook("")).toEqual(SILENT);
});

test("inside a subagent the parent's skill load is not proof", () => {
    writeTranscript(toolUse("Skill", { skill: "ac:claude-md-rules-creator" }));
    const agentDir = join(root, "transcript", "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent-b456.jsonl"), `${toolUse("Read", { file_path: "/x/app.php" })}\n`);
    const subagentPayload = JSON.stringify({ ...JSON.parse(payload(RULE_FILE)), agent_id: "b456" });

    expect(denyReason(runHook(subagentPayload).stdout)).toContain("ac:claude-md-rules-creator");
});

test("a subagent with no readable transcript of its own fails open", () => {
    writeTranscript();
    const subagentPayload = JSON.stringify({ ...JSON.parse(payload(RULE_FILE)), agent_id: "missing" });

    expect(runHook(subagentPayload)).toEqual(SILENT);
});

test("the install command counts as loading the rules skill", () => {
    writeTranscript('{"type":"user","message":{"content":"<command-name>/ac:install</command-name>"}}');

    expect(runHook(payload("/tmp/home/.claude/CLAUDE.md"))).toEqual(SILENT);
});
