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
import {
    declaresModel,
    deliverFinishedImage,
    deliverImage,
    IMAGE_DEADLINE_MS,
    IMAGE_FIRST_POLL_AFTER_MS,
    IMAGE_TOOL_NAME,
    imageErrorResult,
    imagePollIntervalMs,
    withDefaultModel,
} from "./image-result.ts";
import type { DeliverImageOptions } from "./image-result.ts";
import { LOCAL_WEB_FETCH_TOOL_DEFINITION, runLocalFetch } from "./local-fetch.ts";
import {
    collectMedia,
    describeFailure,
    generateMedia,
    MEDIA_RESULT_TOOL_NAME,
    MUSIC_TOOL_NAME,
    queuedHandleOf,
    VIDEO_TOOL_NAME,
} from "./media-result.ts";
import type { MediaOptions, RemoteCall } from "./media-result.ts";
import {
    asksForReference,
    declaresInlineReference,
    inlineReference,
    REFERENCE_TOOL_TEXT,
    ReferenceImageError,
    referenceErrorResult,
    withLocalReference,
} from "./reference-image.ts";
import { isTransientRemoteError, TRANSIENT_OUTAGE_HINT, withTransientRetry } from "./remote-retry.ts";
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
 * Kodizm's `KodizmServer` ships the first five tool classes under canonical
 * kebab-case names (see `app/Mcp/Tools/*` with `#[Name(...)]`). The
 * federated `kodizm.*` project surface lives on `/mcp/internal` behind
 * a JWT, never on the public PAT route, so the allowlist below is the
 * complete public catalogue for `/mcp/kodizm`. The media tools are the
 * exception: custom Tool rows the operator publishes on their own Mcp
 * instance, which appear in the remote tools/list only for a key that
 * holds their grant (`media_result` rides on any generator's grant).
 */
const ALLOWED_REMOTE_TOOLS: ReadonlySet<string> = new Set([
    "web-search",
    "web-fetch",
    "search-docs",
    "resolve-library",
    "web-code-search",
    IMAGE_TOOL_NAME,
    VIDEO_TOOL_NAME,
    MUSIC_TOOL_NAME,
    MEDIA_RESULT_TOOL_NAME,
]);

/**
 * What `generate_image` does and how often to call it, shared by the Claude Code text and the opencode
 * text. Only the Claude Code text adds {@link PROMPT_GUIDE_TEXT}, since opencode does not ship that skill.
 */
const IMAGE_TOOL_TEXT = "Generate one image with Gemini from a text prompt, save it to a local file and return the "
    + "path with the picture. It draws on a shared hourly and daily quota, so call it only for an image "
    + "the user asked for, and once per image.";

/** What `generate_video` does and costs, shared like {@link IMAGE_TOOL_TEXT}. */
const VIDEO_TOOL_TEXT = "Generate one short video (mp4, a few seconds) with Gemini from a text prompt, wait for it and "
    + "save it to a local file; returns the path. Rendering takes a few minutes and the call waits it out. "
    + "Video has the smallest shared quota (a handful an hour) and a failed render counts too, so call it only "
    + "for a video the user asked for, once per video. Duration, style and audio are hints folded into the prompt; "
    + "leave one out to let Gemini choose. There is no reference picture or start frame.";

/** What `generate_music` does and costs, shared like {@link IMAGE_TOOL_TEXT}. */
const MUSIC_TOOL_TEXT = "Generate one music track (mp3) with Gemini from a text prompt, wait for it and save it to a "
    + "local file; returns the path. A track takes about a minute, longer when Gemini retries, and the call "
    + "waits it out. It draws on a shared hourly and daily quota and a failed track counts too, so call it "
    + "only for a track the user asked for, once per track. The options are hints folded into the prompt; "
    + "leave one out to let Gemini choose.";

/** The Claude Code pointer to the media prompt guide; opencode does not ship the skill. */
const PROMPT_GUIDE_TEXT = "For the prompt, use the Gemini media guidance in the ac:prompt-writer skill.";

/**
 * Model-facing text for the proxied remote tools, replacing what the remote server ships.
 *
 * The remote descriptions of the five utility tools ran about 3,700 characters and named two tools the
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
            + "Take library_id from resolve-library; append /<version> to pin a version. If it reports the "
            + "library not found, retry with the next resolve-library match.",
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
            + "or unrendered page, and when you need the page text "
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
    [IMAGE_TOOL_NAME]: {
        description: `${IMAGE_TOOL_TEXT} ${PROMPT_GUIDE_TEXT}`,
        params: {
            prompt: "What to draw.",
            reference_image_url: "Optional reference to edit or restyle: the image_url a previous call returned, "
                + "while its link is valid.",
            model: "Gemini model, hydrogen or neon. Defaults to neon, which needs a Pro account; hydrogen runs on any "
                + "unless thinking or chat_id is set, which need Pro too.",
            thinking: "How hard the model thinks before drawing: low, medium or high.",
            chat_id: "Optional conversation label of 1 to 64 letters, digits, _ or -. Reuse it to continue the same "
                + "conversation; leave it out for a one-off picture.",
            aspect_ratio: "1:1, 9:16, 3:4, 4:3 or 16:9.",
            style: "cinematic, y2k-stickers, technicolour, gothic-clay, sketch, steampunk, or one line of your own up "
                + "to 300 characters.",
            size: "WxH in pixels, mapped to the nearest supported ratio; aspect_ratio wins when both are sent.",
        },
    },
    [VIDEO_TOOL_NAME]: {
        description: `${VIDEO_TOOL_TEXT} ${PROMPT_GUIDE_TEXT}`,
        params: {
            prompt: "What the video shows: subject, action, setting, camera and light. Up to 8000 characters with "
                + "the options.",
            aspect_ratio: "16:9 (default) or 9:16.",
            duration_seconds: "3 to 10. A hint; the clip may differ.",
            style: "Visual style, up to 80 characters.",
            audio: "What to hear, up to 200 characters, or none for a silent video.",
        },
    },
    [MUSIC_TOOL_NAME]: {
        description: `${MUSIC_TOOL_TEXT} ${PROMPT_GUIDE_TEXT}`,
        params: {
            prompt: "The track to make, genre first, then mood, instruments, tempo and theme. Up to 8000 characters "
                + "with the options.",
            genre: "Genre, up to 80 characters.",
            vocals: "Voice, up to 80 characters (for example female alto), or instrumental for none.",
            length_seconds: "10 to 180. A hint; the track may differ.",
            mood: "Mood, up to 80 characters.",
            instruments: "Instruments, up to 160 characters.",
            lyrics: "Words to sing, up to 3000 characters; leave it out to let Gemini write them. Not with "
                + "instrumental vocals.",
        },
    },
    [MEDIA_RESULT_TOOL_NAME]: {
        description: "Collect an image, video or track whose generate_image, generate_video or generate_music call "
            + "returned a handle instead of a file: waits for it and saves it to a local file. It never generates "
            + "anything new, so it is safe to repeat.",
        params: {
            handle: "The handle generate_image, generate_video or generate_music returned.",
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
 * readable failure instead of a protocol-level rejection. A transient failure that survived the retries
 * also carries the wait-and-retry instruction.
 */
export function toIsErrorResult(err: unknown): CallToolResult {
    const message = err instanceof Error ? err.message : String(err);
    const hint = isTransientRemoteError(err) ? `. ${TRANSIENT_OUTAGE_HINT}` : "";

    return {
        isError: true,
        content: [{ type: "text", text: `remote tool call failed: ${message}${hint}` }],
    };
}

/**
 * Server-level usage guidance loaded at session start regardless of
 * tool-search deferral. Kept under the 2KB truncation bound.
 */
export const SERVER_INSTRUCTIONS =
    "For a library or framework question call resolve-library, then search-docs, before any web "
    + "search; for real usage of an API call web-code-search. web-search is the fallback after the "
    + "built-in WebSearch. web-fetch returns exact page text; otherwise it is the last fetch fallback, "
    + "after the built-in WebFetch and any local fetch server. GitHub files, issues and pull requests "
    + "go through gh when it is installed. For the user's own past work or conversations, call "
    + "search-history instead of guessing.";

/**
 * Which host the server speaks to. `opencode` has no built-in WebFetch/WebSearch to be a fallback
 * for, so that mode words the instructions and the web tool descriptions without naming any Claude
 * Code built-in. `search-history` is served in both modes: it reads the local Claude Code archive,
 * which stays the operator's history when the session runs in opencode.
 */
export type McpClient = "claude-code" | "opencode";

export const MCP_CLIENTS: readonly McpClient[] = ["claude-code", "opencode"];

export const OPENCODE_SERVER_INSTRUCTIONS =
    "For library docs call resolve-library, then search-docs; for real usage of an API call "
    + "web-code-search; web-search and web-fetch are the web tools. For the user's own past work or "
    + "Claude Code conversations, call search-history instead of guessing.";

/**
 * The Claude Code descriptions of the two web tools call them fallbacks for built-ins opencode
 * does not have (its websearch is disabled in favour of these), which would steer the model away
 * from its only web route. The media tools' Claude Code text names a skill opencode does not ship.
 */
const OPENCODE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    "web-fetch": "Fetch a page and return its content as markdown. Use it when you need the page text "
        + "itself, including pages the plain fetch tool cannot render or is blocked from.",
    "web-search": "Search the web across several engines and return deduplicated results. This is the "
        + "web search tool; use it for current information and to find pages to fetch.",
    [IMAGE_TOOL_NAME]: IMAGE_TOOL_TEXT,
    [VIDEO_TOOL_NAME]: VIDEO_TOOL_TEXT,
    [MUSIC_TOOL_NAME]: MUSIC_TOOL_TEXT,
};

