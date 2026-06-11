// Set AC_EXTERNAL_AGENT_LIVE=1 to run live tests; requires codex/gemini/opencode on PATH.

import { expect, test } from "bun:test";
import { spawn as realSpawn } from "node:child_process";
import { execSync } from "node:child_process";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildArgv, runExternalAgent, validateInputs } from "./external-agent.ts";

test("buildArgv codex with model", () => {
    const argv = buildArgv("codex", "do a thing", "/tmp/proj", "gpt-5.5");
    expect(argv).toEqual([
        "codex",
        "--cd",
        "/tmp/proj",
        "exec",
        "--model",
        "gpt-5.5",
        "--skip-git-repo-check",
        "-",
    ]);
});

test("buildArgv codex without model", () => {
    const argv = buildArgv("codex", "do a thing", "/tmp/proj", undefined);
    expect(argv).toEqual([
        "codex",
        "--cd",
        "/tmp/proj",
        "exec",
        "--skip-git-repo-check",
        "-",
    ]);
});

test("buildArgv gemini with model", () => {
    const argv = buildArgv("gemini", "do a thing", "/tmp/proj", "gemini-2.5-flash");
    expect(argv).toEqual([
        "gemini",
        "-p",
        "do a thing",
        "--model",
        "gemini-2.5-flash",
    ]);
});

test("buildArgv gemini without model", () => {
    const argv = buildArgv("gemini", "do a thing", "/tmp/proj", undefined);
    expect(argv).toEqual([
        "gemini",
        "-p",
        "do a thing",
    ]);
});

test("buildArgv opencode with model", () => {
    const argv = buildArgv("opencode", "do a thing", "/tmp/proj", "anthropic/claude-sonnet-4-6");
    expect(argv).toEqual([
        "opencode",
        "run",
        "--dir",
        "/tmp/proj",
        "--model",
        "anthropic/claude-sonnet-4-6",
    ]);
});

test("buildArgv opencode without model", () => {
    const argv = buildArgv("opencode", "do a thing", "/tmp/proj", undefined);
    expect(argv).toEqual([
        "opencode",
        "run",
        "--dir",
        "/tmp/proj",
    ]);
});

test("buildArgv codex respects AC_EXTERNAL_AGENT_CODEX_BIN env override", () => {
    const original = process.env["AC_EXTERNAL_AGENT_CODEX_BIN"];
    try {
        process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] = "/custom/codex";
        const argv = buildArgv("codex", "p", "/tmp", undefined);
        expect(argv[0]).toBe("/custom/codex");
    } finally {
        if (original === undefined) {
            delete process.env["AC_EXTERNAL_AGENT_CODEX_BIN"];
        } else {
            process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] = original;
        }
    }
});

// validateInputs — happy paths

test("validateInputs happy path minimal", () => {
    const result = validateInputs({ cli: "codex", prompt: "hi", directory: "/tmp" });
    expect(result).toEqual({
        cli: "codex",
        prompt: "hi",
        directory: "/tmp",
        model: undefined,
        timeoutSeconds: 600,
    });
});

test("validateInputs happy path with model and timeout", () => {
    const result = validateInputs({ cli: "gemini", prompt: "hi", directory: "/tmp", model: "pro", timeout_seconds: 120 });
    expect(result).toEqual({
        cli: "gemini",
        prompt: "hi",
        directory: "/tmp",
        model: "pro",
        timeoutSeconds: 120,
    });
});

// validateInputs — rejection cases

test("validateInputs rejects missing cli", () => {
    expect(() => validateInputs({ prompt: "hi", directory: "/tmp" })).toThrow(McpError);
    try {
        validateInputs({ prompt: "hi", directory: "/tmp" });
    } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(-32602);
    }
});

test("validateInputs rejects invalid cli", () => {
    expect(() => validateInputs({ cli: "claude", prompt: "hi", directory: "/tmp" })).toThrow(McpError);
});

test("validateInputs rejects empty prompt", () => {
    expect(() => validateInputs({ cli: "codex", prompt: "  ", directory: "/tmp" })).toThrow(McpError);
});

