// Live-network test: requires a reachable kodizm MCP at $KODIZM_MCP_URL
// (defaults to https://mcp.kodizm.com) authenticated by $KODIZM_MCP_TOKEN.
// Auto-skips when KODIZM_MCP_TOKEN is unset so CI without a kdz- bearer
// stays green; populate the env to pin the remote contract locally.
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("toIsErrorResult adds the wait-and-retry instruction only to a transient failure", () => {
    const outage = toIsErrorResult(new StreamableHTTPError(503, "Error POSTing to endpoint: Service Unavailable."));
    const rejected = toIsErrorResult(new StreamableHTTPError(403, "Error POSTing to endpoint: Forbidden"));
    const plain = toIsErrorResult(new Error("upstream 429"));

    expect(joinText(outage.content)).toContain("retry this exact call once after about 60 seconds");
    expect(joinText(rejected.content)).not.toContain("60 seconds");
    expect(joinText(plain.content)).toBe("remote tool call failed: upstream 429");
});

test("SERVER_INSTRUCTIONS is non-empty and under the 2KB truncation bound", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
});

// Frozen copy of the Claude Code instructions: the default client's output must stay byte-identical.
const CLAUDE_CODE_INSTRUCTIONS_SNAPSHOT =
    "For a library or framework question call resolve-library, then search-docs, before any web "
    + "search; for real usage of an API call web-code-search. web-search is the fallback after the "
    + "built-in WebSearch. web-fetch returns exact page text; otherwise it is the last fetch fallback, "
    + "after the built-in WebFetch and any local fetch server. GitHub files, issues and pull requests "
    + "go through gh when it is installed. For the user's own past work or conversations, call "
    + "search-history instead of guessing.";

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

test("buildCatalogue passes kodizm's image tool through with the proxy's own text and no alwaysLoad", () => {
    const tools = buildCatalogue([...REMOTE_SURFACE, makeTool("generate_image")], "claude-code");
    const image = tools.find((tool) => tool.name === "generate_image");

    expect(image).toBeDefined();
    expect(image?.description).toContain("Gemini");
    expect(image?.description).toContain("ac:prompt-writer");
    expect(image?._meta).toBeUndefined();
    expect(tools.at(-1)?.name).toBe("search-history");
});

test("buildCatalogue offers a local reference path where the remote takes inline base64, and hides the base64", () => {
    const remoteImage: Tool = {
        ...makeTool("generate_image"),
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string" },
                reference_image_url: { type: "string" },
                reference_image_base64: { type: "string" },
            },
        },
    };
    const tools = buildCatalogue([...REMOTE_SURFACE, remoteImage], "claude-code");
    const image = tools.find((tool) => tool.name === "generate_image");
    const properties = image?.inputSchema.properties as Record<string, { description?: string }>;

    expect(Object.keys(properties)).toEqual(["prompt", "reference_image_url", "reference_image_path"]);
    expect(properties["reference_image_url"]?.description).toContain("image_url a previous call returned");
    expect(image?.description).toContain("reference_image_path");
});

test("buildCatalogue describes the image bridge options and explains chat_id only when the remote takes it", () => {
    const remoteImage: Tool = {
        ...makeTool("generate_image"),
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string" },
                model: { type: "string", enum: ["hydrogen", "neon"] },
                thinking: { type: "string", enum: ["low", "medium", "high"] },
                chat_id: { type: "string", maxLength: 64 },
                aspect_ratio: { type: "string" },
                style: { type: "string" },
                size: { type: "string" },
            },
        },
    };

    for (const client of ["claude-code", "opencode"] as const) {
        const image = buildCatalogue([...REMOTE_SURFACE, remoteImage], client)
            .find((tool) => tool.name === "generate_image");
        const properties = image?.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;

        expect(image?.description).toContain("same chat_id");
        expect(properties["model"]?.enum).toEqual(["hydrogen", "neon"]);
        expect(properties["model"]?.description).toContain("Defaults to neon");
        expect(properties["thinking"]?.description).toContain("low, medium or high");
        expect(properties["chat_id"]?.description).toContain("1 to 64");
        expect(properties["aspect_ratio"]?.description).toContain("16:9");
        expect(properties["style"]?.description).toContain("cinematic");
        expect(properties["size"]?.description).toContain("aspect_ratio wins");
    }

    const plain = buildCatalogue([...REMOTE_SURFACE, makeTool("generate_image")], "claude-code")
        .find((tool) => tool.name === "generate_image");
    expect(plain?.description).not.toContain("chat_id");
});

