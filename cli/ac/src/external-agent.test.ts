import { expect, test } from "bun:test";
import { buildArgv } from "./external-agent.ts";

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
