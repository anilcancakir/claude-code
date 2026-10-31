import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import type { Dirent, FSWatcher, Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Largest header block accepted before the parser gives up on framing, in bytes. */
export const MAX_HEADER_BYTES: number = 64 * 1024;

/** Largest declared body accepted before the parser gives up on framing, in bytes. */
export const MAX_BODY_BYTES: number = 64 * 1024 * 1024;

const HEADER_TERMINATOR: string = "\r\n\r\n";
const DIRECTORY_DEBOUNCE_MS: number = 150;
const WATCH_BATCH_MS: number = 300;
const LOG_PREFIX: string = "[ac-lsp-proxy]";

/**
 * One unit of client input. A `message` is a complete frame whose `raw` bytes are exactly what
 * arrived (header and body); a `raw` event carries bytes forwarded without framing once the parser
 * has fallen back to passthrough.
 */
export type FrameEvent =
    | { kind: "message"; raw: Buffer; body: Buffer }
    | { kind: "raw"; raw: Buffer };

/**
 * Incremental `Content-Length` framing parser for one byte stream.
 *
 * Contract: every byte pushed comes back out exactly once, in order, either inside a `message`
 * event or a `raw` event, except the tail of an incomplete frame, which `drain` hands back.
 * On a malformed header or one past the caps it switches to raw passthrough for good and records
 * the reason in `failure`; it never throws and never withholds bytes after that point.
 */
export class FrameParser {
    /** Why framing was abandoned, set once when the parser enters passthrough. */
    public failure: string | undefined;

    private chunks: Buffer[] = [];
    private length: number = 0;
    private frameLength: number | undefined;
    private bodyStart: number = 0;

    public push(chunk: Buffer): FrameEvent[] {
        if (this.failure !== undefined) {
            return [
                {
                    kind: "raw",
                    raw: chunk,
                },
            ];
        }

        this.chunks.push(chunk);
        this.length += chunk.length;
        const events: FrameEvent[] = [];

        // Concatenation is deferred until a whole frame is buffered so a large body arriving in many
        // chunks is copied once rather than once per chunk.
        while (this.length > 0 && (this.frameLength === undefined || this.length >= this.frameLength)) {
            const buffer = this.collapse();

            if (this.frameLength === undefined) {
                const failure = this.readHeader(buffer);
                if (failure !== undefined) {
                    return [...events, this.abandon(failure)];
                }
                if (this.frameLength === undefined) {
                    break;
                }
                continue;
            }

            events.push({
                kind: "message",
                raw: buffer.subarray(0, this.frameLength),
                body: buffer.subarray(this.bodyStart, this.frameLength),
            });
            const rest = buffer.subarray(this.frameLength);
            this.chunks = rest.length > 0 ? [rest] : [];
            this.length = rest.length;
            this.frameLength = undefined;
        }

        return events;
    }

    /** Returns and forgets the buffered bytes of an incomplete frame, for forwarding at end of input. */
    public drain(): Buffer {
        const rest = this.collapse();
        this.chunks = [];
        this.length = 0;
        this.frameLength = undefined;
        return rest;
    }

    /** Sets `frameLength` when a full header is buffered; returns a failure reason when it is unusable. */
    private readHeader(buffer: Buffer): string | undefined {
        const end = buffer.indexOf(HEADER_TERMINATOR);
        if (end === -1) {
            return buffer.length > MAX_HEADER_BYTES ? "header block exceeds 64 KiB" : undefined;
        }
        if (end > MAX_HEADER_BYTES) {
            return "header block exceeds 64 KiB";
        }

        let contentLength: number | undefined;
        for (const line of buffer.subarray(0, end).toString("latin1").split("\r\n")) {
            const colon = line.indexOf(":");
            if (colon === -1) {
                return `malformed header line "${line.slice(0, 80)}"`;
            }
            if (line.slice(0, colon).trim().toLowerCase() !== "content-length") {
                continue;
            }
            const value = line.slice(colon + 1).trim();
            if (!/^\d+$/.test(value)) {
                return `malformed Content-Length "${value.slice(0, 80)}"`;
            }
            contentLength = Number(value);
        }

        if (contentLength === undefined) {
            return "header block without Content-Length";
        }
        if (contentLength > MAX_BODY_BYTES) {
            return "body exceeds 64 MiB";
        }

        this.bodyStart = end + HEADER_TERMINATOR.length;
        this.frameLength = this.bodyStart + contentLength;
        return undefined;
    }

    private abandon(reason: string): FrameEvent {
        this.failure = reason;
        return {
            kind: "raw",
            raw: this.drain(),
        };
    }

    private collapse(): Buffer {
        if (this.chunks.length !== 1) {
            this.chunks = [Buffer.concat(this.chunks, this.length)];
        }
        return this.chunks[0]!;
    }
}

/** Wraps a JSON body in one `Content-Length` frame, so a single `write` carries a whole message. */
export function frameMessage(body: string): Buffer {
    const bytes = Buffer.from(body, "utf8");
    return Buffer.concat([
        Buffer.from(`Content-Length: ${bytes.length}${HEADER_TERMINATOR}`, "latin1"),
        bytes,
    ]);
}

/** LSP position: zero-based line and UTF-16 code unit offset, which is a JS string index. */
interface Position {
    line: number;
    character: number;
}

/** One `contentChanges` entry: a range edit, or a full replacement when `range` is absent. */
export interface ContentChange {
    range?: {
        start: Position;
        end: Position;
    };
    text: string;
}

/**
 * Applies a `didChange` change list in order. Line breaks are `\n`, `\r\n` or `\r` as LSP defines;
 * a character past the line end clamps to the line end and a line past the end clamps to the text end.
 */
export function applyContentChanges(text: string, changes: ContentChange[]): string {
    let current = text;
    for (const change of changes) {
        if (change.range === undefined) {
            current = change.text;
            continue;
        }
        const start = offsetAt(current, change.range.start);
        const end = offsetAt(current, change.range.end);
        current = current.slice(0, start) + change.text + current.slice(Math.max(start, end));
    }
    return current;
}

function offsetAt(text: string, position: Position): number {
    let lineStart = 0;
    for (let line = 0; line < position.line; line++) {
        const breakAt = nextLineBreak(text, lineStart);
        if (breakAt === -1) {
            return text.length;
        }
        lineStart = breakAt + (text.startsWith("\r\n", breakAt) ? 2 : 1);
    }
    const lineEnd = nextLineBreak(text, lineStart);
    const limit = lineEnd === -1 ? text.length : lineEnd;
    return Math.min(lineStart + Math.max(position.character, 0), limit);
}

function nextLineBreak(text: string, from: number): number {
    for (let index = from; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 10 || code === 13) {
            return index;
        }
    }
    return -1;
}

