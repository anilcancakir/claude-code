/**
 * Distills one raw Claude Code transcript line into zero or more indexable rows, and resolves a
 * session's title and first-prompt metadata from its head and tail byte windows.
 *
 * This module performs no IO and applies no redaction: {@link distillLine} is a pure function
 * over an already-read line plus caller-supplied context, and redaction is applied by the store
 * (`history-store.ts`) at write time so it can be revisited without re-parsing the source
 * transcript. `resolveSessionMeta`'s two fallback chains copy Claude Code's own `readLiteMetadata`
 * contract (`references/claude-code-cli-source-code/utils/sessionStorage.ts:4740-4805`) rather
 * than inventing a new one, operator choice included, so a title or first-prompt computed here
 * never disagrees with the CLI's own resume picker for the same session.
 */

/** A transcript role: the only two record types this module extracts rows from. */
export type DistillRole = "user" | "assistant";

/** The three row shapes a distilled line can produce. */
export type DistillRowKind = "prose" | "tool_use" | "tool_error";

/**
 * Context the sync driver supplies alongside a raw line, carrying the facts a single JSONL line
 * cannot reliably state about itself: which project it belongs to (most lines never repeat
 * `cwd`, only the first one in a session does) and whether the file is a subagent transcript,
 * which Step 9 derives from the file's `subagents/` path position rather than from a per-row
 * field.
 */
export interface DistillContext {
    readonly projectPath: string;
    readonly isSubagent: boolean;
    readonly agentType?: string;
}

/** One indexable row extracted from a transcript line, shaped for `history-store.ts`'s `turns` table. */
export interface DistillRow {
    readonly id: string;
    readonly sessionId: string;
    readonly projectPath: string;
    readonly ts: number | undefined;
    readonly role: DistillRole;
    readonly kind: DistillRowKind;
    readonly isSubagent: boolean;
    readonly agentType: string | undefined;
    readonly body: string;
}

/**
 * The four outcomes a distilled line can produce: `rows` for a line that yielded at least one
 * indexable row, `control` for Claude Code's own bookkeeping records (allowlisted or not),
 * `skipped` for a `user` or `assistant` line whose every block is a type the distiller KNOWS and
 * deliberately does not index (`thinking`, `image`, a successful `tool_result`), and `quarantine`
 * for a line that failed to parse, lacked a `uuid` or `sessionId`, or held a block type the
 * distiller does not recognize at all, carrying the raw line so a later parser fix can recover it
 * without the source transcript. The `skipped` versus `quarantine` split is deliberate: a
 * `skipped` line is data the user chose not to index, while a `quarantine` line may be prose lost
 * forever once `cleanupPeriodDays` takes the transcript.
 */
export type DistillOutcome =
    | { readonly outcome: "rows"; readonly rows: readonly DistillRow[] }
    | { readonly outcome: "control" }
    | { readonly outcome: "skipped" }
    | { readonly outcome: "quarantine"; readonly raw: string };

/** Resolved session metadata: the title and first-prompt contract `resolveSessionMeta` copies. */
export interface SessionMeta {
    readonly title: string | undefined;
    readonly firstPrompt: string;
    readonly projectPath: string | undefined;
}

const USER_TYPE_MARKER = '"type":"user"';
const ASSISTANT_TYPE_MARKER = '"type":"assistant"';

/**
 * Rejects, without paying for `JSON.parse`, any line that cannot possibly be a `user` or
 * `assistant` record. Every one of the plan's seventeen control types plus any future
 * unrecognized type fails this check by construction, since none of their `type` values equal
 * `"user"` or `"assistant"`. This single substring test is both the cheap control-versus-
 * conversational split and the reason a new record type in a future Claude Code release cannot
 * flood the quarantine table.
 */
function looksLikeConversationalLine(line: string): boolean {
    return line.includes(USER_TYPE_MARKER) || line.includes(ASSISTANT_TYPE_MARKER);
}

/** A parsed transcript line's shape, narrowed just enough to drive row extraction. */
interface ParsedLine {
    readonly type: string;
    readonly uuid?: unknown;
    readonly sessionId?: unknown;
    readonly timestamp?: unknown;
    readonly message?: { readonly role?: unknown; readonly content?: unknown };
}

/** A single block inside an array `message.content`, narrowed just enough for extraction. */
interface ContentBlock {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
    readonly is_error?: unknown;
    readonly content?: unknown;
}

/**
 * Renders a `tool_use` block's `input` as `key=value` pairs over every string, number and boolean
 * entry, in insertion order. Deliberately iterates the object's own entries rather than naming a
 * fixed field set, because a prior art that named fields silently dropped `new_string`, `regex`
 * and `url` on tools it had not been updated for.
 */
