import { expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildArgv, validateInputs } from "./external-agent.ts";

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
    const result = validateInputs({ cli: "codex", prompt: "hi", directory: "/Users/anilcan" });
    expect(result).toEqual({
        cli: "codex",
        prompt: "hi",
        directory: "/Users/anilcan",
        model: undefined,
        timeoutSeconds: 600,
    });
});

test("validateInputs happy path with model and timeout", () => {
    const result = validateInputs({ cli: "gemini", prompt: "hi", directory: "/Users/anilcan", model: "pro", timeout_seconds: 120 });
    expect(result).toEqual({
        cli: "gemini",
        prompt: "hi",
        directory: "/Users/anilcan",
        model: "pro",
        timeoutSeconds: 120,
    });
});

// validateInputs — rejection cases

test("validateInputs rejects missing cli", () => {
    expect(() => validateInputs({ prompt: "hi", directory: "/Users/anilcan" })).toThrow(McpError);
    try {
        validateInputs({ prompt: "hi", directory: "/Users/anilcan" });
    } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(-32602);
    }
});

test("validateInputs rejects invalid cli", () => {
    expect(() => validateInputs({ cli: "claude", prompt: "hi", directory: "/Users/anilcan" })).toThrow(McpError);
});

test("validateInputs rejects empty prompt", () => {
    expect(() => validateInputs({ cli: "codex", prompt: "  ", directory: "/Users/anilcan" })).toThrow(McpError);
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
    const low = validateInputs({ cli: "codex", prompt: "hi", directory: "/Users/anilcan", timeout_seconds: 5 });
    expect(low.timeoutSeconds).toBe(10);

    const high = validateInputs({ cli: "codex", prompt: "hi", directory: "/Users/anilcan", timeout_seconds: 10000 });
    expect(high.timeoutSeconds).toBe(3600);
});