test("buildCatalogue (opencode client) keeps the image description but drops the Claude Code skill pointer", () => {
    const tools = buildCatalogue([...REMOTE_SURFACE, makeTool("generate_image")], "opencode");
    const image = tools.find((tool) => tool.name === "generate_image");

    expect(image?.description).toContain("Gemini");
    expect(image?.description).toContain("once per image");
    expect(image?.description).not.toContain("prompt-writer");
});

test("buildCatalogue passes kodizm's video, music and collection tools through with the proxy's own text", () => {
    const remote = ["generate_video", "generate_music", "media_result"].map((name) => makeTool(name));

    for (const client of ["claude-code", "opencode"] as const) {
        const tools = buildCatalogue([...REMOTE_SURFACE, ...remote], client);
        const byName = new Map(tools.map((tool) => [tool.name, tool]));

        expect(byName.get("generate_video")?.description).toContain("save it to a local file");
        expect(byName.get("generate_music")?.description).toContain("save it to a local file");
        expect(byName.get("media_result")?.description).toContain("never generates");
        // The proxy waits on the handle itself, so the model is never told to poll.
        for (const name of ["generate_video", "generate_music"]) {
            expect(byName.get(name)?.description).not.toMatch(/poll/i);
            expect(byName.get(name)?._meta).toBeUndefined();
            // opencode does not ship the skill the Claude Code text points at.
            expect(byName.get(name)?.description?.includes("ac:prompt-writer")).toBe(client === "claude-code");
        }
        expect(tools.at(-1)?.name).toBe("search-history");
    }
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
    // search-history ingests the history root before it answers; an empty CLAUDE_CONFIG_DIR keeps the
    // call off the developer's real ~/.claude/projects, whose size would otherwise set the test's runtime.
    const configDir = mkdtempSync(path.join(tmpdir(), "ac-mcp-history-"));
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env)
                .filter((e): e is [string, string] => e[1] !== undefined)
                .filter(([k]) => k !== "KODIZM_MCP_TOKEN"),
        ),
        CLAUDE_CONFIG_DIR: configDir,
    };

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
        rmSync(configDir, { recursive: true, force: true });
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

