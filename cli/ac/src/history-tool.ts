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
 * `content`/`sessions`/`count`, `session_id` for `read`), which JSON Schema's flat `required`
 * array cannot express as a conditional; `runSearch` enforces both per-mode instead.
 */
export const HISTORY_TOOL_DEFINITION: Tool = {
    name: HISTORY_TOOL_NAME,
    description:
        "Search the user's own local Claude Code conversation history across every local project, "
        + "backed by a permanent SQLite full-text archive. `pattern` is TOKENIZED FULL-TEXT search "
        + "with prefix matching, NOT a regular expression: it splits on whitespace, matches each "
        + "token as a prefix, and ANDs the tokens together. Punctuation is DROPPED by the tokenizer "
        + "rather than searched, so regex-shaped input degrades silently instead of erroring: `C++` "
        + "searches the bare prefix `c` and matches almost every turn, and `node.*sqlite` searches "
        + "for `node` immediately followed by `sqlite`; write plain search words instead. Matching "
        + "is case-insensitive and fully diacritic-insensitive for Turkish, in both directions: "
        + "`gozden` finds `gözden`, and `calisiyor` finds `çalışıyor` because every token is "
        + "expanded over the dotted/dotless i axis the tokenizer does not fold on its own. Type a "
        + "Turkish word either way. `pattern` is required for "
        + "`output_mode` "
        + "`content`, `sessions` and `count`; it is not used for `read`, which instead opens a "
        + "chronological window on one `session_id` (required in that mode). Only prose and tool "
        + "arguments are indexed: successful tool output is never indexed, while failed tool "
        + "output (errors) is, so this tool cannot surface a large file dump but can surface why "
        + "something broke.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "Tokenized full-text search terms, NOT a regex. Required unless "
                    + "output_mode is \"read\".",
            },
            path: {
                type: "string",
                description: "Filters to turns whose stored project path contains this substring.",
            },
            output_mode: {
                type: "string",
                enum: ["content", "sessions", "count", "read"],
                default: "content",
                description: "content: one excerpt per matching turn. sessions: one entry per "
                    + "matching session. count: match/session/project totals only. read: a "
                    + "chronological window on one session_id, no search performed.",
            },
            head_limit: {
                type: "number",
                minimum: 1,
                maximum: HISTORY_HEAD_LIMIT_MAX,
                default: HISTORY_HEAD_LIMIT_DEFAULT,
                description: "Maximum number of hits (or turns, in read mode) to return.",
            },
            offset: {
                type: "number",
                minimum: 0,
                default: 0,
                description: "Number of hits (or turns, in read mode) to skip before the page starts.",
            },
            "-i": {
                type: "boolean",
                description: "Always on regardless of this flag: the archive's unicode61 tokenizer "
                    + "is case-insensitive by construction. Accepted only for vocabulary "
                    + "compatibility with the built-in Grep tool.",
            },
            since: {
                type: "string",
                description: "ISO 8601 date or date-time; excludes turns before it.",
            },
            until: {
                type: "string",
                description: "ISO 8601 date or date-time; excludes turns after it.",
            },
            role: {
                type: "string",
                enum: ["user", "assistant", "any"],
                default: "any",
                description: "Restricts to turns from this role.",
            },
            kind: {
                type: "string",
                enum: ["prose", "tool_use", "tool_error", "any"],
                default: "any",
                description: "Restricts to this kind of turn.",
            },
            include_subagents: {
                type: "boolean",
                default: true,
                description: "Set false to exclude subagent transcript turns.",
            },
            agent_type: {
                type: "string",
                description: "Restricts to subagent turns of this agent type, e.g. \"ac:librarian\".",
            },
            session_id: {
                type: "string",
                description: "Database key of one session. Required when output_mode is \"read\"; "
                    + "the value comes from the session_id shown on a prior content or sessions hit.",
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
