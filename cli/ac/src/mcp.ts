import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { HISTORY_TOOL_DEFINITION, HISTORY_TOOL_NAME, runHistoryTool } from "./history-tool.ts";
import { LOCAL_WEB_FETCH_TOOL_DEFINITION, runLocalFetch } from "./local-fetch.ts";
import { raceWebFetch } from "./web-fetch-race.ts";
import { AC_VERSION } from "./version.ts";

/**
 * Default kodizm MCP endpoint.
 *
 * Production points at the subdomain root (`Mcp::web('/', KodizmServer)`
 * on `mcp.kodizm.com`). Local dev typically overrides via `--url` or
 * `KODIZM_MCP_URL` to a path mirror like `http://127.0.0.1:9800/mcp/kodizm`
 * so the same kdz- bearer reaches a workstation FrankenPHP instance.
 */
const DEFAULT_REMOTE_URL = "https://mcp.kodizm.com";

/**
 * Wire names of the kodizm utility surface ac proxies through.
 *
 * Kodizm's `KodizmServer` ships these five tool classes under canonical
 * kebab-case names (see `app/Mcp/Tools/*` with `#[Name(...)]`). The
 * federated `kodizm.*` project surface lives on `/mcp/internal` behind
 * a JWT, never on the public PAT route, so the allowlist below is the
 * complete public catalogue for `/mcp/kodizm`.
 */
const ALLOWED_REMOTE_TOOLS: ReadonlySet<string> = new Set([
    "web-search",
    "web-fetch",
    "search-docs",
    "resolve-library",
    "web-code-search",
]);

/**
 * Model-facing text for the five proxied remote tools, replacing what the remote server ships.
 *
 * The remote descriptions ran about 3,700 characters across the five and named two tools the
 * proxy never exposes (`code-search`, `web-fetch-result`), so the proxy owns this text instead.
 * Written the way Claude Code writes its own tool descriptions: what the tool does in one
 * sentence, one line for the behaviour that differs from what the model expects, and a unit or
 * bound per parameter.
 *
 * web-fetch and web-search stay marked as fallbacks. Claude Code's built-in WebFetch description
 * tells the model to prefer an MCP fetch tool when one is registered, and the tool description is
 * the only text read at the moment of tool selection, including by subagents that omit CLAUDE.md.
 * A parameter override applies only when the remote schema still declares that parameter.
 */
const REMOTE_TOOL_TEXT: Readonly<Record<string, { description: string; params: Readonly<Record<string, string>> }>> = {
    "resolve-library": {
        description: "Map a library or framework name to its documentation id for search-docs. "
            + "Call it first when the id is not already known; returns ranked matches with versions.",
        params: { query: "Library or framework name, e.g. \"laravel\"." },
    },
    "search-docs": {
        description: "Search one library's cached documentation for a topic and return the matching sections. "
            + "Take library_id from resolve-library; append /<version> to pin a version.",
        params: {
            library_id: "Id from resolve-library, optionally suffixed with /<version>.",
            topic: "What to look up in the docs.",
            max_tokens: "Cap on returned content in tokens, default 5000.",
        },
    },
    "web-code-search": {
        description: "Search public GitHub code for real usage of an API or pattern. "
            + "Use it to see how something is actually called, not what it is for.",
        params: {
            query: "Exact string or regex, 2 to 256 characters.",
            language: "Optional language filter, e.g. \"TypeScript\".",
            num_results: "1 to 30, default 10.",
        },
    },
    "web-fetch": {
        description: "Fetch a page and return its content as markdown. Fallback for the built-in WebFetch, "
            + "which you try first: use it when WebFetch errors, times out, is blocked (403/429), returns an empty, auth-walled "
            + "or unrendered page, or cannot follow a cross-host redirect, and when you need the page text "
            + "itself rather than a summary.",
        params: { url: "Absolute URL including https://." },
    },
    "web-search": {
        description: "Search the web across several engines and return deduplicated results. Fallback for the "
            + "built-in WebSearch: use it when WebSearch errors, is unavailable or rate-limited, or returns too little.",
        params: {
            query: "Search terms, 2 to 500 characters.",
            num_results: "3 to 20, default 10.",
        },
    },
};

/**
 * Replace a proxied tool's description and known parameter descriptions with `REMOTE_TOOL_TEXT`,
 * leaving the schema's shape and any parameter the table does not name untouched.
 */
