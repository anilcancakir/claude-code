// Live-network test: requires a reachable kodizm MCP at $KODIZM_MCP_URL
// (defaults to https://mcp.kodizm.com) authenticated by $KODIZM_MCP_TOKEN.
// Auto-skips when KODIZM_MCP_TOKEN is unset so CI without a kdz- bearer
// stays green; populate the env to pin the remote contract locally.
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { applyAlwaysLoad, SERVER_INSTRUCTIONS, toIsErrorResult } from "./mcp.ts";

// Bearer-free unit coverage for the exported proxy transforms. These do not
// spawn the subprocess and are NOT skipIf-gated, so A2 (alwaysLoad) and A11
// (isError normalization) are exercised in CI without a kdz- bearer.

function makeTool(name: string, meta?: Record<string, unknown>): Tool {
    return {
        name,
        description: `${name} description`,
        inputSchema: { type: "object" },
        ...(meta ? { _meta: meta } : {}),
    };
}

function joinText(content: Array<{ type: string }>): string {
    return content.map((c) => (c as { text?: string }).text ?? "").join("");
}

test("applyAlwaysLoad merges anthropic/alwaysLoad for the three docs tools", () => {
    for (const name of ["search-docs", "resolve-library", "web-code-search"]) {
        const out = applyAlwaysLoad(makeTool(name));
        expect(out._meta?.["anthropic/alwaysLoad"]).toBe(true);
    }
});

test("applyAlwaysLoad leaves web-fetch and web-search untouched", () => {
    for (const name of ["web-fetch", "web-search"]) {
        const input = makeTool(name);
        const out = applyAlwaysLoad(input);
        expect(out).toBe(input);
        expect(out._meta).toBeUndefined();
    }
});

test("applyAlwaysLoad preserves existing _meta (anthropic/searchHint)", () => {
    const input = makeTool("search-docs", { "anthropic/searchHint": "docs" });
    const out = applyAlwaysLoad(input);
    expect(out._meta?.["anthropic/searchHint"]).toBe("docs");
    expect(out._meta?.["anthropic/alwaysLoad"]).toBe(true);
});

test("applyAlwaysLoad does not mutate the input tool", () => {
    const input = makeTool("search-docs");
    applyAlwaysLoad(input);
    expect(input._meta).toBeUndefined();
});

test("toIsErrorResult wraps an Error message in an isError CallToolResult", () => {
    const out = toIsErrorResult(new Error("upstream 429"));
    expect(out.isError).toBe(true);
    expect(joinText(out.content)).toContain("upstream 429");
});

test("toIsErrorResult stringifies a non-Error thrown value", () => {
    const out = toIsErrorResult("boom");
    expect(out.isError).toBe(true);
    expect(joinText(out.content)).toContain("boom");
});

test("SERVER_INSTRUCTIONS is non-empty and under the 2KB truncation bound", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
});

const CLI_DIR = path.resolve(import.meta.dir, "..");

const EXPECTED_TOOLS = new Set(
    [
        "web-search",
        "web-fetch",
        "search-docs",
        "resolve-library",
        "web-code-search",
    ],
);