/** Last observed modification time (ms) and size (bytes) of a file. */
export interface FileStamp {
    mtimeMs: number;
    size: number;
}

/**
 * A document the client holds open. `path` is set only for `file:` URIs; `stamp` is the disk state
 * at the last sweep that looked, undefined until the first one, so the first sweep always reads.
 */
export interface TrackedDocument {
    uri: string;
    path: string | undefined;
    text: string;
    version: number;
    stamp: FileStamp | undefined;
}

/** The subset of a JSON-RPC message the proxy reads; every field is optional because nothing is validated. */
export interface ClientMessage {
    method?: unknown;
    params?: any;
}

/**
 * The client's view of open documents, rebuilt from the didOpen, didChange and didClose it sends.
 * `version` is the highest version seen from the client or from a synthetic didChange, so a
 * synthetic version is always above anything the server has been told.
 */
export class DocumentTable {
    private readonly documents: Map<string, TrackedDocument> = new Map();

    public apply(message: ClientMessage): void {
        const textDocument = message.params?.textDocument;
        const uri: unknown = textDocument?.uri;
        if (typeof uri !== "string") {
            return;
        }

        switch (message.method) {
            case "textDocument/didOpen":
                this.documents.set(uri, {
                    uri,
                    path: filePathOf(uri),
                    text: String(textDocument.text ?? ""),
                    version: Number(textDocument.version ?? 0),
                    stamp: undefined,
                });
                return;
            case "textDocument/didChange": {
                const document = this.documents.get(uri);
                if (document === undefined) {
                    return;
                }
                document.text = applyContentChanges(document.text, message.params.contentChanges ?? []);
                document.version = Math.max(document.version, Number(textDocument.version ?? 0));
                // The stamp belongs to the text the last sweep read; the client's text replaces it, so
                // the next sweep has to read again even if the disk has not moved since.
                document.stamp = undefined;
                return;
            }
            case "textDocument/didClose":
                this.documents.delete(uri);
                return;
        }
    }

