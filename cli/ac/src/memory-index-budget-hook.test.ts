import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: silent under budget, `decision: block` over it, and
// silent on anything it cannot read.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "posttooluse-memory-index-budget.sh",
);

let root: string;
let index: string;

beforeEach(() => {
    // The auto-memory layout: <config dir>/projects/<project>/memory/MEMORY.md.
    root = mkdtempSync(join(tmpdir(), "ac-memory-budget-"));
    mkdirSync(join(root, "projects", "-Users-me-app", "memory"), { recursive: true });
    index = join(root, "projects", "-Users-me-app", "memory", "MEMORY.md");
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
            AC_MEMORY_INDEX_MAX_LINES: "",
            AC_MEMORY_INDEX_MAX_BYTES: "",
            AC_MEMORY_INDEX_MAX_LINE_BYTES: "",
            AC_MEMORY_NOTE_MAX_LINES: "",
            AC_MEMORY_NOTE_MAX_BYTES: "",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(filePath: string): string {
    return JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
            file_path: filePath,
        },
    });
}

function pointers(count: number): string {
    return Array.from({ length: count }, (_, i) => `- [Topic ${i}](topic_${i}.md) - hook ${i}`).join("\n") + "\n";
}

function blockReason(stdout: string): string {
    const output = JSON.parse(stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

test("an index under budget passes silently", () => {
    writeFileSync(index, pointers(10));

    expect(runHook(payload(index))).toEqual({ exitCode: 0, stdout: "" });
});

test("a write to a file that is not a note or the index passes silently, even when it is huge", () => {
    const other = join(dirname(index), "topic.txt");
    writeFileSync(other, pointers(500));

    expect(runHook(payload(other))).toEqual({ exitCode: 0, stdout: "" });
});

test("a MEMORY.md outside the auto-memory layout passes silently", () => {
    // A repository's own memory/MEMORY.md is not the index Claude Code loads.
    mkdirSync(join(root, "repo", "memory"), { recursive: true });
    const repoFile = join(root, "repo", "memory", "MEMORY.md");
    writeFileSync(repoFile, pointers(500));

    expect(runHook(payload(repoFile))).toEqual({ exitCode: 0, stdout: "" });
});

test("a last line without a trailing newline still counts", () => {
    writeFileSync(index, pointers(81).trimEnd());

    expect(blockReason(runHook(payload(index)).stdout)).toContain("81/80 lines");
});

test("an index over the line budget blocks with the counts and the path", () => {
    writeFileSync(index, pointers(81));

    const result = runHook(payload(index));
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("81/80 lines");
    expect(reason).toContain(index);
    expect(reason).toContain("_index-<theme>.md");
});

test("an index over the byte budget blocks", () => {
    // 78 lines of 135 bytes: under the line budget and every line under 150, 10,530 bytes in all.
    writeFileSync(index, `${"- [x](x.md) - " + "y".repeat(120)}\n`.repeat(78));

    expect(blockReason(runHook(payload(index)).stdout)).toContain("78/80 lines, 10530/10240 bytes");
});

test("line length is measured in bytes, so Turkish letters count twice", () => {
    // 80 two-byte letters are 80 characters but 160 bytes.
    writeFileSync(index, `- [a](a.md) - ok\n- [b](b.md) - ${"ş".repeat(80)}\n`);

    expect(blockReason(runHook(payload(index)).stdout)).toContain("lines over 150 bytes: 2");
});

test("an env override tightens a limit", () => {
    writeFileSync(index, pointers(10));

    const reason = blockReason(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "5" }).stdout);

    expect(reason).toContain("10/5 lines");
});

test("an env override of 0 turns that check off", () => {
    writeFileSync(index, pointers(120));

    expect(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "0" })).toEqual({ exitCode: 0, stdout: "" });
});

test("a non-numeric override falls back to the default", () => {
    writeFileSync(index, pointers(81));

    expect(blockReason(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "lots" }).stdout)).toContain("81/80 lines");
});

test("an unparseable payload fails open", () => {
    expect(runHook("not json")).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook("")).toEqual({ exitCode: 0, stdout: "" });
});

test("a missing index fails open", () => {
    expect(runHook(payload(index))).toEqual({ exitCode: 0, stdout: "" });
});

function note(name: string): string {
    return join(dirname(index), name);
}

function editPayload(filePath: string, oldString: string, newString: string): string {
    return JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
    });
}

function multiEditPayload(filePath: string, edits: { old_string: string; new_string: string }[]): string {
    return JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "MultiEdit",
        tool_input: { file_path: filePath, edits },
    });
}

function facts(count: number): string {
    return Array.from({ length: count }, (_, i) => `fact ${i}`).join("\n") + "\n";
}

test("a topic note over the line ceiling blocks with the counts, the path and the condense advice", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    const result = runHook(payload(file));
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("60/40 lines");
    expect(reason).toContain("/3072 bytes");
    expect(reason).toContain(file);
    expect(reason).toContain("one durable fact");
    expect(reason).toContain("repository");
    expect(reason).toContain("Never delete a note whose facts you have not carried over");
    expect(reason).not.toContain("_index-<theme>.md");
});