test("mcp proxy retries a remote outage, then tells the model to wait and retry once", async () => {
    // A remote that answers every request with the 503 body seen during a kodizm deploy. The proxy must
    // retry the transient failure before giving up (three POSTs, not one), and the final isError text must
    // carry the wait-and-retry instruction rather than only the raw transport message.
    let posts = 0;
    const outage = Bun.serve({
        port: 0,
        fetch() {
            posts++;

            return Response.json({ message: "Service Unavailable." }, { status: 503 });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-outage";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${outage.port}/mcp`;

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

        const text = result.content?.[0]?.text ?? "";

        expect(result.isError).toBe(true);
        expect(text).toContain("remote tool call failed");
        expect(text).toContain("Service Unavailable");
        expect(text).toContain("retry this exact call once after about 60 seconds");
        expect(posts).toBeGreaterThanOrEqual(3);
    } finally {
        await client.close();
        await outage.stop(true);
    }
}, 30_000);

test("mcp proxy does not retry an image generation call against a failing remote", async () => {
    // A generation draws on a shared quota, so unlike the read tools it is attempted once: the same
    // 503 remote that makes resolve-library retry (three POSTs) must see exactly one POST here.
    let posts = 0;
    const outage = Bun.serve({
        port: 0,
        fetch() {
            posts++;

            return Response.json({ message: "Service Unavailable." }, { status: 503 });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-outage";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${outage.port}/mcp`;

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
                name: "generate_image",
                arguments: { prompt: "a lighthouse at dusk" },
            },
        ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

        const text = result.content?.[0]?.text ?? "";

        expect(result.isError).toBe(true);
        expect(text).toContain("remote tool call failed");
        expect(text).toContain("may already have been generated");
        // The generic outage hint tells the model to repeat the exact call, which would draw a second picture.
        expect(text).not.toContain("retry this exact call");
        expect(posts).toBe(1);
    } finally {
        await client.close();
        await outage.stop(true);
    }
}, 30_000);

test("mcp proxy turns kodizm's image link into a saved file and an inline picture", async () => {
    // A hand-rolled streamable-HTTP remote: initialize, the initialized notification and one tools/call that
    // answers the way kodizm's custom Tool does (text JSON carrying a signed link), plus the link itself.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === "/picture.png") {
                return new Response(png, { headers: { "content-type": "image/png" } });
            }
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/call") {
                const answer = {
                    path: "web",
                    status: "succeeded",
                    output: { image_url: new URL("/picture.png", request.url).href, image_mime: "image/png" },
                };

                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
                });
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-image";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

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

    let savedPath: string | undefined;

    try {
        await client.connect(transport);

        const result = await client.callTool(
            {
                name: "generate_image",
                arguments: { prompt: "a lighthouse at dusk" },
            },
        ) as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

        expect(result.isError).toBeUndefined();
        expect(result.content?.[1]).toEqual({
            type: "image",
            data: Buffer.from(png).toString("base64"),
            mimeType: "image/png",
        });

        savedPath = /saved to (\S+) \(/.exec(result.content?.[0]?.text ?? "")?.[1];
        expect(savedPath).toBeDefined();
        expect(existsSync(savedPath ?? "")).toBe(true);
    } finally {
        await client.close();
        await remote.stop(true);
        if (savedPath !== undefined) {
            rmSync(savedPath, { force: true });
        }
    }
}, 30_000);

test("mcp proxy runs a music render to a saved file: submit, collect through media_result, download", async () => {
    // A hand-rolled streamable-HTTP remote answering the way kodizm's Tools do: generate_music queues and answers
    // prose with a handle line, media_result answers JSON with a signed link, and the link serves the track.
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 7, 7]);
    const calls: Array<[string, unknown]> = [];
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === "/track.mp3") {
                return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
            }
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/call") {
                const name = message.params["name"] as string;
                calls.push([name, message.params["arguments"]]);
                const text = name === "generate_music"
                    ? "The track is now generating in the background.\n\nhandle: 0b7e-42\n\nCall `google.media_result`."
                    : JSON.stringify({
                        status: "done",
                        handle: "0b7e-42",
                        url: new URL("/track.mp3", request.url).href,
                        mime: "audio/mpeg",
                        bytes: mp3.length,
                    });

                return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-music";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    let savedPath: string | undefined;

    try {
        await client.connect(new StdioClientTransport({
            command: "bun",
            args: [
                "run",
                "src/index.ts",
                "mcp",
            ],
            cwd: CLI_DIR,
            env,
        }));

        const result = await client.callTool({
            name: "generate_music",
            arguments: { prompt: "a jazz loop", vocals: "instrumental" },
        }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

        expect(result.isError).toBeUndefined();
        expect(calls).toEqual([
            ["generate_music", { prompt: "a jazz loop", vocals: "instrumental" }],
            ["media_result", { handle: "0b7e-42" }],
        ]);

        savedPath = /saved to (\S+) \(/.exec(result.content?.[0]?.text ?? "")?.[1];
        expect(savedPath?.endsWith(".mp3")).toBe(true);
        expect(new Uint8Array(readFileSync(savedPath ?? ""))).toEqual(mp3);
    } finally {
        await client.close();
        await remote.stop(true);
        if (savedPath !== undefined) {
            rmSync(savedPath, { force: true });
        }
    }
}, 30_000);

