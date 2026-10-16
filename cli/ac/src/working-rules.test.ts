import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the shape of the plugin-shipped working rules. A SessionStart hook extracts the text between
// the two markers and delivers it whole only while it stays under the ~10,000-character hook output
// cap, and it detects an already-delivered copy by the exact first line. The text reaches the main
// thread as system-level prose, so it is written in the built-in prompt's voice, not the user's.
const RULES = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "references",
    "working-rules.md",
);

const START = "<!-- ac:working-rules:start -->";
const END = "<!-- ac:working-rules:end -->";

const SECTIONS = [
    "Reading the request",
    "Grounding",
    "Decisions",
    "Research and review",
    "Plan or work directly",
    "Web research",
    "Run to completion",
    "Before you call it done",
];

const USER_VOICE = [
    "this file",
    "my request",
    "Talk to me",
    " I ",
    " me ",
];

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

function extract(source: string): string {
    const start = source.indexOf(START);
    const end = source.indexOf(END);

    return source.slice(start + START.length, end).trim();
}

const source = readFileSync(RULES, "utf8");
const block = extract(source);

test("each marker appears exactly once, start before end", () => {
    expect(occurrences(source, START)).toBe(1);
    expect(occurrences(source, END)).toBe(1);
    expect(source.indexOf(START)).toBeLessThan(source.indexOf(END));
});

test("the block opens with the duplicate-detection heading", () => {
    expect(block.split("\n")[0]).toBe("# Working rules (ac plugin)");
});

test("every moved section is a top-level heading", () => {
    const lines = block.split("\n");

    for (const section of SECTIONS) {
        expect(lines).toContain(`# ${section}`);
    }
});

test("the block fits one hook output with headroom", () => {
    expect(block.length).toBeLessThan(9500);
});

test("the block carries no en-dash or em-dash", () => {
    expect(block).not.toMatch(/[–—]/);
});

test("the block is not written in the user's voice", () => {
    for (const phrase of USER_VOICE) {
        expect(block).not.toContain(phrase);
    }
});
