import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// wake-count.jq is jq, not TypeScript, but CI only runs `bun test` here, so this is where the
// strict-mode shell grammar is pinned: a wrong allow switches a run's Stop guard off for as long
// as the task lives, a wrong block costs one turn.
const WAKE_COUNT = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "lib",
    "wake-count.jq",
);

function strictCount(command: string): number {
    const payload = JSON.stringify({
        hook_event_name: "Stop",
        background_tasks: [{ type: "shell", command }],
    });
    const result = Bun.spawnSync(["jq", "-r", "--arg", "mode", "strict", "-f", WAKE_COUNT], {
        stdin: Buffer.from(payload),
    });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);

    return Number(result.stdout.toString().trim());
}

const counted: string[] = [
    "timeout 600 claude -p x > out 2>&1",
    "cd /tmp/a && timeout 300 npm run thing",
    "F=1 && timeout 60 sh -c 'while true; do sleep 5; done'",
    "export A=1 B=2 && timeout 60 npm run thing",
    "cd /tmp/a && F=1 && timeout 120 npm run thing 2>&1",
    "timeout 60 npm run thing 2>/dev/null",
    "timeout 60 npm run thing &>log",
    "timeout 60 npm run thing >&log",
    "timeout 60 npm run thing > out 2>&1",
    "timeout 3600 npm run thing",
];

const notCounted: string[] = [
    "cd /tmp/a && claude -p x",
    "timeout 0 npm run dev",
    "timeout 86400 npm run dev",
    "timeout 60 a; rm -rf x",
    "timeout 60 a | tee f",
    "timeout 60 a &",
    "timeout 60 a 2>&1 &",
    "timeout 60 a >&2 & b",
    "cd /tmp/a timeout 60 npm run thing",
    "cd /tmp/a; timeout 60 npm run thing",
    "cd /tmp/a || timeout 60 npm run thing",
    "cd $(sleep infinity) && timeout 60 npm run thing",
    "F=1 && claude -p x",
    "timeout 60 a && rm -rf x",
    "timeout 3601 npm run thing",
];

test.each(counted)("strict mode counts a bounded wait: %s", (command) => {
    expect(strictCount(command)).toBe(1);
});

test.each(notCounted)("strict mode leaves out an unbounded or chained shell: %s", (command) => {
    expect(strictCount(command)).toBe(0);
});

test("strict mode leaves out a clipped command whose tail cannot be seen", () => {
    expect(strictCount("cd /tmp/a && timeout 60 npm run thing [+40 chars]")).toBe(0);
});
