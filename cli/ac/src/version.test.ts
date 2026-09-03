import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AC_VERSION } from "./version.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(SRC_DIR, "..", "package.json");

test("the exported version matches package.json", () => {
    const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    const version = (pkg as { version?: unknown }).version;

    expect(AC_VERSION).toBe(version as string);
});

test("no source file hardcodes a version literal", () => {
    // The drift this catches: `mcp.ts` advertised "0.9.1" to every MCP client while both manifests
    // read 0.11.0, because the number was typed in two places and bumped in neither. One exported
    // constant plus this test is what stops it recurring.
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC_DIR)) {
        if (!entry.endsWith(".ts") || entry === "version.ts" || entry.endsWith(".test.ts")) {
            continue;
        }
        const text = readFileSync(join(SRC_DIR, entry), "utf8");
        for (const match of text.matchAll(/version:\s*"(\d+\.\d+\.\d+)"|\.version\("(\d+\.\d+\.\d+)"\)/g)) {
            offenders.push(`${entry}: ${match[1] ?? match[2]}`);
        }
    }

    expect(offenders).toEqual([]);
});