test("mcp proxy collects a queued picture through media_result and presents it like an inline one", async () => {
    // kodizm with GEMINI_WEB_IMAGE_QUEUE on: generate_image answers prose with a handle line, media_result answers the
    // finished picture's signed link with marks_removed, and the link serves the PNG.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2]);
    const calls: Array<[string, unknown]> = [];
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === "/picture.png") {
                return new Response(png, { headers: { "content-type": "image/png" } });
            }
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/call") {
                const name = message.params["name"] as string;
                calls.push([name, message.params["arguments"]]);
                const text = name === "generate_image"
                    ? "The picture is now generating in the background.\n\nhandle: 5c2a-9\n\nCall `google.media_result`."
                    : JSON.stringify({
                        status: "done",
                        handle: "5c2a-9",
                        url: new URL("/picture.png", request.url).href,
                        mime: "image/png",
                        bytes: png.length,
                        marks_removed: false,
                    });

                return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-queued-image";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );

    let savedPath: string | undefined;

    try {
        await client.connect(new StdioClientTransport({
            command: "bun",
            args: [
                "run",
                "src/index.ts",
                "mcp",
            ],
            cwd: CLI_DIR,
            env,
        }));

        const result = await client.callTool({
            name: "generate_image",
            arguments: { prompt: "a red paper boat" },
        }) as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string }> };

        expect(result.isError).toBeUndefined();
        expect(calls).toEqual([
            ["generate_image", { prompt: "a red paper boat" }],
            ["media_result", { handle: "5c2a-9" }],
        ]);

        const saved = result.content?.[0]?.text ?? "";
        savedPath = /saved to (\S+) \(/.exec(saved)?.[1];
        expect(savedPath?.endsWith(".png")).toBe(true);
        expect(saved).toContain("watermark could not be removed");
        expect(result.content?.[1]?.type).toBe("image");
        expect(result.content?.[1]?.data).toBe(Buffer.from(png).toString("base64"));

        // A handle the model collects itself, after a wait ran out, is presented the same way.
        const collected = await client.callTool({
            name: "media_result",
            arguments: { handle: "5c2a-9" },
        }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

        expect(collected.isError).toBeUndefined();
        expect(collected.content?.[1]?.type).toBe("image");
        rmSync(/saved to (\S+) \(/.exec(collected.content?.[0]?.text ?? "")?.[1] ?? "", { force: true });
    } finally {
        await client.close();
        await remote.stop(true);
        if (savedPath !== undefined) {
            rmSync(savedPath, { force: true });
        }
    }
}, 30_000);

test("mcp proxy sends model neon when a call names none and refuses a chat turn that repeats its picture", async () => {
    // The fake remote declares model and chat_id, records what each tools/call carried and always answers the same
    // picture, the way the bridge hands back an earlier picture on a turn Gemini answered with text.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]);
    const calls: Array<Record<string, unknown>> = [];
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === "/picture.png") {
                return new Response(png, { headers: { "content-type": "image/png" } });
            }
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/list") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        tools: [{
                            name: "generate_image",
                            description: "remote text",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    prompt: { type: "string" },
                                    model: { type: "string", enum: ["hydrogen", "neon"] },
                                    chat_id: { type: "string" },
                                },
                            },
                        }],
                    },
                });
            }
            if (message.method === "tools/call") {
                calls.push(message.params["arguments"] as Record<string, unknown>);
                const answer = {
                    path: "web",
                    status: "succeeded",
                    output: { image_url: new URL("/picture.png", request.url).href },
                };

                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
                });
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-chat";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

    const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
    );
    const saved: string[] = [];

    try {
        await client.connect(new StdioClientTransport({
            command: "bun",
            args: [
                "run",
                "src/index.ts",
                "mcp",
            ],
            cwd: CLI_DIR,
            env,
        }));
        await client.listTools();

        type Answer = { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        const call = async (args: Record<string, unknown>): Promise<Answer> => {
            const result = await client.callTool({ name: "generate_image", arguments: args }) as Answer;
            const file = /saved to (\S+) \(/.exec(result.content?.[0]?.text ?? "")?.[1];
            if (file !== undefined) {
                saved.push(file);
            }

            return result;
        };

        const first = await call({ prompt: "a boat", chat_id: "boat" });
        const repeat = await call({ prompt: "make it red", chat_id: "boat" });
        const explicit = await call({ prompt: "a boat", model: "hydrogen" });

        expect(first.isError).toBeUndefined();
        expect(repeat.isError).toBe(true);
        expect(repeat.content?.[0]?.text).toContain("earlier picture");
        expect(explicit.isError).toBeUndefined();
        expect(calls).toEqual([
            { prompt: "a boat", chat_id: "boat", model: "neon" },
            { prompt: "make it red", chat_id: "boat", model: "neon" },
            { prompt: "a boat", model: "hydrogen" },
        ]);
    } finally {
        await client.close();
        await remote.stop(true);
        for (const file of saved) {
            rmSync(file, { force: true });
        }
    }
}, 30_000);

