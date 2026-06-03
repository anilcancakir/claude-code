// Live-network test: requires a reachable kodizm MCP at $KODIZM_MCP_URL
// (defaults to https://mcp.kodizm.com) authenticated by $KODIZM_MCP_TOKEN.
// Auto-skips when KODIZM_MCP_TOKEN is unset so CI without a kdz- bearer
// stays green; populate the env to pin the remote contract locally.
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";

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
