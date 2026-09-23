import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { HISTORY_HEAD_LIMIT_DEFAULT, HISTORY_HEAD_LIMIT_MAX, runSearch } from "./history-search.ts";
import type { HistorySearchArgs, HistorySearchDeps } from "./history-search.ts";
import { createHistoryStoreHandle } from "./history-store.ts";
import type { HistoryStoreHandle } from "./history-store.ts";
import { toIsErrorResult } from "./mcp.ts";

/**
 * The MCP-facing surface of the history search feature: the `Tool` definition the model reads
 * to decide how to call it, and the handler `mcp.ts` dispatches a matching request to.
 *
 * All of the interesting behaviour, argument narrowing included, already lives in
 * {@link runSearch}: mode dispatch, the conditional `pattern`/`session_id` requirement, the
 * `head_limit`/`offset` bounds and every metadata filter are validated there and throw
 * `McpError(ErrorCode.InvalidParams)` on a bad field. This module does not re-implement that
 * gate; it only guards the one thing `runSearch` cannot, since it expects a typed
 * `HistorySearchArgs` rather than the `unknown` the MCP SDK hands a tool handler, and it owns
 * the error boundary that decides whether a thrown value is a protocol answer or a readable
 * failure.
 */

/** Wire name for the tool, also used by `mcp.ts`'s dispatch branch. */
export const HISTORY_TOOL_NAME = "search-history" as const;

/**
 * Schema mirrors Claude Code's own `Grep` vocabulary (`pattern`, `-i`, `head_limit`) so the model
 * needs no new names, plus the domain-specific filters this archive supports. `pattern` and
 * `session_id` are each required in exactly one mode and not the other (`pattern` for
 * `content`/`sessions`/`projects`/`count`, `session_id` for `read`), which JSON Schema's flat
 * `required`
 * array cannot express as a conditional; `runSearch` enforces both per-mode instead.
 */
export const HISTORY_TOOL_DEFINITION: Tool = {
    name: HISTORY_TOOL_NAME,
    description:
        "Search the user's past Claude Code conversations across every local project. `pattern` is "
        + "TOKENIZED FULL-TEXT search with prefix matching, NOT a regular expression: tokens are ANDed "
        + "and punctuation is DROPPED, so write plain words. Case-insensitive, and folds Turkish letters "
        + "both ways, so `calisiyor` finds `\u00e7al\u0131\u015f\u0131yor`. `output_mode` \"read\" opens one "
        + "`session_id` in order instead of searching. Indexes prose, tool arguments and failed tool "
        + "output, not successful output.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "Plain search words, not a regex. Required unless output_mode is \"read\".",
            },
            path: {
                type: "string",
                description: "Only turns whose project path contains this substring.",
            },
            output_mode: {
                type: "string",
                enum: ["content", "sessions", "projects", "count", "read"],
                default: "content",
                description: "content: an excerpt per turn. sessions, projects: one entry each. "
                    + "count: totals. read: one session_id in order, no search.",
            },
            head_limit: {
                type: "number",
                minimum: 1,
                maximum: HISTORY_HEAD_LIMIT_MAX,
                default: HISTORY_HEAD_LIMIT_DEFAULT,
                description: "Maximum hits, or turns in read mode.",
            },
            offset: {
                type: "number",
                minimum: 0,
                default: 0,
                description: "Hits, or turns in read mode, to skip.",
            },
            "-i": {
                type: "boolean",
                description: "No-op; matching is always case-insensitive.",
            },
            since: {
                type: "string",
                description: "ISO 8601 date or date-time lower bound.",
            },
            until: {
                type: "string",
                description: "ISO 8601 date or date-time upper bound.",
            },
            role: {
                type: "string",
                enum: ["user", "assistant", "any"],
                default: "any",
                description: "Only turns from this role.",
            },
            kind: {
                type: "string",
                enum: ["prose", "tool_use", "tool_error", "any"],
                default: "any",
                description: "Only this kind of turn.",
            },
            include_subagents: {
                type: "boolean",
                default: true,
                description: "false excludes subagent turns.",
            },
            agent_type: {
                type: "string",
                description: "Only subagent turns of this agent type, e.g. \"ac:librarian\".",
            },
            session_id: {
                type: "string",
                description: "Session key from an earlier hit; required when output_mode is \"read\".",
            },
        },
        required: [],
    },
};

/**
 * Lazily-opened, process-wide handle on the archive, so a stdio server that never calls
 * `search-history` never pays to open sqlite, and two overlapping calls share one open. Copied
 * from the `connectPromise` memoization at `mcp.ts:320-328`, same as {@link createHistoryStoreHandle}
 * itself already does internally.
 */
let productionStoreHandle: HistoryStoreHandle | undefined;

function getProductionStoreHandle(): HistoryStoreHandle {
    if (productionStoreHandle === undefined) {
        productionStoreHandle = createHistoryStoreHandle();
    }

    return productionStoreHandle;
}

/**
 * Narrows the MCP SDK's `unknown` tool arguments to the loose shape {@link runSearch} accepts.
 *
 * Only the object-shape is checked here; every field is narrowed and validated by `runSearch`
 * itself, so this module does not duplicate that gate; it only rules out the one input `runSearch`
 * cannot handle at all, a non-object argument, before its property accesses would throw a bare
 * `TypeError` instead of a protocol-legible `McpError`.
 */
function toSearchArgs(args: unknown): HistorySearchArgs {
    if (typeof args !== "object" || args === null) {
        throw new McpError(ErrorCode.InvalidParams, "arguments must be an object");
    }

    return args as HistorySearchArgs;
}

/**
 * Runs a `search-history` tool call.
 *
 * @param args Raw MCP tool arguments, narrowed and validated by {@link runSearch}.
 * @param overrides Test-only injection point for `runSearch`'s collaborators (store, sync,
 *        filesystem, clock). Production calls from `mcp.ts` pass none, so the store opens through
 *        the lazily-memoized {@link getProductionStoreHandle}.
 * @returns A `CallToolResult` on every path. A caller error (bad argument) is an `McpError` and
 *          propagates so the protocol reports it; every other failure, including a missing
 *          `node:sqlite` binding, is normalized by {@link toIsErrorResult} into a readable
 *          `isError` result instead of crashing the server.
 */
export async function runHistoryTool(
    args: unknown,
    overrides: Partial<HistorySearchDeps> = {},
): Promise<CallToolResult> {
    try {
        const request = toSearchArgs(args);
        const store = overrides.store ?? await getProductionStoreHandle().ensureOpen();
        const deps: HistorySearchDeps = { ...overrides, store };

        const text = await runSearch(request, deps);

        return { content: [{ type: "text", text }] };
    } catch (err) {
        if (err instanceof McpError) {
            throw err;
        }

        return toIsErrorResult(err);
    }
}