function renderToolUseInput(input: unknown): string {
    if (typeof input !== "object" || input === null) {
        return "";
    }

    const pairs: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            pairs.push(`${key}=${value}`);
        }
    }

    return pairs.join(" ");
}

/**
 * Extracts prose text from a `tool_result` block's `content`, which is either a plain string or
 * an array of content blocks, mirroring `message.content`'s own two shapes.
 */
function extractToolResultText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content as readonly ContentBlock[]) {
            if (block.type === "text" && typeof block.text === "string") {
                texts.push(block.text);
            }
        }
        return texts.join("\n");
    }

    return "";
}

/** Assembles one {@link DistillRow}, folding in the caller-supplied context. */
function makeRow(
    id: string,
    sessionId: string,
    ts: number | undefined,
    role: DistillRole,
    kind: DistillRowKind,
    ctx: DistillContext,
    body: string,
): DistillRow {
    return {
        id,
        sessionId,
        projectPath: ctx.projectPath,
        ts,
        role,
        kind,
        isSubagent: ctx.isSubagent,
        agentType: ctx.agentType,
        body,
    };
}

/**
 * The block types the distiller recognizes and knows how to handle, whether or not the block
 * itself produces a row. Measured over 400 real transcript files, the full inventory is exactly
 * `text`, `thinking`, `tool_use`, `tool_result`, `image` and `document`; `document` is
 * deliberately excluded here (see {@link buildRows}), so a `document`-only line quarantines
 * rather than skips.
 */
const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set(["text", "thinking", "tool_use", "tool_result", "image"]);

const SEARCH_TOOL_NAME = "search-history";

/**
 * True for a call to this archive's own search tool, which is never indexed.
 *
 * A `tool_use` row renders its input as `key=value` pairs, so indexing a search records the query
 * terms verbatim; the next search for those terms then finds the earlier search. Measured live
 * while testing: two `count` calls for the same word thirty seconds apart returned 1,896 then
 * 1,899 hits, the three new rows being the searches themselves, and a short high-density row like
 * `search-history pattern=«FTS5» «tokenizer»` outranks the work it was looking for under bm25.
 *
 * So the tool declines to index itself. A past search is not past work, and the archive stays a
 * record of what the user did rather than of what they looked for.
 */
function isSelfReferentialToolCall(name: string): boolean {
    return name === SEARCH_TOOL_NAME || name.endsWith(`__${SEARCH_TOOL_NAME}`);
}

/**
 * What one line's content produced: the rows extracted, plus whether any block encountered was
 * outside {@link KNOWN_BLOCK_TYPES}. `hasUnknownBlock` is what {@link distillLine} uses to decide
 * `quarantine` over `skipped` when `rows` comes back empty.
 */
interface BuildRowsResult {
    readonly rows: DistillRow[];
    readonly hasUnknownBlock: boolean;
}

/**
 * Builds every row a parsed `user` or `assistant` line yields: at most one `prose` row from the
 * concatenation of all `text` blocks (or the plain string), one `tool_use` row per `tool_use`
 * block, and one `tool_error` row per `tool_result` block whose `is_error` is true. `thinking`,
 * `image`, and successful `tool_result` blocks are KNOWN but contribute no row; a block type
 * outside {@link KNOWN_BLOCK_TYPES} contributes no row either, but is flagged via
 * `hasUnknownBlock` so the caller can tell "deliberately skipped" apart from "never seen before".
 */
function buildRows(
    content: unknown,
    uuid: string,
    sessionId: string,
    role: DistillRole,
    ts: number | undefined,
    ctx: DistillContext,
): BuildRowsResult {
    const rows: DistillRow[] = [];

    // 1. A plain string content is always exactly one prose row; there is no block to classify.
    if (typeof content === "string") {
        rows.push(makeRow(`${uuid}:prose`, sessionId, ts, role, "prose", ctx, content));
        return { rows, hasUnknownBlock: false };
    }

    // 2. Any other non-array shape is not one the distiller recognizes at all.
    if (!Array.isArray(content)) {
        return { rows, hasUnknownBlock: true };
    }

    const blocks = content as readonly ContentBlock[];

    // 3. Concatenate every text block into at most one prose row, while flagging any block type
    //    outside the known inventory (`document` being the real-corpus example).
    let hasUnknownBlock = false;
    const proseParts: string[] = [];
    for (const block of blocks) {
        if (typeof block.type !== "string" || !KNOWN_BLOCK_TYPES.has(block.type)) {
            hasUnknownBlock = true;
        }
        if (block.type === "text" && typeof block.text === "string") {
            proseParts.push(block.text);
        }
    }
    if (proseParts.length > 0) {
        rows.push(makeRow(`${uuid}:prose`, sessionId, ts, role, "prose", ctx, proseParts.join("\n")));
    }

    // 4. One tool_use row per tool_use block, one tool_error row per failed tool_result block.
    //    `thinking`, `image`, and successful `tool_result` blocks contribute nothing.
    blocks.forEach((block, index) => {
        if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "";
            if (isSelfReferentialToolCall(name)) {
                return;
            }
            const rendered = renderToolUseInput(block.input);
            const body = rendered.length > 0 ? `${name} ${rendered}` : name;
            rows.push(makeRow(`${uuid}:tool_use:${index}`, sessionId, ts, role, "tool_use", ctx, body));
            return;
        }

        if (block.type === "tool_result" && block.is_error === true) {
            const body = extractToolResultText(block.content);
            rows.push(makeRow(`${uuid}:tool_error:${index}`, sessionId, ts, role, "tool_error", ctx, body));
        }
    });

    return { rows, hasUnknownBlock };
}