/**
 * The sentence added to the image description only when the remote declares `chat_id`, so a remote without
 * conversations never tells the model a follow-up can skip its reference.
 */
const CHAT_TOOL_TEXT = "Calls that pass the same chat_id are turns of one Gemini conversation, so a follow-up edit "
    + "there needs no reference. Word a follow-up as an image request (\"Generate an image: the same boat, now red\"): "
    + "Gemini can answer a bare edit with text and draw nothing.";

function withChatText(tool: Tool): Tool {
    const properties = tool.inputSchema.properties;
    if (properties === undefined || !("chat_id" in properties)) {
        return tool;
    }

    return { ...tool, description: `${tool.description ?? ""} ${CHAT_TOOL_TEXT}`.trim() };
}

function forClient(tool: Tool, client: McpClient): Tool {
    const description = client === "opencode" ? OPENCODE_TOOL_DESCRIPTIONS[tool.name] : undefined;
    if (description === undefined) {
        return tool;
    }

    // The reference and chat sentences are added only for a remote that takes them, and opencode keeps them.
    const kept = [REFERENCE_TOOL_TEXT, CHAT_TOOL_TEXT].filter((text) => tool.description?.includes(text) === true);

    return { ...tool, description: [description, ...kept].join(" ") };
}

/**
 * Assemble the tools/list catalogue. `remoteTools` is the upstream list when a bearer is
 * configured and `null` when token-less (web-fetch is then local-only). The local history tool
 * is appended last.
 */