    public get(uri: string): TrackedDocument | undefined {
        return this.documents.get(uri);
    }

    public all(): IterableIterator<TrackedDocument> {
        return this.documents.values();
    }

    /** Parent directories of every open `file:` document, which is the set the idle watchers cover. */
    public directories(): Set<string> {
        const directories = new Set<string>();
        for (const document of this.documents.values()) {
            if (document.path !== undefined) {
                directories.add(dirname(document.path));
            }
        }
        return directories;
    }
}

const DOCUMENT_SYNC_METHODS: ReadonlySet<unknown> = new Set([
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didClose",
]);

/**
 * The URI a client message sets the text of, which the sweep must leave alone because the message is
 * itself the newer word on that document. A request such as hover names a URI without carrying its
 * text, so it returns undefined there: that document is exactly the one that has to be synced first.
 */
export function syncedUri(message: ClientMessage): string | undefined {
    const uri: unknown = message.params?.textDocument?.uri;
    return DOCUMENT_SYNC_METHODS.has(message.method) && typeof uri === "string" ? uri : undefined;
}

function filePathOf(uri: string): string | undefined {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
}

/** Disk access for the sweep. `undefined` means the file is gone or unreadable; the sweep then sends nothing. */
export interface SweepDeps {
    stat(path: string): FileStamp | undefined;
    readText(path: string): string | undefined;
}

/** Narrows a sweep: `skipUri` is the document the current client message sets, `directory` a watcher's directory. */
export interface SweepOptions {
    skipUri?: string;
    directory?: string;
}

/**
 * Brings the server's copy of every open document in line with the disk.
 *
 * Returns JSON bodies of full-text `textDocument/didChange` notifications, one per document whose
 * disk text differs from the tracked text, and updates the table to match. A file is read only when
 * its mtime or size moved since the last look, so an idle sweep costs one stat per document.
 */
export function sweepDocuments(table: DocumentTable, deps: SweepDeps, options: SweepOptions): string[] {
    const bodies: string[] = [];
    for (const document of table.all()) {
        if (document.path === undefined || document.uri === options.skipUri) {
            continue;
        }
        if (options.directory !== undefined && dirname(document.path) !== options.directory) {
            continue;
        }

        // 1. A matching stamp means the disk has not moved since the last look.
        const stamp = deps.stat(document.path);
        if (stamp === undefined || sameStamp(stamp, document.stamp)) {
            continue;
        }
        document.stamp = stamp;

        // 2. A touched but identical file (a formatter with nothing to change, the same blob checked out) is no news.
        const text = deps.readText(document.path);
        if (text === undefined || text === document.text) {
            continue;
        }

        // 3. Full text, no range: Dart and intelephense both accept it and neither checks versions.
        document.text = text;
        document.version += 1;
        bodies.push(JSON.stringify({
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            params: {
                textDocument: {
                    uri: document.uri,
                    version: document.version,
                },
                contentChanges: [
                    {
                        text,
                    },
                ],
            },
        }));
    }
    return bodies;
}