test("validateInputs rejects relative directory", () => {
    let thrown: unknown;
    try {
        validateInputs({ cli: "codex", prompt: "hi", directory: "./relative" });
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("absolute");
});

test("validateInputs rejects non-existent directory", () => {
    let thrown: unknown;
    try {
        validateInputs({ cli: "codex", prompt: "hi", directory: "/no/such/path/i/just/made/up" });
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("does not exist");
});

test("validateInputs rejects file path that is not a directory", () => {
    let thrown: unknown;
    try {
        validateInputs({ cli: "codex", prompt: "hi", directory: import.meta.path });
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("not a directory");
});

test("validateInputs clamps timeout to min and max", () => {
    const low = validateInputs({ cli: "codex", prompt: "hi", directory: "/tmp", timeout_seconds: 5 });
    expect(low.timeoutSeconds).toBe(10);

    const high = validateInputs({ cli: "codex", prompt: "hi", directory: "/tmp", timeout_seconds: 10000 });
    expect(high.timeoutSeconds).toBe(3600);
});

// runExternalAgent — fake-binary harness via injectable spawnImpl.

// Substitutes the bin + argv with a node -e fake script while preserving cwd,
// env, stdio, detached, windowsHide. Returns a spawnImpl matching typeof spawn.
function fakeBinSpawn(script: string): typeof realSpawn {
    return ((_bin: string, _args: readonly string[] | undefined, options: object) => {
        return realSpawn("node", ["-e", script], options as Parameters<typeof realSpawn>[2]);
    }) as typeof realSpawn;
}

test("runExternalAgent happy path: echoes stdin via fake binary", async () => {
    const script = `process.stdin.on("data", d => process.stdout.write("got: " + d)); process.stdin.on("end", () => process.exit(0));`;
    const result = await runExternalAgent(
        { cli: "codex", prompt: "ping", directory: "/tmp" },
        { spawnImpl: fakeBinSpawn(script) },
    );
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("got: ");
    expect(result.content[0]?.text).toContain("ping");
});

test("runExternalAgent propagates validateInputs InvalidParams for non-existent dir", async () => {
    let thrown: unknown;
    try {
        await runExternalAgent({ cli: "codex", prompt: "hi", directory: "/no/such/dir/ever" });
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32602);
    expect((thrown as McpError).message).toContain("does not exist");
});

test("runExternalAgent throws InternalError on non-zero exit, includes code and stderr tail", async () => {
    const script = `console.error("boom"); process.exit(2);`;
    let thrown: unknown;
    try {
        await runExternalAgent(
            { cli: "codex", prompt: "ping", directory: "/tmp" },
            { spawnImpl: fakeBinSpawn(script) },
        );
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("exited 2");
    expect((thrown as McpError).message).toContain("boom");
});

test("runExternalAgent throws InternalError on timeout", async () => {
    const script = `setInterval(() => {}, 1000);`;
    let thrown: unknown;
    try {
        await runExternalAgent(
            { cli: "codex", prompt: "ping", directory: "/tmp" },
            { spawnImpl: fakeBinSpawn(script), timeoutMsOverride: 1000 },
        );
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("timed out");
});

test.skipIf(process.platform === "win32")("runExternalAgent process-group kill leaves no orphan grandchild (POSIX)", async () => {
    const sentinel = `ac-external-agent-sentinel-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    // Parent fake binary spawns a grandchild whose argv contains the sentinel so `ps` can spot orphans.
    const script = `
        const cp = require("child_process");
        cp.spawn("node", ["-e", "setInterval(()=>{},1000); /* ${sentinel} */"], { stdio: "ignore", detached: false });
        setInterval(() => {}, 1000);
    `;
    let thrown: unknown;
    try {
        await runExternalAgent(
            { cli: "codex", prompt: "ping", directory: "/tmp" },
            { spawnImpl: fakeBinSpawn(script), timeoutMsOverride: 1000 },
        );
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("timed out");

    // SIGKILL grace fires 5s after SIGTERM; wait long enough for the group kill to propagate.
    await new Promise((r) => setTimeout(r, 6000));

    let psOutput = "";
    try {
        psOutput = execSync(`ps -ef | grep '${sentinel}' | grep -v grep`, { encoding: "utf8" });
    } catch {
        // grep exit 1 when no match — that's the success state.
        psOutput = "";
    }
    expect(psOutput.trim()).toBe("");
}, 15000);

test("runExternalAgent scrubs KODIZM_* and AC_EXTERNAL_AGENT_*_BIN from child env, preserves PATH", async () => {
    const script = `console.log(JSON.stringify(process.env));`;
    const originals = {
        KODIZM_MCP_TOKEN: process.env["KODIZM_MCP_TOKEN"],
        KODIZM_MCP_URL: process.env["KODIZM_MCP_URL"],
        AC_EXTERNAL_AGENT_CODEX_BIN: process.env["AC_EXTERNAL_AGENT_CODEX_BIN"],
        AC_EXTERNAL_AGENT_GEMINI_BIN: process.env["AC_EXTERNAL_AGENT_GEMINI_BIN"],
        AC_EXTERNAL_AGENT_OPENCODE_BIN: process.env["AC_EXTERNAL_AGENT_OPENCODE_BIN"],
    };
    try {
        process.env["KODIZM_MCP_TOKEN"] = "secret-token";
        process.env["KODIZM_MCP_URL"] = "https://kodizm.example";
        process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] = "node";
        process.env["AC_EXTERNAL_AGENT_GEMINI_BIN"] = "node";
        process.env["AC_EXTERNAL_AGENT_OPENCODE_BIN"] = "node";

        const result = await runExternalAgent(
            { cli: "codex", prompt: "ignored", directory: "/tmp" },
            { spawnImpl: fakeBinSpawn(script) },
        );
        const text = result.content[0]?.text ?? "";
        // The truncation marker may prepend on long output; strip it if present.
        const jsonStart = text.indexOf("{");
        expect(jsonStart).toBeGreaterThanOrEqual(0);
        const parsedEnv = JSON.parse(text.slice(jsonStart)) as Record<string, string>;

        expect(parsedEnv["KODIZM_MCP_TOKEN"]).toBeUndefined();
        expect(parsedEnv["KODIZM_MCP_URL"]).toBeUndefined();
        expect(parsedEnv["AC_EXTERNAL_AGENT_CODEX_BIN"]).toBeUndefined();
        expect(parsedEnv["AC_EXTERNAL_AGENT_GEMINI_BIN"]).toBeUndefined();
        expect(parsedEnv["AC_EXTERNAL_AGENT_OPENCODE_BIN"]).toBeUndefined();
        expect(typeof parsedEnv["PATH"]).toBe("string");
        expect((parsedEnv["PATH"] ?? "").length).toBeGreaterThan(0);
    } finally {
        for (const [k, v] of Object.entries(originals)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test("runExternalAgent truncates stdout > 64KB with single-byte tail", async () => {
    const script = `process.stdout.write("a".repeat(70000));`;
    const result = await runExternalAgent(
        { cli: "codex", prompt: "ignored", directory: "/tmp" },
        { spawnImpl: fakeBinSpawn(script) },
    );
    const text = result.content[0]?.text ?? "";
    const marker = "[truncated 4464 bytes from head]\n";
    expect(text.startsWith(marker)).toBe(true);
    expect(text.length - marker.length).toBe(65536);
    expect(text.endsWith("a".repeat(100))).toBe(true);
});

test("runExternalAgent UTF-8-safe truncation: walks past continuation bytes at tail start", async () => {
    const script = `process.stdout.write(Buffer.concat([Buffer.alloc(4, 0x00), Buffer.from([0x80, 0x80]), Buffer.alloc(65534, 0x61)]));`;
    const result = await runExternalAgent(
        { cli: "codex", prompt: "ignored", directory: "/tmp" },
        { spawnImpl: fakeBinSpawn(script) },
    );
    const text = result.content[0]?.text ?? "";
    const expected = "[truncated 4 bytes from head]\n" + "a".repeat(65534);
    expect(text).toBe(expected);
});

test("runExternalAgent surfaces ENOENT as InternalError naming the cli and the env override", async () => {
    let thrown: unknown;
    try {
        await runExternalAgent({
            cli: "codex",
            prompt: "ping",
            directory: "/tmp",
        }, {
            spawnImpl: ((_bin: string, _args: readonly string[] | undefined, options: object) => {
                return realSpawn("__definitely_not_a_real_bin_for_ac_test__", [], options as Parameters<typeof realSpawn>[2]);
            }) as typeof realSpawn,
        });
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain("binary not found");
    expect((thrown as McpError).message).toContain("codex");
});

// Live integration tests (opt-in via AC_EXTERNAL_AGENT_LIVE=1).

test.skipIf(process.env["AC_EXTERNAL_AGENT_LIVE"] !== "1")("live: codex responds to a trivial prompt", async () => {
    const result = await runExternalAgent({
        cli: "codex",
        prompt: "say hello",
        directory: process.cwd(),
        timeout_seconds: 60,
    });
    expect((result.content[0]?.text ?? "").length).toBeGreaterThan(0);
}, 70000);

test.skipIf(process.env["AC_EXTERNAL_AGENT_LIVE"] !== "1")("live: gemini responds to a trivial prompt", async () => {
    const result = await runExternalAgent({
        cli: "gemini",
        prompt: "say hello",
        directory: process.cwd(),
        timeout_seconds: 60,
    });
    expect((result.content[0]?.text ?? "").length).toBeGreaterThan(0);
}, 70000);

test.skipIf(process.env["AC_EXTERNAL_AGENT_LIVE"] !== "1")("live: opencode responds to a trivial prompt", async () => {
    const result = await runExternalAgent({
        cli: "opencode",
        prompt: "say hello",
        directory: process.cwd(),
        timeout_seconds: 60,
    });
    expect((result.content[0]?.text ?? "").length).toBeGreaterThan(0);
}, 70000);
