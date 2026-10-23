// Live-network test: requires a reachable kodizm MCP at $KODIZM_MCP_URL
// (defaults to https://mcp.kodizm.com) authenticated by $KODIZM_MCP_TOKEN.
// Auto-skips when KODIZM_MCP_TOKEN is unset so CI without a kdz- bearer
// stays green; populate the env to pin the remote contract locally.
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { LOCAL_WEB_FETCH_TOOL_DEFINITION } from "./local-fetch.ts";
import {
    applyAlwaysLoad,
    applyRemoteText,
    buildCatalogue,
    OPENCODE_SERVER_INSTRUCTIONS,
    SERVER_INSTRUCTIONS,
    toIsErrorResult,
} from "./mcp.ts";

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

test("applyAlwaysLoad merges anthropic/alwaysLoad for the docs tools and search-history", () => {
    for (const name of ["search-docs", "resolve-library", "web-code-search", "search-history"]) {
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

test("applyRemoteText replaces the description and known parameter texts, keeping the schema shape", () => {
    const input: Tool = {
        name: "search-docs",
        description: "remote text that names web-fetch-result",
        inputSchema: {
            type: "object",
            properties: {
                library_id: { type: "string", description: "remote id text" },
                extra: { type: "string", description: "remote extra text" },
            },
            required: ["library_id"],
        },
    };
    const out = applyRemoteText(input);
    const props = out.inputSchema.properties as Record<string, { type: string; description: string }>;

    expect(out.description).not.toContain("web-fetch-result");
    expect(out.description).toContain("resolve-library");
    expect(props["library_id"]?.description).toContain("resolve-library");
    expect(props["library_id"]?.type).toBe("string");
    expect(props["extra"]?.description).toBe("remote extra text");
    expect(out.inputSchema.required).toEqual(["library_id"]);
    expect(input.description).toBe("remote text that names web-fetch-result");
});

test("applyRemoteText marks web-fetch and web-search as fallbacks and leaves unknown tools alone", () => {
    for (const name of ["web-fetch", "web-search"]) {
        expect(applyRemoteText(makeTool(name)).description).toContain("Fallback for the built-in");
    }
    const other = makeTool("something-else");
    expect(applyRemoteText(other)).toBe(other);
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

// Frozen copy of the Claude Code instructions: the default client's output must stay byte-identical.
const CLAUDE_CODE_INSTRUCTIONS_SNAPSHOT =
    "For library docs call resolve-library, then search-docs; for real usage of an API call "
    + "web-code-search. web-fetch and web-search are fallbacks for the built-in WebFetch and "
    + "WebSearch. For the user's own past work or conversations, call search-history instead of "
    + "guessing.";

test("default SERVER_INSTRUCTIONS stays byte-identical for Claude Code", () => {
    expect(SERVER_INSTRUCTIONS).toBe(CLAUDE_CODE_INSTRUCTIONS_SNAPSHOT);
});

test("OPENCODE_SERVER_INSTRUCTIONS names the ac tools and no Claude Code built-in", () => {
    expect(OPENCODE_SERVER_INSTRUCTIONS).toBe(
        "For library docs call resolve-library, then search-docs; for real usage of an API call "
        + "web-code-search; web-search and web-fetch are the web tools. For the user's own past work or "
        + "Claude Code conversations, call search-history instead of guessing.",
    );
    for (const forbidden of ["WebFetch", "WebSearch", "built-in"]) {
        expect(OPENCODE_SERVER_INSTRUCTIONS).not.toContain(forbidden);
    }
});

const REMOTE_SURFACE = ["web-search", "web-fetch", "search-docs", "resolve-library", "web-code-search", "extra"]
    .map((name) => makeTool(name));

test("buildCatalogue (default client, bearer branch) keeps the history tool last with alwaysLoad", () => {
    const names = buildCatalogue(REMOTE_SURFACE, "claude-code").map((t) => t.name);
    expect(names).toEqual(["web-search", "web-fetch", "search-docs", "resolve-library", "web-code-search", "search-history"]);
    const history = buildCatalogue(REMOTE_SURFACE, "claude-code").at(-1);
    expect(history?._meta?.["anthropic/alwaysLoad"]).toBe(true);
});

test("buildCatalogue (default client, token-less branch) serves web-fetch and search-history", () => {
    const names = buildCatalogue(null, "claude-code").map((t) => t.name);
    expect(names).toEqual(["web-fetch", "search-history"]);
});

test("buildCatalogue (opencode client) lists search-history last, in either branch", () => {
    const withBearer = buildCatalogue(REMOTE_SURFACE, "opencode").map((t) => t.name);
    expect(withBearer).toEqual([
        "web-search",
        "web-fetch",
        "search-docs",
        "resolve-library",
        "web-code-search",
        "search-history",
    ]);
    expect(buildCatalogue(null, "opencode").map((t) => t.name)).toEqual(["web-fetch", "search-history"]);
});

test("buildCatalogue (opencode client) describes the web tools without naming Claude Code built-ins", () => {
    const tools = [...buildCatalogue(REMOTE_SURFACE, "opencode"), ...buildCatalogue(null, "opencode")];
    for (const tool of tools.filter((t) => t.name === "web-fetch" || t.name === "web-search")) {
        expect(tool.description).not.toMatch(/WebFetch|WebSearch|built-in|[Ff]allback/);
    }
    const defaultFetch = buildCatalogue(null, "claude-code").find((t) => t.name === "web-fetch");
    expect(defaultFetch?.description).toBe(LOCAL_WEB_FETCH_TOOL_DEFINITION.description);
});

const CLI_DIR = path.resolve(import.meta.dir, "..");

const EXPECTED_TOOLS = new Set(
    [
        "web-search",
        "web-fetch",
        "search-docs",
        "resolve-library",
        "web-code-search",
        "search-history",
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

test("mcp proxy serves web-fetch and search-history without a bearer token", async () => {
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
        expect(names).toContain("search-history");
        expect(names).toHaveLength(2);

        // The trap this guards against: adding a name to ALWAYS_LOAD_TOOLS is not sufficient on its
        // own, since applyAlwaysLoad's one call site loops over the REMOTE tool list. A local
        // definition appended directly to cachedTools never passes through it unless the append
        // site itself wraps it, so this checks the tool the server actually returned, not the
        // constant this test file imports.
        const historyTool = tools.find((t) => t.name === "search-history");
        expect(historyTool?._meta?.["anthropic/alwaysLoad"]).toBe(true);
    } finally {
        await client.close();
    }
}, 30_000);

test("mcp proxy --client opencode serves search-history with opencode-worded instructions", async () => {
    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN"),
    );

    const transport = new StdioClientTransport(
        {
            command: "bun",
            args: ["run", "src/index.ts", "mcp", "--client", "opencode"],
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
        expect(tools.map((t) => t.name)).toEqual(["web-fetch", "search-history"]);
        expect(client.getInstructions()).toBe(OPENCODE_SERVER_INSTRUCTIONS);

        // Dispatch reaches the history handler; under bun the node:sqlite archive may answer with an
        // isError result, which is still a dispatched call rather than "Unknown tool".
        const result = await client.callTool({ name: "search-history", arguments: { pattern: "x" } });
        expect(JSON.stringify(result.content)).not.toContain("Unknown tool");
    } finally {
        await client.close();
    }
}, 30_000);

test("mcp proxy rejects an unknown --client value", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "mcp", "--client", "emacs"], {
        cwd: CLI_DIR,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("claude-code");
    expect(stderr).toContain("opencode");
}, 30_000);

test("mcp proxy normalizes a remote connection failure to isError, not a thrown McpError", async () => {
    // Bearer-free and deterministic: a dummy token routes resolve-library through the
    // remote passthrough, and an unreachable URL forces the lazy connect to fail. The
    // handler must return isError:true (a readable tool-execution failure), NOT throw a
    // protocol-level McpError. Guards the ensureConnected-inside-try normalization so a
    // remote outage is reported as "lookup failed" rather than crashing the tool call.
    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-unreachable";
    env["KODIZM_MCP_URL"] = "http://127.0.0.1:1/mcp";

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

        const result = await client.callTool(
            {
                name: "resolve-library",
                arguments: { query: "react" },
            },
        ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text ?? "").toContain("remote tool call failed");
    } finally {
        await client.close();
    }
}, 30_000);