function sameStamp(current: FileStamp, previous: FileStamp | undefined): boolean {
    return previous !== undefined && previous.mtimeMs === current.mtimeMs && previous.size === current.size;
}

/**
 * `FileChangeType` from the LSP specification. A const object rather than an `enum` because the
 * integration test runs this file under Node's type stripping, which rejects enums.
 */
export const FileChangeType = {
    Created: 1,
    Changed: 2,
    Deleted: 3,
} as const;

export type FileChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];

/** Path segments under which a change is never reported: tool caches, build output and other checkouts. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
    ".git",
    "node_modules",
    ".dart_tool",
    "build",
    "storage",
    ".idea",
]);

/** Adjacent segment pairs that are ignored; `vendor/composer` is regenerated wholesale by every install. */
const IGNORED_SEQUENCES: readonly (readonly [string, string])[] = [
    [
        ".claude",
        "worktrees",
    ],
    [
        "vendor",
        "composer",
    ],
];

/** Whether a path relative to the watched root lies in an ignored directory; a directory walk prunes on it. */
export function isIgnoredPath(relativePath: string): boolean {
    const segments = relativePath.split(/[\\/]/);
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        if (IGNORED_SEGMENTS.has(segment)) {
            return true;
        }
        if (IGNORED_SEQUENCES.some(([first, second]) => segment === first && segments[index + 1] === second)) {
            return true;
        }
    }
    return false;
}

/** Whether a path relative to the watched root is worth a `didChangeWatchedFiles` entry. */
export function isReportablePath(relativePath: string, extensions: readonly string[]): boolean {
    return extensions.some((extension) => relativePath.endsWith(extension)) && !isIgnoredPath(relativePath);
}

/**
 * Whether a watch failure means the process or the kernel is out of watch handles (`EMFILE`,
 * `ENOSPC` for inotify's `max_user_watches`), as opposed to one directory being gone or unreadable.
 */
export function isWatchLimitError(error: unknown): boolean {
    const code: unknown = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EMFILE" || code === "ENOSPC";
}

/** Logs `message` under `key` at most once per process. */
export type OnceLogger = (key: string, message: string) => void;

/**
 * Watches a directory tree with one non-recursive `fs.watch` per directory, for platforms where
 * Node's `recursive: true` is not a single kernel handle (Linux walks the tree synchronously, arms a
 * watch per directory or per file including ignored trees, and leaks the armed ones when a watch
 * throws mid-walk).
 *
 * Contract: the walk is asynchronous, one `readdir` per directory, so it never blocks the relay.
 * Ignored directories are pruned before descending and symlinked directories are not followed.
 * `onEvent` receives the event name and the absolute path. A directory that appears later is walked
 * and every file found inside it is reported as a `rename`, since its files may predate its watch.
 * A watch that fails because a directory vanished or is unreadable skips that directory only; on
 * `EMFILE` or `ENOSPC` no further watches are added, the ones armed stay, and the failure is logged once.
 */
export class DirectoryTreeWatcher {
    private readonly root: string;
    private readonly onEvent: (eventType: string, path: string) => void;
    private readonly log: OnceLogger;
    private readonly watchers: Map<string, FSWatcher> = new Map();
    private exhausted: boolean = false;
    private closed: boolean = false;

    public constructor(root: string, onEvent: (eventType: string, path: string) => void, log: OnceLogger) {
        this.root = root;
        this.onEvent = onEvent;
        this.log = log;
    }

    /** Walks the tree from the root; resolves once every directory found so far is watched. */
    public start(): Promise<void> {
        return this.walk(this.root, false);
    }

    public watchedDirectories(): string[] {
        return [...this.watchers.keys()];
    }

    public close(): void {
        this.closed = true;
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }

    private async walk(start: string, announceFiles: boolean): Promise<void> {
        const queue: string[] = [
            start,
        ];
        for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
            if (this.closed || this.exhausted || this.watchers.has(directory) || !this.watchDirectory(directory)) {
                continue;
            }

            let entries: Dirent[];
            try {
                entries = await readdir(directory, {
                    withFileTypes: true,
                });
            } catch (error) {
                this.log("tree-readdir", `skipping an unreadable directory ${directory}: ${errorMessage(error)}`);
                continue;
            }

            for (const entry of entries) {
                const path = join(directory, entry.name);
                if (entry.isDirectory() && !isIgnoredPath(relative(this.root, path))) {
                    queue.push(path);
                } else if (announceFiles && entry.isFile() && !this.closed) {
                    this.onEvent("rename", path);
                }
            }
        }
    }

    /** Arms one directory's watch; returns false when it could not be armed. */
    private watchDirectory(directory: string): boolean {
        try {
            const watcher = watch(directory, (eventType, filename) => {
                if (filename !== null) {
                    this.handleEvent(eventType, join(directory, filename));
                }
            });
            watcher.on("error", (error) => this.handleWatchFailure(directory, error));
            this.watchers.set(directory, watcher);
            return true;
        } catch (error) {
            this.handleWatchFailure(directory, error);
            return false;
        }
    }

    private handleEvent(eventType: string, path: string): void {
        if (this.closed) {
            return;
        }
        this.onEvent(eventType, path);
        if (eventType !== "rename" || isIgnoredPath(relative(this.root, path))) {
            return;
        }

        let stats: Stats | undefined;
        try {
            stats = statSync(path, {
                throwIfNoEntry: false,
            });
        } catch (error) {
            this.log("tree-stat", `cannot tell whether ${path} is a new directory: ${errorMessage(error)}`);
            return;
        }
        if (stats?.isDirectory() === true) {
            void this.walk(path, true);
            return;
        }
        if (stats === undefined) {
            this.forget(path);
        }
    }

    /** Closes the watches of a directory that is gone, and of everything that was under it. */
    private forget(path: string): void {
        for (const [directory, watcher] of this.watchers) {
            if (directory === path || directory.startsWith(`${path}${sep}`)) {
                watcher.close();
                this.watchers.delete(directory);
            }
        }
    }

    private handleWatchFailure(directory: string, error: unknown): void {
        this.watchers.get(directory)?.close();
        this.watchers.delete(directory);
        if (isWatchLimitError(error)) {
            this.exhausted = true;
            this.log(
                "tree-limit",
                `out of watch handles, no further workspace directories watched: ${errorMessage(error)}`,
            );
            return;
        }
        this.log("tree-skip", `skipping a directory that cannot be watched ${directory}: ${errorMessage(error)}`);
    }
}

/** Maps an `fs.watch` event onto an LSP change type; `exists` is checked when the event arrives. */
export function watchEventType(eventType: string, exists: boolean): FileChangeType {
    if (!exists) {
        return FileChangeType.Deleted;
    }
    return eventType === "rename" ? FileChangeType.Created : FileChangeType.Changed;
}

/** Collects watched-file changes for one notification; a URI recorded twice keeps its latest type. */
export class WatchedFileBatch {
    private readonly changes: Map<string, FileChangeType> = new Map();

    public record(uri: string, type: FileChangeType): void {
        this.changes.set(uri, type);
    }

    /** Returns the batch in first-seen order and starts a new one. */
    public take(): { uri: string; type: FileChangeType }[] {
        const changes = [...this.changes].map(([uri, type]) => ({
            uri,
            type,
        }));
        this.changes.clear();
        return changes;
    }

    public get size(): number {
        return this.changes.size;
    }
}

/** Picks the directory to watch from `initialize` params: first workspace folder, then `rootUri`, then the cwd. */
export function resolveWorkspaceRoot(params: any, cwd: string): string {
    const candidates: unknown[] = [
        params?.workspaceFolders?.[0]?.uri,
        params?.rootUri,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.startsWith("file:")) {
            return fileURLToPath(candidate);
        }
    }
    return cwd;
}