export function applyRemoteText(tool: Tool): Tool {
    const text = REMOTE_TOOL_TEXT[tool.name];
    if (text === undefined) {
        return tool;
    }
    const schema = tool.inputSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties === undefined) {
        return { ...tool, description: text.description };
    }
    const nextProperties: Record<string, Record<string, unknown>> = {};
    for (const [name, property] of Object.entries(properties)) {
        const override = text.params[name];
        nextProperties[name] = override === undefined ? property : { ...property, description: override };
    }
    return { ...tool, description: text.description, inputSchema: { ...schema, properties: nextProperties } };
}

/**
 * Primary docs/OSS-research tools, plus the local history search tool, that Claude Code should
 * keep resident rather than defer behind tool-search.
 *
 * None of these four has a built-in equivalent, so marking them `alwaysLoad` loads them at
 * session start (CC reads the connected server's tools/list with no provenance tracking, so the
 * per-tool `_meta` flag is honored on proxied AND local tools). web-fetch and web-search are
 * deliberately excluded: they stay fallback-only, and marking them alwaysLoad would force them
 * resident against the built-in web tools.
 *
 * The fourth entry is written as the literal `"search-history"` rather than the imported
 * `HISTORY_TOOL_NAME`, deliberately: this Set is built at module-evaluation time, and mcp.ts and
 * history-tool.ts import from each other (this file for `toIsErrorResult`, that one for its tool
 * definition and handler). Dereferencing an imported `const` at the top level of either side of a
 * cycle can hit the binding before the other module has finished initializing it, depending on
 * which module a given entry point loads first; measured with plain Node (not just bun test,
 * which tolerated it) via `node --experimental-strip-types`, entering through history-tool.ts
 * threw `ReferenceError: Cannot access 'HISTORY_TOOL_NAME' before initialization` right here.
 * Every OTHER reference to `HISTORY_TOOL_NAME` in this file lives inside a request-handler
 * callback, which only runs once both modules have long finished evaluating, so only this one
 * eager top-level read needed the literal.
 */
const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
    "search-docs",
    "resolve-library",
    "web-code-search",
    "search-history",
]);

/**
 * Merge the `anthropic/alwaysLoad` directive into a docs tool's `_meta`,
 * preserving any upstream `_meta` (e.g. `anthropic/searchHint`) and leaving
 * every other proxied tool untouched.
 */
export function applyAlwaysLoad(tool: Tool): Tool {
    if (!ALWAYS_LOAD_TOOLS.has(tool.name)) {
        return tool;
    }
    return {
        ...tool,
        _meta: {
            ...tool._meta,
            "anthropic/alwaysLoad": true,
        },
    };
}

/**
 * Normalize a remote-passthrough failure into an `isError` tool result.
 *
 * A remote network/rate-limit/upstream failure is a tool-execution failure,
 * distinct from a dispatch error (unknown tool, missing bearer) which stays an
 * McpError. Mirrors the web-fetch-race error->result shape so the model sees a
 * readable failure instead of a protocol-level rejection.
 */
export function toIsErrorResult(err: unknown): CallToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return {
        isError: true,
        content: [{ type: "text", text: `remote tool call failed: ${message}` }],
    };
}

/**
 * Server-level usage guidance loaded at session start regardless of
 * tool-search deferral. Kept under the 2KB truncation bound.
 */
export const SERVER_INSTRUCTIONS =
    "For library docs call resolve-library, then search-docs; for real usage of an API call "
    + "web-code-search. web-fetch and web-search are fallbacks for the built-in WebFetch and "
    + "WebSearch. For the user's own past work or conversations, call search-history instead of "
    + "guessing.";

/**
 * Lazily-connected remote MCP handle.
 *
 * The first listTools / callTool dispatch triggers the upstream
 * connect; subsequent calls reuse the same promise so the SSE
 * channel and pending handshake never race.
 */
interface RemoteHandle {
    client: Client;
    ensureConnected: () => Promise<void>;
    close: () => Promise<void>;
}