test("a topic note over the byte ceiling blocks", () => {
    const file = note("a.md");
    // 10 lines of 400 bytes: under the line ceiling, 4,000 bytes in all.
    writeFileSync(file, `${"x".repeat(399)}\n`.repeat(10));

    expect(blockReason(runHook(payload(file)).stdout)).toContain("10/40 lines, 4000/3072 bytes");
});

test("a short topic note passes silently", () => {
    const file = note("a.md");
    writeFileSync(file, facts(20));

    expect(runHook(payload(file))).toEqual({ exitCode: 0, stdout: "" });
});

test("a last note line without a trailing newline still counts", () => {
    const file = note("a.md");
    writeFileSync(file, facts(41).trimEnd());

    expect(blockReason(runHook(payload(file)).stdout)).toContain("41/40 lines");
});

test("a sub-index is exempt from the note ceiling: it is the overflow MEMORY.md asks for", () => {
    const file = note("_index-hooks.md");
    writeFileSync(file, pointers(60));

    expect(runHook(payload(file))).toEqual({ exitCode: 0, stdout: "" });
});

test("an Edit that shrinks a long note passes silently", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    expect(runHook(editPayload(file, "fact 1\nfact 2\n", "fact 1\n"))).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook(editPayload(file, "fact 1", "fact 2"))).toEqual({ exitCode: 0, stdout: "" });
});

test("an Edit that grows a long note blocks", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    expect(blockReason(runHook(editPayload(file, "fact 1", "fact 1 and more")).stdout)).toContain("60/40 lines");
});

test("a MultiEdit counts the sum of its edits", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    const shrinking = multiEditPayload(file, [
        { old_string: "fact 1\n", new_string: "" },
        { old_string: "fact 2", new_string: "fact two" },
    ]);
    const growing = multiEditPayload(file, [
        { old_string: "fact 1\n", new_string: "" },
        { old_string: "fact 2", new_string: "fact 2 with a much longer tail" },
    ]);

    expect(runHook(shrinking)).toEqual({ exitCode: 0, stdout: "" });
    expect(blockReason(runHook(growing).stdout)).toContain("60/40 lines");
});

test("a MEMORY.md write keeps its own budget and reason", () => {
    // 60 lines is over the note ceiling but under the index budget of 80.
    writeFileSync(index, pointers(60));
    expect(runHook(payload(index))).toEqual({ exitCode: 0, stdout: "" });

    writeFileSync(index, pointers(81));
    const reason = blockReason(runHook(payload(index)).stdout);

    expect(reason).toContain("MEMORY.md is over its budget (81/80 lines");
    expect(reason).toContain("_index-<theme>.md");
});

test("a note env override tightens each ceiling", () => {
    const file = note("a.md");
    writeFileSync(file, facts(10));

    expect(blockReason(runHook(payload(file), { AC_MEMORY_NOTE_MAX_LINES: "5" }).stdout)).toContain("10/5 lines");
    expect(blockReason(runHook(payload(file), { AC_MEMORY_NOTE_MAX_BYTES: "20" }).stdout)).toContain("/20 bytes");
});

test("a note env override of 0 turns that check off", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    expect(runHook(payload(file), { AC_MEMORY_NOTE_MAX_LINES: "0" })).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook(payload(file), { AC_MEMORY_NOTE_MAX_LINES: "0", AC_MEMORY_NOTE_MAX_BYTES: "0" })).toEqual({
        exitCode: 0,
        stdout: "",
    });
});

test("a non-numeric note override falls back to the default", () => {
    const file = note("a.md");
    writeFileSync(file, facts(60));

    expect(blockReason(runHook(payload(file), { AC_MEMORY_NOTE_MAX_LINES: "lots" }).stdout)).toContain("60/40 lines");
});

test("a note outside projects/*/memory/ passes silently", () => {
    mkdirSync(join(root, "repo", "memory"), { recursive: true });
    const repoNote = join(root, "repo", "memory", "a.md");
    writeFileSync(repoNote, facts(200));
    const nested = join(dirname(index), "sub");
    mkdirSync(nested);
    const nestedNote = join(nested, "a.md");
    writeFileSync(nestedNote, facts(200));
    const wrongExtension = note("a.txt");
    writeFileSync(wrongExtension, facts(200));
    // A repository that lives under a projects/ directory is not an auto-memory directory.
    mkdirSync(join(root, "projects", "app", "docs", "memory"), { recursive: true });
    const underProjects = join(root, "projects", "app", "docs", "memory", "guide.md");
    writeFileSync(underProjects, facts(200));

    expect(runHook(payload(repoNote))).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook(payload(nestedNote))).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook(payload(wrongExtension))).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook(payload(underProjects))).toEqual({ exitCode: 0, stdout: "" });
});

test("a missing note fails open", () => {
    expect(runHook(payload(note("gone.md")))).toEqual({ exitCode: 0, stdout: "" });
});