/** Parsed command line: proxy flags, then the server command after `--`. */
export interface ProxyOptions {
    watchRoot: boolean;
    extensions: string[];
    command: string;
    args: string[];
}

/** Parses `[--watch-root] [--ext <.ext>]... -- <command> [args...]`; throws an Error naming the problem. */
export function parseProxyArgs(argv: string[]): ProxyOptions {
    const separator = argv.indexOf("--");
    if (separator === -1) {
        throw new Error("missing \"--\" before the server command");
    }
    const command = argv[separator + 1];
    if (command === undefined) {
        throw new Error("missing server command after \"--\"");
    }

    let watchRoot = false;
    const extensions: string[] = [];
    const flags = argv.slice(0, separator);
    for (let index = 0; index < flags.length; index++) {
        const flag = flags[index];
        if (flag === "--watch-root") {
            watchRoot = true;
            continue;
        }
        if (flag === "--ext" && flags[index + 1] !== undefined) {
            extensions.push(flags[++index]!);
            continue;
        }
        throw new Error(`unknown or incomplete option "${flag}"`);
    }

    return {
        watchRoot,
        extensions: extensions.length > 0 ? extensions : [".php"],
        command,
        args: argv.slice(separator + 2),
    };
}

/** Writes each distinct key's message to stderr once, so a recurring failure cannot flood the client's log. */
function createOnceLogger(): OnceLogger {
    const seen = new Set<string>();
    return (key: string, message: string): void => {
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        process.stderr.write(`${LOG_PREFIX} ${message}\n`);
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Real disk access. Failures other than a missing file are logged once and read as "nothing to send". */
function diskDeps(log: OnceLogger): SweepDeps {
    return {
        stat: (path: string): FileStamp | undefined => {
            try {
                const stats = statSync(path, {
                    throwIfNoEntry: false,
                });
                return stats === undefined ? undefined : {
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                };
            } catch (error) {
                log("stat", `stat failed, skipping sync for ${path}: ${errorMessage(error)}`);
                return undefined;
            }
        },
        readText: (path: string): string | undefined => {
            try {
                return readFileSync(path, "utf8");
            } catch (error) {
                log("read", `read failed, skipping sync for ${path}: ${errorMessage(error)}`);
                return undefined;
            }
        },
    };
}

/**
 * Runs the proxy: `[--watch-root] [--ext .php]... -- <server command> [args...]`.
 *
 * Spawns the server and relays both directions. Client messages are forwarded byte for byte; before
 * each one, and 150 ms after any change in a directory holding an open document, the proxy writes
 * full-text didChange notifications for open documents whose disk text moved. With `--watch-root`
 * it also turns changes under the workspace root into batched `workspace/didChangeWatchedFiles`.
 * Server stdout and stderr pass through untouched; the proxy exits with the server's exit code, or 1
 * when the server dies on a signal or cannot be spawned, and 2 on a bad command line.
 */
export function runLspProxy(argv: string[]): void {
    let options: ProxyOptions;
    try {
        options = parseProxyArgs(argv);
    } catch (error) {
        process.stderr.write(
            `${LOG_PREFIX} ${errorMessage(error)}\n`
            + "usage: lsp-proxy [--watch-root] [--ext .php]... -- <server command> [args...]\n",
        );
        process.exit(2);
    }

    const log = createOnceLogger();
    const deps = diskDeps(log);
    const table = new DocumentTable();
    const parser = new FrameParser();
    const server = spawn(options.command, options.args, {
        stdio: [
            "pipe",
            "pipe",
            "inherit",
        ],
    });

    const directoryWatchers = new Map<string, FSWatcher>();
    const directoryTimers = new Map<string, NodeJS.Timeout>();
    let directoryWatchDisabled = false;
    let rootWatcher: { close(): void } | undefined;
    let pendingRoot: string | undefined;
    let batchTimer: NodeJS.Timeout | undefined;
    const batch = new WatchedFileBatch();
    let finished = false;

    // Once framing is abandoned the proxy can no longer tell where a message ends, so a synthetic
    // frame could land inside a client message; from then on it is a plain pipe.
    const passthrough = (): boolean => parser.failure !== undefined;

    // One write per framed message: Node queues writes in call order, so a synthetic message can never
    // land inside a forwarded one.
    const toServer = (bytes: Buffer): void => {
        if (!server.stdin.write(bytes)) {
            process.stdin.pause();
        }
    };
    server.stdin.on("drain", () => process.stdin.resume());
    server.stdin.on("error", (error) => log("server-stdin", `writing to the server failed: ${errorMessage(error)}`));

    const writeSweep = (sweepOptions: SweepOptions): void => {
        if (passthrough()) {
            return;
        }
        for (const body of sweepDocuments(table, deps, sweepOptions)) {
            toServer(frameMessage(body));
        }
    };

    const closeDirectoryWatcher = (directory: string): void => {
        directoryWatchers.get(directory)?.close();
        directoryWatchers.delete(directory);
        clearTimeout(directoryTimers.get(directory));
        directoryTimers.delete(directory);
    };

    const disableDirectoryWatching = (reason: string): void => {
        log("directory-watch", `directory watching disabled, syncing on client messages only: ${reason}`);
        directoryWatchDisabled = true;
        for (const directory of [...directoryWatchers.keys()]) {
            closeDirectoryWatcher(directory);
        }
    };

    // Only running out of handles turns watching off; a directory that vanished in a branch switch costs
    // just its own watch, and the next reconcile tries it again.
    const handleDirectoryWatchFailure = (directory: string, error: unknown): void => {
        if (isWatchLimitError(error)) {
            disableDirectoryWatching(errorMessage(error));
            return;
        }
        closeDirectoryWatcher(directory);
        log("directory-skip", `cannot watch ${directory}, syncing it on client messages: ${errorMessage(error)}`);
    };

    const watchDirectory = (directory: string): void => {
        try {
            const watcher = watch(directory, () => {
                clearTimeout(directoryTimers.get(directory));
                directoryTimers.set(directory, setTimeout(() => {
                    directoryTimers.delete(directory);
                    writeSweep({
                        directory,
                    });
                }, DIRECTORY_DEBOUNCE_MS));
            });
            watcher.on("error", (error) => handleDirectoryWatchFailure(directory, error));
            directoryWatchers.set(directory, watcher);
        } catch (error) {
            handleDirectoryWatchFailure(directory, error);
        }
    };

    const reconcileDirectoryWatchers = (): void => {
        if (directoryWatchDisabled) {
            return;
        }
        const wanted = table.directories();
        for (const directory of [...directoryWatchers.keys()]) {
            if (!wanted.has(directory)) {
                closeDirectoryWatcher(directory);
            }
        }
        for (const directory of wanted) {
            if (!directoryWatchers.has(directory) && !directoryWatchDisabled) {
                watchDirectory(directory);
            }
        }
    };

    const flushBatch = (): void => {
        batchTimer = undefined;
        const changes = batch.take();
        if (changes.length === 0 || passthrough()) {
            return;
        }
        toServer(frameMessage(JSON.stringify({
            jsonrpc: "2.0",
            method: "workspace/didChangeWatchedFiles",
            params: {
                changes,
            },
        })));
    };

    const recordTreeEvent = (root: string, eventType: string, path: string): void => {
        if (!isReportablePath(relative(root, path), options.extensions)) {
            return;
        }
        batch.record(pathToFileURL(path).href, watchEventType(eventType, existsSync(path)));
        batchTimer ??= setTimeout(flushBatch, WATCH_BATCH_MS);
    };

    // Recursive fs.watch is one FSEvents or ReadDirectoryChangesW handle on macOS and Windows; on
    // Linux it is a synchronous walk arming a watch per entry, so the tree watcher walks it instead.
    const watchRoot = (root: string): void => {
        if (process.platform === "linux") {
            const tree = new DirectoryTreeWatcher(
                root,
                (eventType, path) => recordTreeEvent(root, eventType, path),
                log,
            );
            rootWatcher = tree;
            void tree.start();
            return;
        }
        try {
            const watcher = watch(root, {
                recursive: true,
            }, (eventType, filename) => {
                if (filename !== null) {
                    recordTreeEvent(root, eventType, join(root, filename));
                }
            });
            watcher.on("error", (error) => {
                log("root-watch", `workspace watching stopped: ${errorMessage(error)}`);
                watcher.close();
            });
            rootWatcher = watcher;
        } catch (error) {
            log("root-watch", `workspace watching unavailable for ${root}: ${errorMessage(error)}`);
        }
    };

    const stopWatching = (): void => {
        for (const directory of [...directoryWatchers.keys()]) {
            closeDirectoryWatcher(directory);
        }
        directoryWatchDisabled = true;
        rootWatcher?.close();
        rootWatcher = undefined;
        pendingRoot = undefined;
        clearTimeout(batchTimer);
        batchTimer = undefined;
    };

    const handleMessage = (raw: Buffer, body: Buffer): void => {
        let message: ClientMessage | undefined;
        try {
            message = JSON.parse(body.toString("utf8")) as ClientMessage;
        } catch (error) {
            log("json", `forwarding a client body that is not JSON untracked: ${errorMessage(error)}`);
        }

        // 1. Sync the server before it sees the message, so a hover or diagnostics pull reads current text.
        writeSweep({
            skipUri: message === undefined ? undefined : syncedUri(message),
        });

        // 2. Forward the client's own bytes untouched.
        toServer(raw);

        // 3. Track what the client just told the server, then cover any new or emptied directory.
        if (message === undefined) {
            return;
        }
        table.apply(message);
        reconcileDirectoryWatchers();

        // 4. The root comes from initialize, but watching waits for initialized: a server must not get a
        //    notification before it has answered initialize.
        if (!options.watchRoot) {
            return;
        }
        if (message.method === "initialize" && pendingRoot === undefined && rootWatcher === undefined) {
            pendingRoot = resolveWorkspaceRoot(message.params, process.cwd());
        } else if (message.method === "initialized" && pendingRoot !== undefined) {
            watchRoot(pendingRoot);
            pendingRoot = undefined;
        }
    };

    process.stdin.on("data", (chunk: Buffer) => {
        for (const event of parser.push(chunk)) {
            if (event.kind === "raw") {
                log("framing", `framing abandoned, passing client bytes through raw: ${parser.failure}`);
                stopWatching();
                toServer(event.raw);
                continue;
            }
            handleMessage(event.raw, event.body);
        }
    });
    process.stdin.on("end", () => {
        const rest = parser.drain();
        if (rest.length > 0) {
            toServer(rest);
        }
        server.stdin.end();
    });

    server.stdout.pipe(process.stdout, {
        end: false,
    });

    // EPIPE here means the client has gone; with nobody to answer, the server is stopped and its exit
    // ends the proxy, instead of an uncaught stream error doing so.
    process.stdout.on("error", (error) => {
        log("stdout", `writing to the client failed, stopping the server: ${errorMessage(error)}`);
        server.kill("SIGTERM");
    });

    const finish = (code: number): void => {
        if (finished) {
            return;
        }
        finished = true;
        stopWatching();
        if (process.stdout.destroyed) {
            process.exit(code);
        }
        // Exit only once stdout has flushed, or the server's last replies are lost on a pipe.
        process.stdout.write("", () => process.exit(code));
    };

    server.on("error", (error) => {
        log("spawn", `server process failed: ${errorMessage(error)}`);
        finish(1);
    });
    server.on("close", (code) => finish(code ?? 1));

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            server.kill(signal);
        });
    }
}
