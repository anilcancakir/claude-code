import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: one `decision: block` per explore or librarian agent
// whose last message runs past its word cap, and silence on everything else.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "subagentstop-report-length.sh",
);

let root: string;
let scratchTmp: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-report-length-"));
    scratchTmp = join(root, "tmp");
    mkdirSync(scratchTmp);
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
            TMPDIR: scratchTmp,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function words(count: number): string {
    return Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
}

function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "ac:explore",
        agent_id: "agent1",
        stop_hook_active: false,
        last_assistant_message: words(1000),
        background_tasks: [],
        ...overrides,
    });
}

function blockReason(stdout: string): string {
    const output = JSON.parse(stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

const SILENT: HookResult = { exitCode: 0, stdout: "" };

test("an explore report over 900 words blocks, naming the count and the cap", () => {
    const result = runHook(payload());
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("1000 words");
    expect(reason).toContain("cap is 900");
    expect(reason).toContain("file_path:line_number");
    expect(reason).toContain("last message alone");
});

test("a brief carrying REPORT-LENGTH: unbounded lets an over-cap report through", () => {
    const transcript = join(root, "agent.jsonl");
    const brief = { type: "user", message: { role: "user", content: "Classify every section.\n\nREPORT-LENGTH: unbounded" } };
    writeFileSync(transcript, `${JSON.stringify(brief)}\n{torn line\n`);

    expect(runHook(payload({ agent_transcript_path: transcript, last_assistant_message: words(3000) }))).toEqual(SILENT);
});

test("a brief without the opt-out, or with it only in a later message, still blocks", () => {
    const transcript = join(root, "agent.jsonl");
    const brief = { type: "user", message: { role: "user", content: [{ type: "text", text: "List callers." }] } };
    const later = { type: "user", message: { role: "user", content: "REPORT-LENGTH: unbounded" } };
    writeFileSync(transcript, `${JSON.stringify(brief)}\n${JSON.stringify(later)}\n`);

    const reason = blockReason(runHook(payload({ agent_transcript_path: transcript })).stdout);
    expect(reason).toContain("repeat it under the cap");
});

test("an explore report at exactly 900 words is silent", () => {
    expect(runHook(payload({ last_assistant_message: words(900) }))).toEqual(SILENT);
});

test("an explore report at 901 words blocks", () => {
    expect(blockReason(runHook(payload({ last_assistant_message: words(901) })).stdout)).toContain("901 words");
});

test("a librarian report of 1000 words is silent", () => {
    expect(runHook(payload({ agent_type: "ac:librarian" }))).toEqual(SILENT);
});

test("a librarian report of 1300 words blocks against its own cap", () => {
    const result = runHook(payload({ agent_type: "ac:librarian", last_assistant_message: words(1300) }));
    const reason = blockReason(result.stdout);

    expect(reason).toContain("1300 words");
    expect(reason).toContain("cap is 1200");
});

test("the bare names explore and librarian are in scope", () => {
    const explore = runHook(payload({ agent_type: "explore" }));
    const librarian = runHook(payload({ agent_type: "librarian", agent_id: "agent2", last_assistant_message: words(1300) }));

    expect(blockReason(explore.stdout)).toContain("cap is 900");
    expect(blockReason(librarian.stdout)).toContain("cap is 1200");
});

test("another agent type is silent however long its report", () => {
    expect(runHook(payload({ agent_type: "ac:oracle", last_assistant_message: words(5000) }))).toEqual(SILENT);
});

test("a main-thread payload without agent_type is silent", () => {
    const main = JSON.parse(payload()) as Record<string, unknown>;
    delete main.agent_type;
    delete main.agent_id;

    expect(runHook(JSON.stringify(main))).toEqual(SILENT);
});

test("stop_hook_active true is silent", () => {
    expect(runHook(payload({ stop_hook_active: true }))).toEqual(SILENT);
});

test("a second stop for the same agent id is silent", () => {
    const stdin = payload();

    blockReason(runHook(stdin).stdout);

    expect(runHook(stdin)).toEqual(SILENT);
});

test("a distinct agent id is blocked independently", () => {
    blockReason(runHook(payload()).stdout);

    blockReason(runHook(payload({ agent_id: "agent2" })).stdout);
});

test("a missing last_assistant_message is silent", () => {
    const missing = JSON.parse(payload()) as Record<string, unknown>;
    delete missing.last_assistant_message;

    expect(runHook(JSON.stringify(missing))).toEqual(SILENT);
});

test("an empty or non-string last_assistant_message is silent", () => {
    expect(runHook(payload({ last_assistant_message: "" }))).toEqual(SILENT);
    expect(runHook(payload({ last_assistant_message: null }))).toEqual(SILENT);
});

test("an unsafe agent id is silent", () => {
    expect(runHook(payload({ agent_id: "../escape" }))).toEqual(SILENT);
});

test("malformed JSON on stdin is silent with exit 0", () => {
    expect(runHook("{not json")).toEqual(SILENT);
});

test("a block leaves its marker under TMPDIR, a silent run does not", () => {
    runHook(payload({ agent_id: "quiet", last_assistant_message: words(10) }));

    expect(existsSync(join(scratchTmp, "ac-report-length", "quiet"))).toBe(false);

    blockReason(runHook(payload()).stdout);

    expect(existsSync(join(scratchTmp, "ac-report-length", "agent1"))).toBe(true);
});