export function buildCatalogue(remoteTools: readonly Tool[] | null, client: McpClient): Tool[] {
    const catalogue: Tool[] = [];

    // 1. Token-less: no upstream surface, so the local web-fetch is the whole remote-shaped part.
    if (remoteTools === null) {
        catalogue.push(forClient(LOCAL_WEB_FETCH_TOOL_DEFINITION, client));
    } else {
        // 2. Bearer: the allowlisted upstream surface, which carries remote's own web-fetch.
        //    Never add the local web-fetch definition here, or web-fetch duplicates.
        for (const tool of remoteTools) {
            if (ALLOWED_REMOTE_TOOLS.has(tool.name)) {
                const shaped = tool.name === IMAGE_TOOL_NAME
                    ? withChatText(withLocalReference(applyRemoteText(tool)))
                    : applyRemoteText(tool);

                catalogue.push(forClient(applyAlwaysLoad(shaped), client));
            }
        }
    }

    catalogue.push(applyAlwaysLoad(HISTORY_TOOL_DEFINITION));
    return catalogue;
}

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

export async function runMcpProxy(
    options: { token?: string; url?: string; client?: McpClient },
): Promise<void> {
    const clientMode: McpClient = options.client ?? "claude-code";
    const token = (options.token ?? process.env["KODIZM_MCP_TOKEN"] ?? "").trim();
    const url = (options.url ?? process.env["KODIZM_MCP_URL"] ?? DEFAULT_REMOTE_URL).trim();

    const remote = token === "" ? null : buildRemoteHandle(url, token);

    let cachedTools: Tool[] | undefined;
    let remoteTakesReference: boolean | undefined;
    let remoteTakesModel: boolean | undefined;
    const chatPictures = new Map<string, Set<string>>();

    const server = new Server(
        { name: "ac", version: AC_VERSION },
        {
            capabilities: { tools: {} },
            instructions: clientMode === "opencode" ? OPENCODE_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS,
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (cachedTools !== undefined) {
            return { tools: cachedTools };
        }

        if (remote === null) {
            cachedTools = buildCatalogue(null, clientMode);
            return { tools: cachedTools };
        }

        // An upstream that stays down still leaves the local tools usable: a client such as opencode marks a
        // server failed when its first tools/list throws and never lists it again. The fallback is not cached,
        // so the next tools/list tries the upstream once more.
        try {
            const upstream = await listUpstreamTools(remote);

            remoteTakesReference = declaresInlineReference(upstream);
            remoteTakesModel = declaresModel(upstream);
            cachedTools = buildCatalogue(upstream, clientMode);

            return { tools: cachedTools };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(`ac mcp: upstream tool list failed, serving the local tools only: ${reason}\n`);
            return { tools: buildCatalogue(null, clientMode) };
        }
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

        const call: RemoteCall = async (name, args, signal) => {
            await remote.ensureConnected();

            return await remote.client.callTool({ name, arguments: args }, undefined, { signal }) as CallToolResult;
        };
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;
        const mediaOptions: MediaOptions = {
            signal: extra.signal,
            onProgress: progressToken === undefined
                ? undefined
                : (message) => extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: ++progress, message },
                }),
            onImage: (image) => deliverFinishedImage(image, { signal: extra.signal }),
        };

        // A generation draws on a quota shared with the other accounts, so it is attempted once: a retry
        // after a timeout could draw a second picture the caller never sees, and its error carries no
        // retry hint for the same reason. The remote answers with a signed link rather than bytes, either at once
        // or, when kodizm queues pictures, through a handle the proxy collects itself; either way the model gets
        // the file and the picture.
        if (requestedName === IMAGE_TOOL_NAME) {
            try {
                // 1. A remote whose tool takes no reference would drop one and answer a fresh picture that looks
                //    like an edit, so a reference is refused unless the remote declares it.
                if (asksForReference(request.params.arguments)) {
                    if (remoteTakesReference === undefined) {
                        try {
                            const upstream = await listUpstreamTools(remote);

                            remoteTakesReference = declaresInlineReference(upstream);
                            remoteTakesModel = declaresModel(upstream);
                        } catch (err) {
                            throw new ReferenceImageError(
                                `Could not check whether the connected Kodizm takes a reference picture: ${describeFailure(err)}.`,
                            );
                        }
                    }

                    if (!remoteTakesReference) {
                        throw new ReferenceImageError("The connected Kodizm does not take a reference picture yet.");
                    }
                }

                // 2. A local reference file is read and inlined here, before the remote is reached: a refused
                //    path sends nothing, so it is the one failure that is safe to repeat once fixed.
                const inlined = await inlineReference(request.params.arguments);

                // 3. The default model rides only on a schema already read: clients list tools before calling, and
                //    a remote that does not declare model would refuse it.
                const args = inlined === undefined
                    ? undefined
                    : withDefaultModel(inlined, remoteTakesModel === true);

                await remote.ensureConnected();

                const generated = await remote.client.callTool(
                    {
                        name: requestedName,
                        arguments: args,
                    },
                ) as CallToolResult;

                const chatId = args?.["chat_id"];
                const delivery: DeliverImageOptions = {
                    chat: typeof chatId === "string" && chatId !== "" ? { id: chatId, seen: chatPictures } : undefined,
                    signal: extra.signal,
                };
                const handle = generated.isError === true ? undefined : queuedHandleOf(generated);

                if (handle === undefined) {
                    return await deliverImage(generated, delivery);
                }

                return await collectMedia(call, handle, {
                    ...mediaOptions,
                    deadlineMs: IMAGE_DEADLINE_MS,
                    firstPollAfterMs: IMAGE_FIRST_POLL_AFTER_MS,
                    onImage: (image) => deliverFinishedImage(image, delivery),
                }, imagePollIntervalMs);
            } catch (err) {
                return err instanceof ReferenceImageError ? referenceErrorResult(err) : imageErrorResult(err);
            }
        }

        // A video or track renders in the background on kodizm and answers a handle; the proxy waits on the handle
        // itself so the model makes one call and gets a file. Claude Code allows a stdio call 30 idle minutes and
        // moves one past two minutes to a background task, and a progress notice per pending poll shows the wait.
        if (requestedName === VIDEO_TOOL_NAME || requestedName === MUSIC_TOOL_NAME
            || requestedName === MEDIA_RESULT_TOOL_NAME) {
            const args = request.params.arguments ?? {};
            const handle = args["handle"];

            // A media_result call without a usable handle goes to the remote, which refuses it in its own words.
            if (requestedName === MEDIA_RESULT_TOOL_NAME) {
                if (typeof handle !== "string" || handle === "") {
                    try {
                        return await call(requestedName, args);
                    } catch (err) {
                        return toIsErrorResult(err);
                    }
                }

                return await collectMedia(call, handle, mediaOptions);
            }

            return await generateMedia(call, requestedName, args, mediaOptions);
        }

        // Remote passthrough for docs/search tools. A connection failure OR a
        // network/rate-limit/upstream failure is a tool-execution failure, so normalize it
        // to an isError result rather than letting it propagate as a protocol-level
        // rejection. ensureConnected is inside the try so a lazy-connect failure (remote
        // unreachable, auth rejected at connect) is normalized too, matching the web-fetch
        // race leg where the connect runs inside the fallback-guarded call. These tools are
        // reads with no local fallback, so a transient outage is retried here; web-fetch is
        // not, because its local leg already answers while the remote is down and a retry
        // would hold that answer back.
        try {
            return await withTransientRetry(async (): Promise<CallToolResult> => {
                await remote.ensureConnected();

                return await remote.client.callTool(
                    {
                        name: requestedName,
                        arguments: request.params.arguments,
                    },
                ) as CallToolResult;
            });
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
/** Upstream tools/list attempts before the proxy falls back to its local tools; the delay grows per attempt. */
const UPSTREAM_LIST_ATTEMPTS = 3;
const UPSTREAM_RETRY_DELAY_MS = 500;

/**
 * Several clients starting at once (an opencode coordinator and its lanes) have been seen to lose one upstream
 * connect to a transient "fetch failed", so a failed attempt is retried before the caller gives up.
 */
async function listUpstreamTools(remote: RemoteHandle): Promise<Tool[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPSTREAM_LIST_ATTEMPTS; attempt++) {
        try {
            await remote.ensureConnected();
            return (await remote.client.listTools()).tools;
        } catch (err) {
            lastError = err;
            if (attempt < UPSTREAM_LIST_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS * attempt));
            }
        }
    }
    throw lastError;
}

function buildRemoteHandle(url: string, token: string): RemoteHandle {
    const client = new Client(
        { name: "ac", version: AC_VERSION },
        { capabilities: {} },
    );

    let connectPromise: Promise<void> | undefined;

    return {
        client,
        // A failed connect is not kept: the next call starts over on a fresh transport, since a transport that
        // was started once cannot be started again. A kept rejection would fail every later call for the life of
        // the process.
        ensureConnected: (): Promise<void> => {
            if (connectPromise === undefined) {
                const transport = new StreamableHTTPClientTransport(
                    new URL(url),
                    {
                        requestInit: { headers: { Authorization: `Bearer ${token}` } },
                    },
                );
                connectPromise = client.connect(transport).catch((err: unknown) => {
                    connectPromise = undefined;
                    throw err;
                });
            }
            return connectPromise;
        },
        close: (): Promise<void> => client.close(),
    };
}