test.skipIf(!process.env["KODIZM_MCP_TOKEN"])(
    "mcp proxy exposes the kodizm utility surface when a bearer is configured",
    async () => {
        // StdioClientTransport's default inherit list is HOME/PATH/SHELL/...,
        // so KODIZM_MCP_TOKEN + KODIZM_MCP_URL must be forwarded explicitly
        // for the spawned proxy to see them.
        const env = Object.fromEntries(
            Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        );

        const transport = new StdioClientTransport(
            {
                command: "bun",
                args: ["run", "src/index.ts", "mcp"],
                cwd: CLI_DIR,
                env,
            },
        );

        const client = new Client(
            { name: "test-client", version: "0.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);

        const { tools } = await client.listTools();

        const actualNames = new Set(tools.map((t) => t.name));

        for (const name of EXPECTED_TOOLS) {
            expect(actualNames.has(name)).toBe(true);
        }

        await client.close();
    },
    30_000,
);

test("mcp proxy lists call-external-agent with the locked input schema", async () => {
    const transport = new StdioClientTransport(
        {
            command: "bun",
            args: ["run", "src/index.ts", "mcp"],
            cwd: CLI_DIR,
        },
    );

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    await client.connect(transport);

    const { tools } = await client.listTools();

    const entry = tools.find((t) => t.name === "call-external-agent");

    expect(entry).toBeDefined();

    const schema = entry!.inputSchema as {
        required: string[];
        properties: Record<string, unknown>;
    };

    expect(schema.required).toEqual(["cli", "prompt", "directory"]);

    const cliProp = schema.properties["cli"] as { enum: string[] };
    expect(cliProp.enum).toEqual(["codex", "gemini", "opencode"]);

    expect("model" in schema.properties).toBe(true);
    expect("timeout_seconds" in schema.properties).toBe(true);
    expect(schema.required).not.toContain("model");
    expect(schema.required).not.toContain("timeout_seconds");

    await client.close();
}, 30_000);

test("mcp proxy dispatches call-external-agent to runExternalAgent", async () => {
    const prevBin = process.env["AC_EXTERNAL_AGENT_CODEX_BIN"];
    // Point the codex bin at `node` so the dispatch path is exercised without needing a real codex install.
    // `node` will not understand codex flags and will exit non-zero, surfacing an McpError whose message
    // contains "codex" — that is sufficient evidence the dispatch reached runExternalAgent.
    process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] = "node";

    const transport = new StdioClientTransport(
        {
            command: "bun",
            args: ["run", "src/index.ts", "mcp"],
            cwd: CLI_DIR,
            env: Object.fromEntries(
                Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
            ),
        },
    );

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);

        let thrown: unknown;
        try {
            await client.callTool(
                {
                    name: "call-external-agent",
                    arguments: { cli: "codex", prompt: "ping", directory: CLI_DIR },
                },
            );
        } catch (err) {
            thrown = err;
        }

        // The SDK surfaces protocol-level errors as McpError on the client side.
        // Either path proves the dispatcher reached runExternalAgent:
        //   (a) resolves with text content (node somehow exited 0 — unlikely but valid), OR
        //   (b) rejects with McpError whose message mentions "codex".
        if (thrown !== undefined) {
            expect(thrown).toBeInstanceOf(McpError);
            expect((thrown as McpError).message).toContain("codex");
        }
    } finally {
        await client.close();
        if (prevBin === undefined) {
            delete process.env["AC_EXTERNAL_AGENT_CODEX_BIN"];
        } else {
            process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] = prevBin;
        }
    }
}, 30_000);

test("mcp proxy rejects call-external-agent with invalid cli", async () => {
    const transport = new StdioClientTransport(
        {
            command: "bun",
            args: ["run", "src/index.ts", "mcp"],
            cwd: CLI_DIR,
        },
    );

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);

        let thrown: unknown;
        try {
            await client.callTool(
                {
                    name: "call-external-agent",
                    // "claude" is not a valid cli enum value; validateInputs throws McpError(InvalidParams, "cli must be one of ...")
                    arguments: { cli: "claude", prompt: "x", directory: "/tmp" },
                },
            );
        } catch (err) {
            thrown = err;
        }

        // The MCP SDK surfaces InvalidParams as a rejected promise with McpError on the client.
        expect(thrown).toBeInstanceOf(McpError);
        expect((thrown as McpError).message).toContain("cli must be one of");
    } finally {
        await client.close();
    }
}, 30_000);

test("mcp proxy serves web-fetch and call-external-agent without a bearer token", async () => {
    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN"),
    );

    const transport = new StdioClientTransport(
        {
            command: "bun",
            args: ["run", "src/index.ts", "mcp"],
            cwd: CLI_DIR,
            env,
        },
    );

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);

        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);

        expect(names).toContain("web-fetch");
        expect(names).toContain("call-external-agent");
        expect(names).toHaveLength(2);
    } finally {
        await client.close();
    }
}, 30_000);
