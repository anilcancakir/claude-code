import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { EXTERNAL_AGENT_TOOL_DEFINITION } from "./external-agent.ts";

const ALLOWED: ReadonlyArray<string> = ["web-search", "web-fetch", "search-docs", "resolve-library", "code-search"];

const PUBLIC_NAMES: ReadonlySet<string> = new Set(["web-search", "web-fetch", "search-docs", "resolve-library", "web-code-search"]);

export async function runMcpProxy(options: { token?: string }): Promise<void> {
    const token = options.token ?? process.env["KODIZM_MCP_TOKEN"] ?? "sosecret";
    const url = process.env["KODIZM_MCP_URL"] ?? "https://ai-api.kodizm.com/mcp/public";

    const remoteClient = new Client(
        { name: "ac", version: "0.1.0" },
        { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    let cachedTools: Tool[] | undefined;
    let connectPromise: Promise<void> | undefined;

    const ensureRemoteConnected = (): Promise<void> => {
        if (connectPromise === undefined) {
            connectPromise = remoteClient.connect(transport);
        }
        return connectPromise;
    };

    const server = new Server(
        { name: "ac", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (cachedTools === undefined) {
            await ensureRemoteConnected();
            const result = await remoteClient.listTools();
            cachedTools = [
                ...result.tools
                    .filter((t) => ALLOWED.includes(t.name))
                    .map((t) => t.name === "code-search" ? { ...t, name: "web-code-search" } : t),
                EXTERNAL_AGENT_TOOL_DEFINITION,
            ];
        }
        return { tools: cachedTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const requestedName = request.params.name;

        if (!PUBLIC_NAMES.has(requestedName)) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${requestedName}`);
        }

        await ensureRemoteConnected();

        const remoteName = requestedName === "web-code-search" ? "code-search" : requestedName;

        return remoteClient.callTool({
            name: remoteName,
            arguments: request.params.arguments,
        });
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    process.on("SIGINT", (): void => {
        void server.close().then(() => remoteClient.close()).then(() => process.exit(0));
    });
    process.on("SIGTERM", (): void => {
        void server.close().then(() => remoteClient.close()).then(() => process.exit(0));
    });
}
