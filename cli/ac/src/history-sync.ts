import { open, readdir, stat as statAsync } from "node:fs/promises";
import { readFile as readFileAsync } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { decideRead, fingerprint, splitDelta } from "./history-cursor.ts";
import { distillLine, resolveSessionMeta } from "./history-distill.ts";
import type { DistillContext, DistillRow } from "./history-distill.ts";
import type {
    HistoryIngestRequest,
    HistoryQuarantineEntry,
    HistorySessionRecord,
    HistoryStore,
} from "./history-store.ts";

/**
 * The walk-plus-freshness-plus-incremental-ingest driver: `syncArchive` composes Step 4's read
 * decisions, Step 5's distiller and Step 7's store writes into one loop over every `*.jsonl`
 * transcript under a projects root.
 *
 * Both the filesystem and the store arrive injected through {@link HistorySyncOptions}, and this
 * module holds only an `import type` of `HistoryStore`, never a value import, so the `bun test`
 * suite can drive the whole loop against a fake store with no `node:sqlite` in the process.
 */

/** The window size Claude Code's own `readLiteMetadata` uses for both the head and tail probe. */
const HEAD_WINDOW_BYTES = 65536;
const TAIL_WINDOW_BYTES = 65536;

/** One file's size and last-modified time, the two facts `decideRead` and the mtime sort need. */
export interface HistoryFileStat {
    readonly size: number;
    readonly mtimeMs: number;
}

/** The subagent metadata a `.meta.json` sibling supplies, when it exists. */
export interface HistorySubagentMeta {
    readonly agentType: string | undefined;
    readonly description: string | undefined;
}

export type ListSessionFilesFn = (root: string) => Promise<readonly string[]>;
export type StatFileFn = (path: string) => Promise<HistoryFileStat>;
export type ReadFileRangeFn = (path: string, start: number, end: number) => Promise<Buffer>;
export type ReadSubagentMetaFn = (metaPath: string) => Promise<HistorySubagentMeta | undefined>;

/** Injected collaborators, so a test drives the whole loop against the Step 1 fixture with no IO against `~/.claude`. */
export interface HistorySyncDeps {
    readonly listSessionFiles?: ListSessionFilesFn;
    readonly statFile?: StatFileFn;
    readonly readFileRange?: ReadFileRangeFn;
    readonly readSubagentMeta?: ReadSubagentMetaFn;
}

/** What one `syncArchive` call needs: where to walk, which store to write to, and optional tuning. */
export interface HistorySyncOptions {
    readonly root: string;
    readonly store: HistoryStore;
    readonly fs?: HistorySyncDeps;
    /**
     * Bounds how many of the discovered files this pass processes, applied AFTER the mtime-
     * descending sort. The prior art (`claude-historian` issue #70) applied its cap before the
     * sort and silently dropped the most recently modified sessions; this option exists so a
     * future bounded call (a CLI `--limit` flag, for instance) cannot repeat that mistake.
     */
    readonly maxFiles?: number;
    /** Overrides {@link HEAD_WINDOW_BYTES} for tests; production callers should leave this unset. */
    readonly headWindowBytes?: number;
    /** Overrides {@link TAIL_WINDOW_BYTES} for tests; production callers should leave this unset. */
    readonly tailWindowBytes?: number;
}

/** What one `syncArchive` pass accomplished. */
export interface HistorySyncReport {
    readonly filesScanned: number;
    readonly filesVanished: number;
    /**
     * Files whose own read failed with a filesystem error other than `ENOENT` (a permission
     * failure, an IO error), counted so one unreadable transcript degrades that file rather than
     * failing the whole pass and, through it, the search that triggered the pass. Optional for the
     * same reason as {@link HistorySyncReport.skipped}: a report literal written before this field
     * existed, in another module's test, still type-checks. `syncArchive` always sets it.
     */
    readonly filesFailed?: number;
    readonly rowsAdded: number;
    readonly quarantined: number;
    /**
     * Lines whose every block was a type the distiller KNOWS and deliberately does not index
     * (`thinking`, `image`, a successful `tool_result`). Counted here, never handed to the store
     * as a {@link HistoryQuarantineEntry}: conflating the two is the defect that once turned a
     * 296 MB archive into 4 GB. Optional so a report literal built before this field existed
     * (a fake `syncArchive` stub in another step's test) still type-checks; `syncArchive` itself
     * always sets it.
     */
    readonly skipped?: number;
    readonly redactions: number;
    readonly elapsedMillis: number;
    readonly changed: boolean;
}