/**
 * Maps one raw transcript line to zero or more indexable rows. See the module docblock for the
 * full outcome set. Two boundaries matter here: an unrecognized record `type` is `control`, never
 * `quarantine`, so a future release's new record type cannot flood the quarantine table; and a
 * `user` or `assistant` line that yields no row is `skipped` when every block present is a KNOWN,
 * deliberately-unindexed type, or `quarantine` when a block type is not recognized at all, because
 * the archive outlives its source transcript and a wrongly-skipped conversational line is lost for
 * good.
 */
export function distillLine(line: string, ctx: DistillContext): DistillOutcome {
    // 1. The cheap prefilter: anything that cannot be `user` or `assistant` is control by
    //    construction, with no JSON.parse paid for it.
    if (!looksLikeConversationalLine(line)) {
        return { outcome: "control" };
    }

    // 2. Only now pay for JSON.parse. A malformed line here is quarantined, not discarded.
    let parsed: ParsedLine;
    try {
        parsed = JSON.parse(line) as ParsedLine;
    } catch {
        return { outcome: "quarantine", raw: line };
    }

    // 3. Guard against the substring prefilter matching text nested inside an unrelated record,
    //    for example a control record whose own payload happens to quote `"type":"user"`.
    if (parsed.type !== "user" && parsed.type !== "assistant") {
        return { outcome: "control" };
    }
    const role = parsed.type as DistillRole;

    if (typeof parsed.uuid !== "string" || typeof parsed.sessionId !== "string") {
        return { outcome: "quarantine", raw: line };
    }

    const parsedTs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    const ts = Number.isNaN(parsedTs) ? undefined : parsedTs;
    const { rows, hasUnknownBlock } = buildRows(parsed.message?.content, parsed.uuid, parsed.sessionId, role, ts, ctx);

    // 4. A conversational line that yields no row is either `skipped` or `quarantine`, and WHY it
    //    yielded nothing is what decides between them. Every block present being a KNOWN,
    //    deliberately-unindexed type (image-only, successful-tool-result-only, thinking-only) is
    //    `skipped`: counted, never stored, because this is the ordinary shape of most turns. A
    //    block type outside the known inventory is `quarantine`, because it may be prose lost
    //    forever once `cleanupPeriodDays` takes the source transcript.
    if (rows.length === 0) {
        return hasUnknownBlock ? { outcome: "quarantine", raw: line } : { outcome: "skipped" };
    }

    return { outcome: "rows", rows };
}

// ---------------------------------------------------------------------------
// Session metadata: title and first-prompt resolution, copying readLiteMetadata's contract
// ---------------------------------------------------------------------------

/** Unescapes a JSON string value that was extracted as raw text rather than through a full parse. */
function unescapeJsonString(raw: string): string {
    if (!raw.includes("\\")) {
        return raw;
    }
    try {
        return JSON.parse(`"${raw}"`) as string;
    } catch {
        return raw;
    }
}

/**
 * Scans `text` for the first `"key":"value"` (or `"key": "value"`) occurrence without a full
 * parse, so it keeps working on a head or tail chunk that may be truncated mid-object.
 */
function extractJsonStringField(text: string, key: string): string | undefined {
    for (const pattern of [`"${key}":"`, `"${key}": "`]) {
        const idx = text.indexOf(pattern);
        if (idx < 0) {
            continue;
        }

        const valueStart = idx + pattern.length;
        let i = valueStart;
        while (i < text.length) {
            if (text[i] === "\\") {
                i += 2;
                continue;
            }
            if (text[i] === '"') {
                return unescapeJsonString(text.slice(valueStart, i));
            }
            i++;
        }
    }
    return undefined;
}

/**
 * Like {@link extractJsonStringField} but returns the LAST occurrence, for fields appended over a
 * session's life (`customTitle`, `aiTitle`, `tag`, `lastPrompt`).
 */
