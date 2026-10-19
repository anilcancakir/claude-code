import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook tests spawn `sh <hook>`, which runs a script whatever its mode, while Claude Code execs
// the command string in hooks.json directly. A script committed without its executable bit passes
// every other test and fails every live event with exit 126 (stop-guard-coordinate.sh shipped that
// way once). This pins the one property the other tests cannot see.
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac");
const ROOT_TOKEN = '"${CLAUDE_PLUGIN_ROOT}"/';

type HookEntry = { type: string; command: string };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type HooksFile = { hooks: Record<string, HookGroup[]> };

function registeredScripts(): string[] {
    const parsed = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")) as HooksFile;
    const scripts = new Set<string>();
    for (const groups of Object.values(parsed.hooks)) {
        for (const group of groups) {
            for (const hook of group.hooks) {
                if (hook.type !== "command" || !hook.command.startsWith(ROOT_TOKEN)) continue;
                scripts.add(hook.command.slice(ROOT_TOKEN.length).split(" ")[0] ?? "");
            }
        }
    }
    return [...scripts].filter((script) => script !== "");
}

test("hooks.json registers at least one plugin script", () => {
    expect(registeredScripts().length).toBeGreaterThan(0);
});

test("every script hooks.json registers is executable by its owner", () => {
    const notExecutable = registeredScripts().filter((script) => (statSync(join(PLUGIN, script)).mode & 0o100) === 0);
    expect(notExecutable).toEqual([]);
});
