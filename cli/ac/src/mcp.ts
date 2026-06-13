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
import {
    EXTERNAL_AGENT_TOOL_DEFINITION,
    killAllActiveChildren,
    LOCAL_TOOL_NAME,
    runExternalAgent,
} from "./external-agent.ts";
import { LOCAL_WEB_FETCH_TOOL_DEFINITION, runLocalFetch } from "./local-fetch.ts";
import { raceWebFetch } from "./web-fetch-race.ts";

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
        { name: "ac", version: "0.4.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (cachedTools !== undefined) {
            return { tools: cachedTools };
        }

        // 1. Token-less proxy: web-fetch is still served, but local-only via
        //    LOCAL_WEB_FETCH_TOOL_DEFINITION. No bearer means no upstream surface,
        //    so this is the complete catalogue.
        if (remote === null) {
            cachedTools = [LOCAL_WEB_FETCH_TOOL_DEFINITION, EXTERNAL_AGENT_TOOL_DEFINITION];
            return { tools: cachedTools };
        }

        // 2. Bearer configured: pull the upstream allowlisted surface (which carries
        //    remote's own web-fetch definition) and append the local agent tool.
        //    Never append the local web-fetch definition here, or web-fetch duplicates.
        const remoteTools: Tool[] = [];
        await remote.ensureConnected();
        const result = await remote.client.listTools();
        for (const tool of result.tools) {
            if (ALLOWED_REMOTE_TOOLS.has(tool.name)) {
                remoteTools.push(tool);
            }
        }

        cachedTools = [...remoteTools, EXTERNAL_AGENT_TOOL_DEFINITION];

        return { tools: cachedTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const requestedName = request.params.name;

        if (requestedName === LOCAL_TOOL_NAME) {
            return runExternalAgent(request.params.arguments);
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

        await remote.ensureConnected();

        return remote.client.callTool(
            {
                name: requestedName,
                arguments: request.params.arguments,
            },
        );
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    const shutdown = (): void => {
        void killAllActiveChildren(5000)
            .then(() => server.close())
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
 * invokes the local call-external-agent tool.
 */
function buildRemoteHandle(url: string, token: string): RemoteHandle {
    const client = new Client(
        { name: "ac", version: "0.4.0" },
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
