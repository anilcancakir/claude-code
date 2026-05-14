// Live-network test: requires reachable https://ai-api.kodizm.com/mcp/public. Runs live by default; set KODIZM_MCP_LIVE=0 to opt out (e.g. in CI without egress).
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const CLI_DIR = path.resolve(import.meta.dir, "..");

const EXPECTED_TOOLS = new Set(["web-search", "web-fetch", "search-docs", "resolve-library", "web-code-search"]);

test.skipIf(process.env["KODIZM_MCP_LIVE"] === "0")("mcp proxy exposes the 5-tool surface", async () => {
    const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", "src/index.ts", "mcp"],
        cwd: CLI_DIR,
    });

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);

    const { tools } = await client.listTools();

    const actualNames = new Set(tools.map((t) => t.name));

    for (const name of EXPECTED_TOOLS) {
        expect(actualNames.has(name)).toBe(true);
    }

    await client.close();
}, 30_000);

test("mcp proxy lists call-external-agent with the locked input schema", async () => {
    const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", "src/index.ts", "mcp"],
        cwd: CLI_DIR,
    });

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} }
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