/**
 * Reads the `code` off a thrown value, without an `any` cast, when it looks like a POSIX errno.
 *
 * The shape test matters more than it looks. A `libuv` errno is `ENOENT`, `EACCES`, `EIO`: capital
 * letters and digits only. Node's OWN error codes are also strings on the same property and also
 * start with `E`, `ERR_SQLITE_ERROR` among them, so a per-file catch that classified on the mere
 * presence of `code` would swallow a malformed-archive failure from the store and report it as one
 * unreadable transcript. The underscore is what separates the two families.
 */
function errnoCode(err: unknown): string | undefined {
    if (typeof err !== "object" || err === null || !("code" in err)) {
        return undefined;
    }

    const code = (err as { code?: unknown }).code;

    return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
}

function isEnoentError(err: unknown): boolean {
    return errnoCode(err) === "ENOENT";
}

/** Recursively lists every `*.jsonl` file's absolute path under `root`, depth-first. */
async function defaultListSessionFiles(root: string): Promise<readonly string[]> {
    const results: string[] = [];

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (isEnoentError(err)) {
                return;
            }
            throw err;
        }

        for (const entry of entries) {
            const entryPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(entryPath);
            } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                results.push(entryPath);
            }
        }
    }

    await walk(root);
    return results;
}

async function defaultStatFile(path: string): Promise<HistoryFileStat> {
    const stats = await statAsync(path);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
}