test("mcp proxy inlines a local reference file for the remote and refuses a bad path without calling it", async () => {
    // The fake remote records every tools/call so the test sees what the proxy actually sent.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const calls: Array<Record<string, unknown>> = [];
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/list") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        tools: [{
                            name: "generate_image",
                            description: "remote text",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    prompt: { type: "string" },
                                    reference_image_url: { type: "string" },
                                    reference_image_base64: { type: "string" },
                                },
                            },
                        }],
                    },
                });
            }
            if (message.method === "tools/call") {
                calls.push(message.params["arguments"] as Record<string, unknown>);

                // No image_url in the answer: the proxy passes a link-less answer through untouched.
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { content: [{ type: "text", text: "refused by the fake" }], isError: true },
                });
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const directory = mkdtempSync(path.join(tmpdir(), "ac-reference-e2e-"));
    const picture = path.join(directory, "ref.png");
    const notes = path.join(directory, "notes.png");
    writeFileSync(picture, png);
    writeFileSync(notes, "not a picture");

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-reference";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

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

        await client.callTool({
            name: "generate_image",
            arguments: { prompt: "make it green", reference_image_path: picture, reference_image_base64: "model-wrote-this" },
        });

        const refused = await client.callTool({
            name: "generate_image",
            arguments: { prompt: "make it green", reference_image_path: notes },
        }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

        expect(calls).toEqual([
            { prompt: "make it green", reference_image_base64: Buffer.from(png).toString("base64") },
        ]);
        expect(refused.isError).toBe(true);
        expect(refused.content?.[0]?.text).toContain("not a PNG, JPEG or WebP picture");
        expect(refused.content?.[0]?.text).toContain("Nothing was sent");
        expect(calls).toHaveLength(1);
    } finally {
        await client.close();
        await remote.stop(true);
        rmSync(directory, { recursive: true, force: true });
    }
}, 30_000);

test("mcp proxy refuses a reference when the remote's image tool does not declare one, and never calls it", async () => {
    // A remote that predates the reference parameter would drop it and draw a fresh picture that looks like an edit.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    let generations = 0;
    const remote = Bun.serve({
        port: 0,
        async fetch(request) {
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }

            const message = await request.json() as { id?: number; method: string; params: Record<string, unknown> };
            if (message.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            if (message.method === "initialize") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params["protocolVersion"],
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-kodizm", version: "0.0.0" },
                    },
                });
            }
            if (message.method === "tools/list") {
                return Response.json({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        tools: [{
                            name: "generate_image",
                            description: "remote text",
                            inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
                        }],
                    },
                });
            }
            if (message.method === "tools/call") {
                generations++;
            }

            return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        },
    });

    const directory = mkdtempSync(path.join(tmpdir(), "ac-reference-old-remote-"));
    const picture = path.join(directory, "ref.png");
    writeFileSync(picture, png);

    const env = Object.fromEntries(
        Object.entries(process.env)
            .filter((e): e is [string, string] => e[1] !== undefined)
            .filter(([k]) => k !== "KODIZM_MCP_TOKEN" && k !== "KODIZM_MCP_URL"),
    );
    env["KODIZM_MCP_TOKEN"] = "kdz-dummy-old-remote";
    env["KODIZM_MCP_URL"] = `http://127.0.0.1:${remote.port}/mcp`;

    const transport = new StdioClientTransport({ command: "bun", args: ["run", "src/index.ts", "mcp"], cwd: CLI_DIR, env });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    try {
        await client.connect(transport);

        const listed = await client.listTools();
        const image = listed.tools.find((tool) => tool.name === "generate_image");

        expect(Object.keys(image?.inputSchema.properties ?? {})).toEqual(["prompt"]);
        expect(image?.description).not.toContain("reference_image_path");

        for (const args of [{ prompt: "x", reference_image_path: picture }, { prompt: "x", reference_image_url: "https://k.test/a.png" }]) {
            const refused = await client.callTool({ name: "generate_image", arguments: args }) as {
                isError?: boolean;
                content?: Array<{ type: string; text?: string }>;
            };

            expect(refused.isError).toBe(true);
            expect(refused.content?.[0]?.text).toContain("does not take a reference picture yet");
            expect(refused.content?.[0]?.text).toContain("Nothing was sent");
        }

        expect(generations).toBe(0);
    } finally {
        await client.close();
        await remote.stop(true);
        rmSync(directory, { recursive: true, force: true });
    }
}, 30_000);

test("mcp proxy lists its local tools when the remote is unreachable instead of failing tools/list", async () => {
    // opencode marks an MCP server failed when its first tools/list throws and never asks again, so a
    // network blip at startup used to leave the whole server (search-history included) unusable.
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

        expect(tools.map((tool) => tool.name).sort()).toEqual([
            "search-history",
            "web-fetch",
        ]);
    } finally {
        await client.close();
    }
}, 30_000);