function extractLastJsonStringField(text: string, key: string): string | undefined {
    let lastValue: string | undefined;
    for (const pattern of [`"${key}":"`, `"${key}": "`]) {
        let searchFrom = 0;
        while (true) {
            const idx = text.indexOf(pattern, searchFrom);
            if (idx < 0) {
                break;
            }

            const valueStart = idx + pattern.length;
            let i = valueStart;
            while (i < text.length) {
                if (text[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (text[i] === '"') {
                    lastValue = unescapeJsonString(text.slice(valueStart, i));
                    break;
                }
                i++;
            }
            searchFrom = i + 1;
        }
    }
    return lastValue;
}

/**
 * Like {@link extractJsonStringField} but returns up to `maxLen` characters of the value even when
 * the closing quote is missing, because the head or tail buffer can end mid-string. Newline and
 * tab escapes fold to spaces and the result is trimmed.
 */
function extractJsonStringFieldPrefix(text: string, key: string, maxLen: number): string {
    for (const pattern of [`"${key}":"`, `"${key}": "`]) {
        const idx = text.indexOf(pattern);
        if (idx < 0) {
            continue;
        }

        const valueStart = idx + pattern.length;
        let i = valueStart;
        let collected = 0;
        while (i < text.length && collected < maxLen) {
            if (text[i] === "\\") {
                i += 2;
                collected++;
                continue;
            }
            if (text[i] === '"') {
                break;
            }
            i++;
            collected++;
        }
        const raw = text.slice(valueStart, i);
        return raw.replace(/\\n/g, " ").replace(/\\t/g, " ").trim();
    }
    return "";
}

/**
 * Matches an auto-generated or system message opener: a lowercase XML-like tag or a synthetic
 * interrupt marker, skipped when hunting for the first meaningful user prompt.
 */
const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;

/**
 * Scans a head chunk for the first meaningful user prompt, skipping `tool_result`, `isMeta` and
 * `isCompactSummary` lines plus command-name wrapper tags, copying `extractFirstPromptFromHead`'s
 * skip rules (`references/claude-code-cli-source-code/utils/sessionStoragePortable.ts:135-200`).
 */
function extractFirstPromptFromChunk(chunk: string): string {
    let start = 0;
    let commandFallback = "";

    while (start < chunk.length) {
        const newlineIdx = chunk.indexOf("\n", start);
        const line = newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start);
        start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length;

        if (!line.includes(USER_TYPE_MARKER)) {
            continue;
        }
        if (line.includes('"tool_result"')) {
            continue;
        }
        if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) {
            continue;
        }
        if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) {
            continue;
        }

        let entry: ParsedLine;
        try {
            entry = JSON.parse(line) as ParsedLine;
        } catch {
            continue;
        }
        if (entry.type !== "user") {
            continue;
        }

        const content = entry.message?.content;
        const texts: string[] = [];
        if (typeof content === "string") {
            texts.push(content);
        } else if (Array.isArray(content)) {
            for (const block of content as readonly ContentBlock[]) {
                if (block.type === "text" && typeof block.text === "string") {
                    texts.push(block.text);
                }
            }
        }

        for (const raw of texts) {
            let result = raw.replace(/\n/g, " ").trim();
            if (!result) {
                continue;
            }

            const cmdMatch = COMMAND_NAME_RE.exec(result);
            if (cmdMatch !== null) {
                if (!commandFallback && cmdMatch[1] !== undefined) {
                    commandFallback = cmdMatch[1];
                }
                continue;
            }

            if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
                continue;
            }

            if (result.length > 200) {
                result = `${result.slice(0, 200).trim()}…`;
            }
            return result;
        }
    }

    return commandFallback;
}

/**
 * Resolves a session's title and first prompt from its head and tail byte windows, copying Claude
 * Code's own `readLiteMetadata` contract exactly
 * (`references/claude-code-cli-source-code/utils/sessionStorage.ts:4740-4805`), operator choice
 * included: the title chain uses `??` so an extractor returning `undefined` (never an empty
 * string) falls through, while the first-prompt chain uses `||` with four fallbacks so an
 * extractor returning an empty string correctly continues to the next one.
 */
export function resolveSessionMeta(head: string, tail: string): SessionMeta {
    const title =
        extractLastJsonStringField(tail, "customTitle") ??
        extractLastJsonStringField(head, "customTitle") ??
        extractLastJsonStringField(tail, "aiTitle") ??
        extractLastJsonStringField(head, "aiTitle");

    const firstPrompt =
        extractLastJsonStringField(tail, "lastPrompt") ||
        extractFirstPromptFromChunk(head) ||
        extractJsonStringFieldPrefix(head, "content", 200) ||
        extractJsonStringFieldPrefix(head, "text", 200) ||
        "";

    const projectPath = extractJsonStringField(head, "cwd");

    return { title, firstPrompt, projectPath };
}