export async function runMcpProxy(options: { token?: string; url?: string }): Promise<void> {
    const token = (options.token ?? process.env["KODIZM_MCP_TOKEN"] ?? "").trim();
    const url = (options.url ?? process.env["KODIZM_MCP_URL"] ?? DEFAULT_REMOTE_URL).trim();

    const remote = token === "" ? null : buildRemoteHandle(url, token);

    let cachedTools: Tool[] | undefined;

    const server = new Server(
        { name: "ac", version: AC_VERSION },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (cachedTools !== undefined) {
            return { tools: cachedTools };
        }

        // 1. Token-less proxy: web-fetch is still served, but local-only via
        //    LOCAL_WEB_FETCH_TOOL_DEFINITION. No bearer means no upstream surface,
        //    so this is the complete catalogue.
        if (remote === null) {
            cachedTools = [
                LOCAL_WEB_FETCH_TOOL_DEFINITION,
                applyAlwaysLoad(HISTORY_TOOL_DEFINITION),
            ];
            return { tools: cachedTools };
        }

        // 2. Bearer configured: pull the upstream allowlisted surface (which carries
        //    remote's own web-fetch definition) and append the local history tool.
        //    Never append the local web-fetch definition here, or web-fetch duplicates.
        const remoteTools: Tool[] = [];
        await remote.ensureConnected();
        const result = await remote.client.listTools();
        for (const tool of result.tools) {
            if (ALLOWED_REMOTE_TOOLS.has(tool.name)) {
                remoteTools.push(applyAlwaysLoad(applyRemoteText(tool)));
            }
        }

        cachedTools = [
            ...remoteTools,
            applyAlwaysLoad(HISTORY_TOOL_DEFINITION),
        ];

        return { tools: cachedTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const requestedName = request.params.name;

        if (requestedName === HISTORY_TOOL_NAME) {
            return runHistoryTool(request.params.arguments);
        }

        if (requestedName === "web-fetch") {
            const args = request.params.arguments;
            const rawUrl = args?.["url"];
            const url = typeof rawUrl === "string" && rawUrl !== "" ? rawUrl : undefined;

            // 1. Token-less: web-fetch is local-only. A missing/blank url is a caller error.
            if (remote === null) {
                if (url === undefined) {
                    throw new McpError(ErrorCode.InvalidParams, "web-fetch requires a string url");
                }
                return runLocalFetch(url);
            }

            // 2. Bearer present with a usable url: race remote against the local fallback.
            //    The 40s remote timeout exceeds the 30s race deadline yet stays under the SDK
            //    60s default, so the SDK never pre-empts mid-race. No AbortSignal: the race
            //    only stops waiting on remote, it never cancels it. ensureConnected runs INSIDE
            //    remoteCall so a connect failure becomes a remote-leg rejection the race falls
            //    back from (local), not a thrown handler that loses the fallback entirely.
            if (url !== undefined) {
                return raceWebFetch({
                    remoteCall: async (): Promise<CallToolResult> => {
                        await remote.ensureConnected();
                        return await remote.client.callTool(
                            {
                                name: "web-fetch",
                                arguments: request.params.arguments,
                            },
                            undefined,
                            { timeout: 40_000 },
                        ) as CallToolResult;
                    },
                    localFetch: () => runLocalFetch(url),
                    triggerMs: 5_000,
                    deadlineMs: 30_000,
                    remoteLabel: "## Remote (kodizm)",
                    localLabel: "## Local fetch (browser headers)",
                });
            }

            // 3. Bearer present but no url: cannot race, fall through to plain remote passthrough.
        }

        if (!ALLOWED_REMOTE_TOOLS.has(requestedName)) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${requestedName}`);
        }

        if (remote === null) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                "Remote MCP not configured; set KODIZM_MCP_TOKEN to enable kodizm tools.",
            );
        }

        // Remote passthrough for docs/search tools. A connection failure OR a
        // network/rate-limit/upstream failure is a tool-execution failure, so normalize it
        // to an isError result rather than letting it propagate as a protocol-level
        // rejection. ensureConnected is inside the try so a lazy-connect failure (remote
        // unreachable, auth rejected at connect) is normalized too, matching the web-fetch
        // race leg where the connect runs inside the fallback-guarded call.
        try {
            await remote.ensureConnected();
            return await remote.client.callTool(
                {
                    name: requestedName,
                    arguments: request.params.arguments,
                },
            ) as CallToolResult;
        } catch (err) {
            return toIsErrorResult(err);
        }
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    const shutdown = (): void => {
        void server.close()
            .then(() => remote?.close())
            .then(() => process.exit(0));
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

/**
 * Build a lazy remote handle so the upstream HTTP transport is opened
 * on first use, not at proxy startup. Keeps the stdio handshake snappy
 * and avoids a network round-trip when the orchestrator only ever
 * invokes a local tool such as search-history.
 */
function buildRemoteHandle(url: string, token: string): RemoteHandle {
    const client = new Client(
        { name: "ac", version: AC_VERSION },
        { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
        new URL(url),
        {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        },
    );

    let connectPromise: Promise<void> | undefined;

    return {
        client,
        ensureConnected: (): Promise<void> => {
            if (connectPromise === undefined) {
                connectPromise = client.connect(transport);
            }
            return connectPromise;
        },
        close: (): Promise<void> => client.close(),
    };
}