/** Reads the byte range `[start, end)` from `path` through a single file handle. */
async function defaultReadFileRange(path: string, start: number, end: number): Promise<Buffer> {
    const length = Math.max(0, end - start);
    if (length === 0) {
        return Buffer.alloc(0);
    }

    const handle = await open(path, "r");
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/**
 * Reads a subagent transcript's sibling `.meta.json`; a missing file is not an error, just no label.
 *
 * An unparseable file is not an error either, and that is a deliberate decision rather than a
 * swallowed failure: this file is read while another Claude Code session may be writing it as it
 * spawns subagents, so half a JSON document is a routine race. The worst outcome of ignoring it is
 * one subagent's rows carrying no `agentType`; the worst outcome of throwing is a whole sync pass,
 * and the search that triggered it, failing over a label. Only a `SyntaxError` is treated this way;
 * anything else `JSON.parse` could throw propagates.
 */
async function defaultReadSubagentMeta(metaPath: string): Promise<HistorySubagentMeta | undefined> {
    let raw: string;
    try {
        raw = await readFileAsync(metaPath, "utf8");
    } catch (err) {
        if (isEnoentError(err)) {
            return undefined;
        }
        throw err;
    }

    let parsed: { agentType?: unknown; description?: unknown };
    try {
        parsed = JSON.parse(raw) as { agentType?: unknown; description?: unknown };
    } catch (err) {
        if (err instanceof SyntaxError) {
            return undefined;
        }
        throw err;
    }

    return {
        agentType: typeof parsed.agentType === "string" ? parsed.agentType : undefined,
        description: typeof parsed.description === "string" ? parsed.description : undefined,
    };
}

/** One file's identity, worked out from its path shape alone, with no content read required. */
interface ClassifiedTranscript {
    readonly path: string;
    readonly isSubagent: boolean;
    readonly transcriptKey: string;
    readonly sessionId: string;
    readonly metaPath: string | undefined;
}

/**
 * Classifies a `*.jsonl` path as a main transcript or a nested subagent transcript, and derives
 * the manifest key and the session id purely from the path shape.
 *
 * The `subagents/` PATH POSITION is the signal, not the filename pattern: a subagent id is
 * measured to be 17 characters starting with `a`, never a UUID, but keying detection on that
 * shape would be fragile against a future id format. A subagent transcript's `sessionId` is the
 * PARENT session id, recovered from the directory two levels up
 * (`<project>/<session-id>/subagents/agent-<id>.jsonl`), because a subagent transcript's own
 * lines carry their parent's session id, not one of their own.
 *
 * **The manifest key identifies a FILE, not a session, and that correction is the whole point of
 * this function taking `root`.** A byte cursor is only meaningful against one specific file, and a
 * session id does not name one: measured live on this machine, the session uuid
 * `3e19ee0b-d0bb-4aa1-9052-6ed71f290745` exists as a transcript under BOTH
 * `-Users-anilcan-Code-tools-myco-backup` (6,082,328 bytes) and `-Users-anilcan-Code-tools-myco`
 * (29,622 bytes). Sharing one manifest row between them has each pass read a cursor belonging to
 * the other file, and either flips that row forever (a 6 MB transcript re-read and re-distilled on
 * every single tool call) or, when the two files share their 64 KB head, starts an
 * `append-from-cursor` read mid-line in the other file and loses every line between the two cursors
 * with no error anywhere.
 *
 * The key is therefore the path RELATIVE to the walked root, not the absolute path: relocating the
 * whole `~/.claude` tree (`CLAUDE_CONFIG_DIR` points somewhere else) then keeps every key valid.
 * The plan's earlier "never key on the file path" rule rested on `"type":"relocated"` records
 * moving a session's directory, and that premise is measured false: a relocation writes
 * `{"type":"relocated","relocatedCwd":...}` INTO the existing transcript and leaves the file where
 * it is (verified on `-Users-anilcan-Code-fluttersdk-uptizm/3e57c0f1-...jsonl`, whose relocated cwd
 * has no project directory of its own), and the reference implementation never renames a transcript.
 * `dev:ino` from `stat` was the other candidate and is rejected in the report: it cannot survive a
 * backup restore, it inherits a stale cursor when an inode is recycled after a `cleanupPeriodDays`
 * deletion, and it would force `HistoryFileStat` to grow two fields that every injected `statFile`
 * fake in the suite would have to supply.
 */
function classifyTranscript(path: string, root: string): ClassifiedTranscript {
    const parentDir = dirname(path);
    const fileBase = basename(path, ".jsonl");
    const transcriptKey = relative(root, path);

    if (basename(parentDir) === "subagents") {
        return {
            path,
            isSubagent: true,
            transcriptKey,
            sessionId: basename(dirname(parentDir)),
            metaPath: join(parentDir, `${fileBase}.meta.json`),
        };
    }

    return {
        path,
        isSubagent: false,
        transcriptKey,
        sessionId: fileBase,
        metaPath: undefined,
    };
}

/** One file that stat succeeded on, paired with its stat, awaiting the mtime sort. */
interface StatedFile {
    readonly path: string;
    readonly stat: HistoryFileStat;
}

/**
 * Walks `root`, stats every discovered `*.jsonl` file, and returns them sorted by mtime
 * descending. A file that vanishes between the walk and its stat (a genuine race: a
 * `cleanupPeriodDays` sweep, a `relocated` move) is counted rather than treated as fatal; any
 * other stat failure propagates, because a narrow catch here must re-throw what it does not
 * recognize.
 */
async function walkAndStat(
    root: string,
    listSessionFiles: ListSessionFilesFn,
    statFile: StatFileFn,
): Promise<{ readonly files: readonly StatedFile[]; readonly vanished: number }> {
    const candidates = await listSessionFiles(root);
    const files: StatedFile[] = [];
    let vanished = 0;

    for (const path of candidates) {
        try {
            const stat = await statFile(path);
            files.push({ path, stat });
        } catch (err) {
            if (isEnoentError(err)) {
                vanished += 1;
                continue;
            }
            throw err;
        }
    }

    // Sort by mtime descending BEFORE any cap is applied. Capping first (the
    // `claude-historian` issue #70 bug) would keep whichever files the walk happened to list
    // first and silently drop the most recently modified sessions.
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return { files, vanished };
}

/** What {@link processFile} accomplished for one transcript, folded into the pass totals by the caller. */
interface ProcessedFile {
    readonly ingested: boolean;
    readonly rowsAdded: number;
    readonly quarantined: number;
    readonly skipped: number;
    readonly redactions: number;
}

/** Sums every redaction count across every kind into one total for the report. */
function sumRedactionCounts(redactions: Partial<Record<string, number>>): number {
    let total = 0;
    for (const count of Object.values(redactions)) {
        total += count ?? 0;
    }
    return total;
}

/**
 * Processes one file: decides how much to read, distills the lines it gets, and hands the
 * result to the store in a single ingest call.
 *
 * The head fingerprint fed to `decideRead` is windowed against the file's PRIOR cursor, not its
 * current size: for a file smaller than {@link HEAD_WINDOW_BYTES}, windowing against current
 * size would pull newly appended bytes into the "head" on every pass, changing the fingerprint
 * on every legitimate append and forcing a full re-read forever. Windowing against the prior
 * cursor instead reads only bytes already known stable, so a clean append never perturbs it. The
 * fingerprint that gets STORED for the next comparison is windowed against the cursor this pass
 * produces, so the next pass's decision window lines up exactly with what was stored here.
 */
async function processFile(
    file: StatedFile,
    store: HistoryStore,
    deps: {
        readonly root: string;
        readonly readFileRange: ReadFileRangeFn;
        readonly readSubagentMeta: ReadSubagentMetaFn;
        readonly headWindowBytes: number;
        readonly tailWindowBytes: number;
    },
): Promise<ProcessedFile> {
    const classified = classifyTranscript(file.path, deps.root);
    const manifestEntry = store.getManifestEntry(classified.transcriptKey);
    const priorCursor = manifestEntry?.cursor ?? 0;

    // 1. Decision-time head window: anchored to the prior cursor (or the whole file, on a first
    //    ingest, where decideRead ignores the fingerprint anyway) so growth past it never
    //    perturbs the up-to-date comparison.
    const decisionHeadLength = Math.min(
        deps.headWindowBytes,
        manifestEntry === undefined ? file.stat.size : priorCursor,
    );
    const decisionHeadBuffer = await deps.readFileRange(file.path, 0, decisionHeadLength);
    const decisionHeadFingerprint = fingerprint(decisionHeadBuffer);

    const decision = decideRead(manifestEntry, {
        size: file.stat.size,
        headFingerprint: decisionHeadFingerprint,
    });

    if (decision === "up-to-date") {
        return { ingested: false, rowsAdded: 0, quarantined: 0, skipped: 0, redactions: 0 };
    }

    // 2. Read only what is needed: the delta from the cursor when appending, the whole file on
    //    a full re-read.
    const readStart = decision === "append-from-cursor" ? priorCursor : 0;
    const bodyBuffer = await deps.readFileRange(file.path, readStart, file.stat.size);
    const { lines, advanceBy } = splitDelta(bodyBuffer, false);
    const newCursor = readStart + advanceBy;

    // 3. A non-up-to-date decision does not guarantee new content: a file whose only unconsumed
    //    bytes are still a torn, newline-less tail advances by zero every single pass. Skip the
    //    write entirely rather than re-ingesting nothing forever.
    if (lines.length === 0 && newCursor === priorCursor) {
        return { ingested: false, rowsAdded: 0, quarantined: 0, skipped: 0, redactions: 0 };
    }

    // 4. Storage-time head window: anchored to the NEW cursor, so the next pass's decision
    //    window (bounded by the manifest's now-updated cursor) reads back these exact bytes.
    const storageHeadLength = Math.min(deps.headWindowBytes, newCursor);
    const storageHeadBuffer = storageHeadLength === decisionHeadLength
        ? decisionHeadBuffer
        : await deps.readFileRange(file.path, 0, storageHeadLength);
    const storageHeadFingerprint = fingerprint(storageHeadBuffer);

    // 5. Resolve session metadata (title, first prompt, project path) from head and tail
    //    windows, reusing the head buffer already in hand for a small file.
    const tailLength = Math.min(deps.tailWindowBytes, file.stat.size);
    const tailStart = Math.max(0, file.stat.size - tailLength);
    const tailBuffer = await deps.readFileRange(file.path, tailStart, file.stat.size);
    const meta = resolveSessionMeta(storageHeadBuffer.toString("utf8"), tailBuffer.toString("utf8"));

    // 6. The subagent label comes from the sibling `.meta.json`, never from a per-row field.
    const subagentMeta = classified.isSubagent && classified.metaPath !== undefined
        ? await deps.readSubagentMeta(classified.metaPath)
        : undefined;

    const ctx: DistillContext = {
        projectPath: meta.projectPath ?? "",
        isSubagent: classified.isSubagent,
        agentType: subagentMeta?.agentType,
    };

    const rows: DistillRow[] = [];
    const quarantined: HistoryQuarantineEntry[] = [];
    let skippedLines = 0;
    for (const line of lines) {
        const outcome = distillLine(line, ctx);
        if (outcome.outcome === "rows") {
            rows.push(...outcome.rows);
        } else if (outcome.outcome === "skipped") {
            // A block type the distiller KNOWS and deliberately does not index. Counted here,
            // never handed to the store: quarantining these is the defect this fixture's
            // correction exists to catch.
            skippedLines += 1;
        } else if (outcome.outcome === "quarantine") {
            quarantined.push({
                sessionId: classified.sessionId,
                projectPath: ctx.projectPath,
                sourcePath: file.path,
                raw: outcome.raw,
            });
        }
    }

    // 7. A subagent transcript shares its parent's session id, so it must never write a session
    //    record: doing so would overwrite the parent MAIN session's already-resolved title with
    //    a subagent transcript's own (usually empty) title chain.
    const session: HistorySessionRecord | undefined = classified.isSubagent
        ? undefined
        : {
            sessionId: classified.sessionId,
            projectPath: meta.projectPath,
            title: meta.title,
            firstPrompt: meta.firstPrompt,
            mtime: file.stat.mtimeMs,
            isSubagent: false,
            agentType: undefined,
        };

    const request: HistoryIngestRequest = {
        transcriptKey: classified.transcriptKey,
        sessionId: classified.sessionId,
        priorCursor,
        cursor: newCursor,
        headFingerprint: storageHeadFingerprint,
        rows,
        quarantined,
        session,
    };

    const result = store.ingest(request);
    return {
        ingested: true,
        rowsAdded: result.rowsAdded,
        quarantined: result.quarantined,
        skipped: skippedLines,
        redactions: sumRedactionCounts(result.redactions),
    };
}

/**
 * Walks a Claude Code projects root, decides which files need reading, distills their new lines
 * and hands them to the store, all inside one pass.
 *
 * @param opts The root to walk, the store to write into, and optional filesystem injection plus
 *             tuning knobs.
 * @returns A report of how much work this pass did and whether anything actually changed.
 */
export async function syncArchive(opts: HistorySyncOptions): Promise<HistorySyncReport> {
    const startedAt = Date.now();
    const listSessionFiles = opts.fs?.listSessionFiles ?? defaultListSessionFiles;
    const statFile = opts.fs?.statFile ?? defaultStatFile;
    const readFileRange = opts.fs?.readFileRange ?? defaultReadFileRange;
    const readSubagentMeta = opts.fs?.readSubagentMeta ?? defaultReadSubagentMeta;
    const headWindowBytes = opts.headWindowBytes ?? HEAD_WINDOW_BYTES;
    const tailWindowBytes = opts.tailWindowBytes ?? TAIL_WINDOW_BYTES;

    const { files, vanished } = await walkAndStat(opts.root, listSessionFiles, statFile);
    const selected = opts.maxFiles === undefined ? files : files.slice(0, opts.maxFiles);

    let rowsAdded = 0;
    let quarantined = 0;
    let skipped = 0;
    let redactions = 0;
    let changed = false;
    let vanishedMidRead = 0;
    let failed = 0;

    for (const file of selected) {
        let outcome: ProcessedFile;
        try {
            outcome = await processFile(file, opts.store, {
                root: opts.root,
                readFileRange,
                readSubagentMeta,
                headWindowBytes,
                tailWindowBytes,
            });
        } catch (err) {
            // One file's filesystem failure is that file's failure. Both causes are reachable
            // rather than theoretical: a `cleanupPeriodDays` sweep takes a transcript between the
            // walk and the read (`ENOENT`, counted exactly as a stat-time disappearance is), and a
            // read can fail outright (`EACCES`, `EIO`). Anything that is not a POSIX errno is a
            // store or programming failure and must take the pass down rather than be counted: the
            // store already decides for itself which of its failures are degraded (`busy`) and
            // which are fatal, and burying a fatal one here would hide a broken archive.
            const code = errnoCode(err);
            if (code === undefined) {
                throw err;
            }
            if (code === "ENOENT") {
                vanishedMidRead += 1;
            } else {
                failed += 1;
            }
            continue;
        }

        if (outcome.ingested) {
            changed = true;
        }
        rowsAdded += outcome.rowsAdded;
        quarantined += outcome.quarantined;
        skipped += outcome.skipped;
        redactions += outcome.redactions;
    }

    return {
        filesScanned: selected.length,
        filesVanished: vanished + vanishedMidRead,
        filesFailed: failed,
        rowsAdded,
        quarantined,
        skipped,
        redactions,
        elapsedMillis: Date.now() - startedAt,
        changed,
    };
}
