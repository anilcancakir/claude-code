// Contract pinned here: the stdio LSP proxy forwards every client and server byte unchanged, and only
// inserts whole synthetic notifications; the one thing it withholds is a server's non-empty
// publishDiagnostics, which the gate holds until the file's project is quiet, replaces or drops when the
// server withdraws it, and never forwards for a file that no longer exists. Framing survives arbitrary chunking and falls back to raw
// passthrough on a malformed or over-cap header; range edits use UTF-16 positions; the sync sweep emits
// a full-text didChange only when the disk text differs from the tracked text; watched-file events are
// filtered, typed and de-duplicated per URI; the per-directory tree watcher prunes ignored trees and picks up
// directories created later. The integration cases run the real entry point against a fake server that
// logs every body it receives, and pin that nothing synthetic is written once framing is abandoned.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileStamp, FrameEvent, SweepDeps } from "./lsp-proxy.ts";
import {
    ancestorEntryOnDisk,
    applyContentChanges,
    createBusyReader,
    DEFAULT_MAX_HOLD_MS,
    DEFAULT_SETTLE_MS,
    DiagnosticGate,
    DirectoryTreeWatcher,
    DocumentTable,
    editedUri,
    FileChangeType,
    filterDiagnostics,
    findProjectRoot,
    frameMessage,
    FrameParser,
    isIgnoredPath,
    isReportablePath,
    isWatchLimitError,
    MAX_BODY_BYTES,
    MAX_HEADER_BYTES,
    NOISE_PROFILES,
    parseProxyArgs,
    publishMessage,
    resolveWorkspaceRoot,
    sweepDocuments,
    syncedUri,
    watchEventType,
    WatchedFileBatch,
} from "./lsp-proxy.ts";

function framed(body: string): Buffer {
    return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function bodies(events: FrameEvent[]): string[] {
    return events.map((event) => {
        if (event.kind !== "message") {
            throw new Error("expected a message event");
        }
        return event.body.toString("utf8");
    });
}

describe("FrameParser", () => {
    test("parses one message and keeps the raw bytes", () => {
        const input = framed("{\"a\":1}");
        const events = new FrameParser().push(input);

        expect(bodies(events)).toEqual(["{\"a\":1}"]);
        expect(Buffer.compare(events[0]!.raw, input)).toBe(0);
    });

    test("parses across byte-by-byte chunk boundaries", () => {
        const input = Buffer.concat([framed("{\"a\":1}"), framed("{\"b\":2}")]);
        const parser = new FrameParser();
        const events: FrameEvent[] = [];
        for (const byte of input) {
            events.push(...parser.push(Buffer.from([byte])));
        }

        expect(bodies(events)).toEqual(["{\"a\":1}", "{\"b\":2}"]);
    });

    test("parses several messages in one chunk", () => {
        const input = Buffer.concat([framed("1"), framed("22"), framed("333")]);

        expect(bodies(new FrameParser().push(input))).toEqual(["1", "22", "333"]);
    });

    test("counts the body length in bytes for multibyte UTF-8, split inside a character", () => {
        const body = "{\"text\":\"çğü 😀\"}";
        const input = framed(body);
        const split = input.length - 4;
        const parser = new FrameParser();
        const events = [
            ...parser.push(input.subarray(0, split)),
            ...parser.push(input.subarray(split)),
        ];

        expect(bodies(events)).toEqual([body]);
    });

    test("reads the header name case-insensitively and ignores other headers", () => {
        const input = Buffer.from("content-type: application/vscode-jsonrpc\r\ncOnTeNt-LeNgTh: 2\r\n\r\n{}");

        expect(bodies(new FrameParser().push(input))).toEqual(["{}"]);
    });

    test("switches to raw passthrough on a header without Content-Length, and stays there", () => {
        const parser = new FrameParser();
        const good = framed("{}");
        const bad = Buffer.from("X-Thing: 1\r\n\r\nrest");
        const events = parser.push(Buffer.concat([good, bad]));

        expect(events).toHaveLength(2);
        expect(events[0]!.kind).toBe("message");
        expect(events[1]!.kind).toBe("raw");
        expect(Buffer.compare(events[1]!.raw, bad)).toBe(0);
        expect(parser.failure).toBeString();

        const later = framed("{}");
        const after = parser.push(later);
        expect(after).toEqual([{ kind: "raw", raw: later }]);
    });

    test("switches to raw passthrough when the header block exceeds its cap", () => {
        const parser = new FrameParser();
        const header = Buffer.alloc(MAX_HEADER_BYTES + 1, "a");
        const events = parser.push(header);

        expect(events).toHaveLength(1);
        expect(events[0]!.kind).toBe("raw");
        expect(events[0]!.raw.length).toBe(header.length);
        expect(parser.failure).toBeString();
    });

    test("switches to raw passthrough when the declared body exceeds its cap", () => {
        const parser = new FrameParser();
        const input = Buffer.from(`Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n{`);
        const events = parser.push(input);

        expect(events).toEqual([{ kind: "raw", raw: input }]);
        expect(parser.failure).toBeString();
    });

    test("drain hands back bytes of an incomplete frame", () => {
        const parser = new FrameParser();
        const input = Buffer.from("Content-Length: 10\r\n\r\n{\"a\"");
        expect(parser.push(input)).toEqual([]);

        expect(Buffer.compare(parser.drain(), input)).toBe(0);
        expect(parser.drain().length).toBe(0);
    });

    test("frameMessage produces a frame the parser reads back", () => {
        const body = "{\"text\":\"ş😀\"}";

        expect(bodies(new FrameParser().push(frameMessage(body)))).toEqual([body]);
    });
});

describe("applyContentChanges", () => {
    test("a change without a range replaces the whole text", () => {
        expect(applyContentChanges("old", [{ text: "new" }])).toBe("new");
    });

    test("a range change inserts inside a line", () => {
        const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } };

        expect(applyContentChanges("abc\ndef\n", [{ range, text: "X" }])).toBe("abc\ndeXf\n");
    });

    test("a range change spans CRLF lines", () => {
        const range = { start: { line: 0, character: 1 }, end: { line: 2, character: 1 } };

        expect(applyContentChanges("ab\r\ncd\r\nef", [{ range, text: "-" }])).toBe("a-f");
    });

    test("characters are UTF-16 code units, so a surrogate pair counts as two", () => {
        const range = { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } };

        expect(applyContentChanges("a😀bc", [{ range, text: "B" }])).toBe("a😀Bc");
    });

    test("a change list applies in order", () => {
        const first = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "x" };
        const second = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, text: "Y" };

        expect(applyContentChanges("ab", [first, second])).toBe("xYb");
    });

    test("a character past the line end clamps to the line end", () => {
        const range = { start: { line: 0, character: 99 }, end: { line: 0, character: 99 } };

        expect(applyContentChanges("ab\ncd", [{ range, text: "!" }])).toBe("ab!\ncd");
    });
});

describe("DocumentTable", () => {
    const uri = "file:///tmp/ws/a.dart";

    test("tracks didOpen, didChange and didClose", () => {
        const table = new DocumentTable();
        table.apply({ method: "textDocument/didOpen", params: { textDocument: { uri, text: "ab", version: 3 } } });
        table.apply({
            method: "textDocument/didChange",
            params: {
                textDocument: { uri, version: 4 },
                contentChanges: [
                    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "Z" },
                ],
            },
        });

        expect(table.get(uri)?.text).toBe("aZb");
        expect(table.get(uri)?.version).toBe(4);
        expect(table.directories()).toEqual(new Set(["/tmp/ws"]));

        table.apply({ method: "textDocument/didClose", params: { textDocument: { uri } } });
        expect(table.get(uri)).toBeUndefined();
        expect(table.directories().size).toBe(0);
    });

    test("keeps the highest version seen", () => {
        const table = new DocumentTable();
        table.apply({ method: "textDocument/didOpen", params: { textDocument: { uri, text: "a", version: 9 } } });
        table.apply({
            method: "textDocument/didChange",
            params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "b" }] },
        });

        expect(table.get(uri)?.text).toBe("b");
        expect(table.get(uri)?.version).toBe(9);
    });
});

/** In-memory disk for the sweep: a stamp and a text per path, plus a count of reads. */
class FakeDisk implements SweepDeps {
    public readonly files = new Map<string, { stamp: FileStamp; text: string }>();
    public reads = 0;

    public write(path: string, text: string, mtimeMs: number): void {
        this.files.set(path, { stamp: { mtimeMs, size: Buffer.byteLength(text) }, text });
    }

    public stat(path: string): FileStamp | undefined {
        return this.files.get(path)?.stamp;
    }

    public readText(path: string): string | undefined {
        this.reads++;
        return this.files.get(path)?.text;
    }
}

describe("sweepDocuments", () => {
    const uri = "file:///ws/lib/a.dart";
    const path = "/ws/lib/a.dart";

    function openTable(text: string, version: number = 1): DocumentTable {
        const table = new DocumentTable();
        table.apply({ method: "textDocument/didOpen", params: { textDocument: { uri, text, version } } });
        return table;
    }

    test("emits a full-text didChange when the disk text differs, then settles", () => {
        const disk = new FakeDisk();
        disk.write(path, "new", 1);
        const table = openTable("old", 5);

        const messages = sweepDocuments(table, disk, {}).map((body) => JSON.parse(body));
        expect(messages).toEqual([{
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            params: { textDocument: { uri, version: 6 }, contentChanges: [{ text: "new" }] },
        }]);
        expect(table.get(uri)?.text).toBe("new");
        expect(table.get(uri)?.version).toBe(6);

        expect(sweepDocuments(table, disk, {})).toEqual([]);
    });

    test("does not read the file while mtime and size are unchanged", () => {
        const disk = new FakeDisk();
        disk.write(path, "same", 1);
        const table = openTable("same");

        expect(sweepDocuments(table, disk, {})).toEqual([]);
        expect(disk.reads).toBe(1);
        expect(sweepDocuments(table, disk, {})).toEqual([]);
        expect(disk.reads).toBe(1);

        disk.write(path, "same", 2);
        expect(sweepDocuments(table, disk, {})).toEqual([]);
        expect(disk.reads).toBe(2);
    });

    test("re-reads the disk after a client didChange, even when the stamp has not moved", () => {
        const disk = new FakeDisk();
        disk.write(path, "B", 1);
        const table = openTable("A");

        expect(sweepDocuments(table, disk, {})).toHaveLength(1);
        table.apply({
            method: "textDocument/didChange",
            params: { textDocument: { uri, version: 9 }, contentChanges: [{ text: "A" }] },
        });

        const messages = sweepDocuments(table, disk, {}).map((body) => JSON.parse(body));
        expect(messages).toHaveLength(1);
        expect(messages[0].params).toEqual({
            textDocument: { uri, version: 10 },
            contentChanges: [{ text: "B" }],
        });
    });

    test("skips the URI the current client message is about", () => {
        const disk = new FakeDisk();
        disk.write(path, "new", 1);
        const table = openTable("old");

        expect(sweepDocuments(table, disk, { skipUri: uri })).toEqual([]);
        expect(table.get(uri)?.text).toBe("old");
    });

    test("sends nothing for a deleted file", () => {
        const table = openTable("old");

        expect(sweepDocuments(table, new FakeDisk(), {})).toEqual([]);
    });

    test("limits the sweep to one directory when asked", () => {
        const disk = new FakeDisk();
        disk.write(path, "new", 1);
        const table = openTable("old");

        expect(sweepDocuments(table, disk, { directory: "/ws/other" })).toEqual([]);
        expect(sweepDocuments(table, disk, { directory: "/ws/lib" })).toHaveLength(1);
    });

    test("only document sync notifications name a URI to skip", () => {
        const textDocument = { uri, text: "x", version: 1 };

        expect(syncedUri({ method: "textDocument/didOpen", params: { textDocument } })).toBe(uri);
        expect(syncedUri({ method: "textDocument/didChange", params: { textDocument } })).toBe(uri);
        expect(syncedUri({ method: "textDocument/didClose", params: { textDocument } })).toBe(uri);
        expect(syncedUri({ method: "textDocument/hover", params: { textDocument } })).toBeUndefined();
        expect(syncedUri({ method: "initialized", params: {} })).toBeUndefined();
    });

    test("ignores documents that are not file URIs", () => {
        const disk = new FakeDisk();
        const table = new DocumentTable();
        table.apply({
            method: "textDocument/didOpen",
            params: { textDocument: { uri: "untitled:Untitled-1", text: "x", version: 1 } },
        });

        expect(sweepDocuments(table, disk, {})).toEqual([]);
        expect(disk.reads).toBe(0);
    });
});

describe("watched files", () => {
    test("reports only matching extensions outside ignored directories", () => {
        const extensions = [".php"];

        expect(isReportablePath("app/Models/User.php", extensions)).toBe(true);
        expect(isReportablePath("vendor/laravel/framework/src/Foo.php", extensions)).toBe(true);
        expect(isReportablePath("app/User.js", extensions)).toBe(false);
        expect(isReportablePath("vendor/composer/autoload_real.php", extensions)).toBe(false);
        expect(isReportablePath("node_modules/x/a.php", extensions)).toBe(false);
        expect(isReportablePath(".git/hooks/a.php", extensions)).toBe(false);
        expect(isReportablePath("storage/framework/views/a.php", extensions)).toBe(false);
        expect(isReportablePath("packages/x/build/a.php", extensions)).toBe(false);
        expect(isReportablePath(".dart_tool/a.php", extensions)).toBe(false);
        expect(isReportablePath(".idea/a.php", extensions)).toBe(false);
        expect(isReportablePath(".claude/worktrees/lane/app/a.php", extensions)).toBe(false);
        expect(isReportablePath(".claude/app/a.php", extensions)).toBe(true);
        expect(isReportablePath("worktrees/a.php", extensions)).toBe(true);
    });

    test("prunes ignored directories by segment and by sequence", () => {
        expect(isIgnoredPath("vendor/composer")).toBe(true);
        expect(isIgnoredPath("vendor/laravel")).toBe(false);
        expect(isIgnoredPath(".claude/worktrees")).toBe(true);
        expect(isIgnoredPath(".claude")).toBe(false);
        expect(isIgnoredPath("app/node_modules")).toBe(true);
        expect(isIgnoredPath("app")).toBe(false);
    });

    test("only EMFILE and ENOSPC count as running out of watch handles", () => {
        const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

        expect(isWatchLimitError(failure("EMFILE"))).toBe(true);
        expect(isWatchLimitError(failure("ENOSPC"))).toBe(true);
        expect(isWatchLimitError(failure("ENOENT"))).toBe(false);
        expect(isWatchLimitError(failure("EACCES"))).toBe(false);
        expect(isWatchLimitError(new Error("plain"))).toBe(false);
    });

    test("types an event by existence and event name", () => {
        expect(watchEventType("rename", false)).toBe(FileChangeType.Deleted);
        expect(watchEventType("change", false)).toBe(FileChangeType.Deleted);
        expect(watchEventType("rename", true)).toBe(FileChangeType.Created);
        expect(watchEventType("change", true)).toBe(FileChangeType.Changed);
    });

    test("a batch keeps the last type per URI and empties on take", () => {
        const batch = new WatchedFileBatch();
        batch.record("file:///a.php", FileChangeType.Created);
        batch.record("file:///b.php", FileChangeType.Changed);
        batch.record("file:///a.php", FileChangeType.Deleted);

        expect(batch.take()).toEqual([
            { uri: "file:///a.php", type: FileChangeType.Deleted },
            { uri: "file:///b.php", type: FileChangeType.Changed },
        ]);
        expect(batch.take()).toEqual([]);
    });

    test("resolves the workspace root from folders, then rootUri, then the cwd", () => {
        expect(resolveWorkspaceRoot({
            workspaceFolders: [{ uri: "file:///ws/one", name: "one" }],
            rootUri: "file:///ws/two",
        }, "/cwd")).toBe("/ws/one");
        expect(resolveWorkspaceRoot({ workspaceFolders: null, rootUri: "file:///ws/two" }, "/cwd")).toBe("/ws/two");
        expect(resolveWorkspaceRoot({ rootUri: null }, "/cwd")).toBe("/cwd");
        expect(resolveWorkspaceRoot(undefined, "/cwd")).toBe("/cwd");
    });
});

describe("DirectoryTreeWatcher", () => {
    async function eventually(check: () => boolean): Promise<void> {
        const deadline = Date.now() + 3000;
        while (!check()) {
            if (Date.now() > deadline) {
                throw new Error("condition not met within 3 s");
            }
            await Bun.sleep(20);
        }
    }

    test("watches every directory except pruned trees, and reports files in directories created later", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-lsp-tree-")));
        for (const directory of ["app/Models", "node_modules/pkg", "vendor/composer", "vendor/laravel"]) {
            mkdirSync(join(root, directory), { recursive: true });
        }
        const events: string[] = [];
        const logged: string[] = [];
        const tree = new DirectoryTreeWatcher(root, (_eventType, path) => events.push(path), (_key, message) => {
            logged.push(message);
        });

        try {
            await tree.start();
            expect(tree.watchedDirectories().sort()).toEqual([
                root,
                join(root, "app"),
                join(root, "app/Models"),
                join(root, "vendor"),
                join(root, "vendor/laravel"),
            ].sort());

            writeFileSync(join(root, "app/Models/User.php"), "<?php\n");
            await eventually(() => events.includes(join(root, "app/Models/User.php")));

            mkdirSync(join(root, "app/Http/Controllers"), { recursive: true });
            writeFileSync(join(root, "app/Http/Controllers/Home.php"), "<?php\n");
            await eventually(() => events.includes(join(root, "app/Http/Controllers/Home.php")));
            await eventually(() => tree.watchedDirectories().includes(join(root, "app/Http/Controllers")));
            expect(logged).toEqual([]);
        } finally {
            tree.close();
            rmSync(root, { recursive: true, force: true });
        }
        expect(tree.watchedDirectories()).toEqual([]);
    });

    test("skips a directory that cannot be watched and keeps going", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-lsp-tree-")));
        const logged: string[] = [];
        const tree = new DirectoryTreeWatcher(join(root, "missing"), () => {}, (key) => {
            logged.push(key);
        });

        try {
            await tree.start();
            expect(tree.watchedDirectories()).toEqual([]);
            expect(logged).toEqual(["tree-skip"]);
        } finally {
            tree.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("parseProxyArgs", () => {
    test("reads flags before the separator and the server command after it", () => {
        expect(parseProxyArgs(["--watch-root", "--ext", ".php", "--ext", ".inc", "--", "srv", "--stdio"])).toEqual({
            watchRoot: true,
            extensions: [".php", ".inc"],
            settleMs: DEFAULT_SETTLE_MS,
            maxHoldMs: DEFAULT_MAX_HOLD_MS,
            maxSeverity: 4,
            profiles: [],
            command: "srv",
            args: ["--stdio"],
        });
    });

    test("reads the severity cap and named noise profiles", () => {
        const options = parseProxyArgs(["--max-severity", "2", "--profile", "typescript", "--profile", "swift", "--", "srv"]);
        expect(options.maxSeverity).toBe(2);
        expect(options.profiles).toEqual(["typescript", "swift"]);
        expect(() => parseProxyArgs(["--max-severity", "5", "--", "srv"])).toThrow();
        expect(() => parseProxyArgs(["--max-severity", "--", "srv"])).toThrow();
        expect(() => parseProxyArgs(["--profile", "cobol", "--", "srv"])).toThrow();
        expect(() => parseProxyArgs(["--profile", "toString", "--", "srv"])).toThrow();
        expect(() => parseProxyArgs(["--profile", "constructor", "--", "srv"])).toThrow();
        expect(() => parseProxyArgs(["--profile", "--", "srv"])).toThrow();
    });

    test("reads the busy notification pair and rejects anything else", () => {
        expect(parseProxyArgs(["--busy", "indexingStarted,indexingEnded", "--", "srv"]).busy).toEqual({ start: "indexingStarted", end: "indexingEnded" });
        expect(parseProxyArgs(["--", "srv"]).busy).toBeUndefined();
        for (const value of ["indexingStarted", "a,b,c", "a,", ",b", "same,same", "has space,b"]) {
            expect(() => parseProxyArgs(["--busy", value, "--", "srv"])).toThrow();
        }
        expect(() => parseProxyArgs(["--busy", "--", "srv"])).toThrow();
    });

    test("defaults to no root watch and the .php extension", () => {
        expect(parseProxyArgs(["--", "dart", "language-server"])).toEqual({
            watchRoot: false,
            extensions: [".php"],
            settleMs: DEFAULT_SETTLE_MS,
            maxHoldMs: DEFAULT_MAX_HOLD_MS,
            maxSeverity: 4,
            profiles: [],
            command: "dart",
            args: ["language-server"],
        });
    });

    test("reads the settle and max-hold times, zero included", () => {
        const options = parseProxyArgs(["--settle", "0", "--max-hold", "1500", "--", "srv"]);
        expect(options.settleMs).toBe(0);
        expect(options.maxHoldMs).toBe(1500);
    });

    test("rejects a missing separator, a missing command, an unknown flag and a bad duration", () => {
        expect(() => parseProxyArgs(["dart"])).toThrow();
        expect(() => parseProxyArgs(["--"])).toThrow();
        expect(() => parseProxyArgs(["--nope", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--ext", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--settle", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--settle", "soon", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--max-hold", "-5", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--max-hold", "2147483648", "--", "dart"])).toThrow();
        expect(parseProxyArgs(["--max-hold", "2147483647", "--", "dart"]).maxHoldMs).toBe(2147483647);
    });
});

describe("findProjectRoot", () => {
    test("returns the nearest ancestor holding .git, so each worktree is its own project", () => {
        const present = new Set(["/repo/.git", "/repo/.claude/worktrees/lane/.git"]);
        const exists = (path: string): boolean => present.has(path);

        expect(findProjectRoot("/repo/lib/a.dart", exists)).toBe("/repo");
        expect(findProjectRoot("/repo/.claude/worktrees/lane/lib/a.dart", exists)).toBe("/repo/.claude/worktrees/lane");
    });

    test("falls back to the file's own directory when no ancestor has .git", () => {
        expect(findProjectRoot("/tmp/scratch/a.dart", () => false)).toBe("/tmp/scratch");
    });
});

describe("editedUri and publishMessage", () => {
    test("name the document of open, change, save and close, and no other message", () => {
        const textDocument = { uri: "file:///a.dart" };
        for (const method of ["didOpen", "didChange", "didSave", "didClose"]) {
            expect(editedUri({ method: `textDocument/${method}`, params: { textDocument } })).toBe("file:///a.dart");
        }
        expect(editedUri({ method: "textDocument/hover", params: { textDocument } })).toBeUndefined();
    });

    test("read publishDiagnostics params and leave every other body alone", () => {
        const publish = Buffer.from(JSON.stringify({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: "file:///a.dart", diagnostics: [{ message: "x" }] },
        }));
        expect(publishMessage(publish)?.params).toEqual({ uri: "file:///a.dart", diagnostics: [{ message: "x" }] });

        const hover = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { contents: "textDocument/publishDiagnostics" } }));
        expect(publishMessage(hover)).toBeUndefined();
        expect(publishMessage(Buffer.from("\"textDocument/publishDiagnostics\" not json"))).toBeUndefined();
    });

    test("busy reader names the start and end notifications and nothing that merely quotes them", () => {
        const read = createBusyReader({ start: "indexingStarted", end: "indexingEnded" });
        const body = (message: object): Buffer => Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));

        expect(read(body({ method: "indexingStarted" }))).toBe("start");
        expect(read(body({ method: "indexingEnded", params: null }))).toBe("end");
        expect(read(body({ method: "window/logMessage", params: { message: "indexingStarted" } }))).toBeUndefined();
        expect(read(body({ id: 4, method: "indexingStarted" }))).toBeUndefined();
        expect(read(body({ id: 4, result: "indexingEnded" }))).toBeUndefined();
        expect(read(Buffer.from("\"indexingEnded\" not json"))).toBeUndefined();
        expect(read(body({ method: "textDocument/hover" }))).toBeUndefined();
    });

    test("read a publish whose method name has an escaped slash, as sourcekit-lsp writes it", () => {
        const escaped = Buffer.from('{"method":"textDocument\\/publishDiagnostics","jsonrpc":"2.0","params":{"uri":"file:\\/\\/\\/a.swift","diagnostics":[]}}');
        expect(publishMessage(escaped)?.params).toEqual({ uri: "file:///a.swift", diagnostics: [] });
    });
});

describe("filterDiagnostics", () => {
    const uri = "file:///repo/src/a.ts";
    const installed = new Set<string>();
    const options = (maxSeverity: number, profile: string[] = []) => ({
        maxSeverity,
        rules: profile.flatMap((name) => NOISE_PROFILES[name] ?? []),
        hasAncestorEntry: (_path: string, name: string): boolean => installed.has(name),
        projectOf: (): string => "/repo",
    });
    const diagnostic = (message: string, code: string | number = "", severity: number | undefined = 1): object => ({ message, code, severity });
    const messages = (params: { diagnostics?: unknown } | undefined): string[] =>
        ((params?.diagnostics ?? []) as { message: string }[]).map((item) => item.message);

    test("keeps everything and reports no change when nothing is dropped", () => {
        const params = { uri, diagnostics: [diagnostic("a"), diagnostic("b", "x", 4)] };
        expect(filterDiagnostics(params, options(4))).toBeUndefined();
    });

    test("drops what is less severe than the cap, and treats a missing severity as an error", () => {
        const params = { uri, diagnostics: [diagnostic("hint", "", 4), diagnostic("info", "", 3), diagnostic("warn", "", 2), diagnostic("error", "", 1), diagnostic("none", "", undefined)] };
        expect(messages(filterDiagnostics(params, options(2)))).toEqual(["warn", "error", "none"]);
        expect(messages(filterDiagnostics(params, options(1)))).toEqual(["error", "none"]);
    });

    test("typescript profile drops dependency errors only while no node_modules exists above the file", () => {
        const params = { uri, diagnostics: [
            diagnostic("Cannot find module 'react' or its corresponding type declarations.", 2307),
            diagnostic("Cannot find name 'process'. Do you need to install type definitions for node?", 2591),
            diagnostic("Type 'string' is not assignable to type 'number'.", 2322),
        ] };

        expect(messages(filterDiagnostics(params, options(4, ["typescript"])))).toEqual(["Type 'string' is not assignable to type 'number'."]);

        installed.add("node_modules");
        expect(filterDiagnostics(params, options(4, ["typescript"]))).toBeUndefined();
        installed.clear();
    });

    test("typescript profile keeps a relative import that cannot be found, because that is a typo", () => {
        const params = { uri, diagnostics: [
            diagnostic("Cannot find module './nope' or its corresponding type declarations.", 2307),
            diagnostic("Cannot find module '../up' or its corresponding type declarations.", 2307),
            diagnostic("Cannot find module 'left-pad' or its corresponding type declarations.", 2307),
        ] };
        expect(messages(filterDiagnostics(params, options(4, ["typescript"])))).toEqual([
            "Cannot find module './nope' or its corresponding type declarations.",
            "Cannot find module '../up' or its corresponding type declarations.",
        ]);
    });

    test("php profile drops undefined-symbol errors only where composer.json is present and vendor is not", () => {
        const params = { uri: "file:///wt/backend/app/PlaceLayout.php", diagnostics: [
            diagnostic("Undefined type 'Illuminate\\Validation\\Rule'.", "P1009"),
            diagnostic("Undefined method 'getKey'.", "P1013"),
            diagnostic("Undefined property '$layout_rows'.", "P1014"),
            diagnostic("Expected type 'int'. Found 'string'.", "P1006"),
            diagnostic("syntax error, unexpected '}'", "P1001"),
        ] };
        const real = ["Expected type 'int'. Found 'string'.", "syntax error, unexpected '}'"];

        // No composer.json: nothing is missing, so an undefined symbol is a real error.
        expect(filterDiagnostics(params, options(4, ["php"]))).toBeUndefined();

        installed.add("composer.json");
        expect(messages(filterDiagnostics(params, options(4, ["php"])))).toEqual(real);

        // Installed: every code is kept again.
        installed.add("vendor");
        expect(filterDiagnostics(params, options(4, ["php"]))).toBeUndefined();
        installed.clear();
    });

    test("php profile counts only the worktree's own vendor, not the checkout above it", () => {
        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ac-lsp-php-")));
        try {
            const put = (path: string, text = ""): void => {
                mkdirSync(join(scratch, path, ".."), { recursive: true });
                writeFileSync(join(scratch, path), text);
            };
            // The checkout has composer.json and vendor at its root; its worktree has the tracked files only.
            put("repo/.git/HEAD");
            put("repo/composer.json");
            put("repo/vendor/autoload.php");
            put("repo/app/Main.php");
            put("repo/.claude/worktrees/wt/.git", "gitdir: ../../../.git/worktrees/wt\n");
            put("repo/.claude/worktrees/wt/composer.json");
            put("repo/.claude/worktrees/wt/app/X.php");
            // And the layout with the PHP project one directory down.
            put("mono/.git/HEAD");
            put("mono/backend/composer.json");
            put("mono/backend/vendor/autoload.php");
            put("mono/.claude/worktrees/wt/.git", "gitdir: ../../../.git/worktrees/wt\n");
            put("mono/.claude/worktrees/wt/backend/composer.json");
            put("mono/.claude/worktrees/wt/backend/app/Y.php");

            const filter = (relative: string) => filterDiagnostics(
                { uri: pathToFileURL(join(scratch, relative)).href, diagnostics: [diagnostic("Undefined type 'PHPUnit\\Framework\\TestCase'.", "P1009")] },
                {
                    maxSeverity: 4,
                    rules: NOISE_PROFILES.php ?? [],
                    hasAncestorEntry: ancestorEntryOnDisk,
                    projectOf: (path: string): string => findProjectRoot(path, existsSync),
                },
            );

            // Undefined means nothing was dropped; an empty list means everything was.
            expect(filter("repo/.claude/worktrees/wt/app/X.php")?.diagnostics).toEqual([]);
            expect(filter("repo/app/Main.php")).toBeUndefined();
            expect(filter("mono/.claude/worktrees/wt/backend/app/Y.php")?.diagnostics).toEqual([]);
            expect(filter("mono/backend/app/Z.php")).toBeUndefined();

            // composer install in the worktree: from then on its errors are kept.
            put("repo/.claude/worktrees/wt/vendor/autoload.php");
            expect(filter("repo/.claude/worktrees/wt/app/X.php")).toBeUndefined();
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    });

    test("swift profile always drops the package-name error and drops a missing module only without a build description", () => {
        const params = { uri: "file:///pkg/Sources/App/main.swift", diagnostics: [
            diagnostic("The package access level used on 'Foo' requires a package name; set it with the compiler flag '-package-name'"),
            diagnostic("No such module 'Foo'"),
            diagnostic("Cannot convert value of type 'String' to specified type 'Int'"),
        ] };

        expect(messages(filterDiagnostics(params, options(4, ["swift"])))).toEqual(["Cannot convert value of type 'String' to specified type 'Int'"]);

        // A package creates its own .build almost at once, so that directory alone is no reason to keep the error.
        installed.add(".build");
        expect(messages(filterDiagnostics(params, options(4, ["swift"])))).toEqual(["Cannot convert value of type 'String' to specified type 'Int'"]);
        installed.clear();

        for (const description of ["Package.swift", "compile_commands.json", "buildServer.json"]) {
            installed.add(description);
            expect(messages(filterDiagnostics(params, options(4, ["swift"])))).toEqual(["No such module 'Foo'", "Cannot convert value of type 'String' to specified type 'Int'"]);
            installed.clear();
        }
    });

    test("leaves a publish for a URI that is not a local file alone", () => {
        const params = { uri: "untitled:Untitled-1", diagnostics: [diagnostic("hint", "", 4)] };
        expect(filterDiagnostics(params, options(1))).toBeUndefined();
    });
});

describe("DiagnosticGate", () => {
    const uri = "file:///repo/lib/a.dart";
    const other = "file:///lane/lib/b.dart";
    const error = [{ message: "Undefined name 'A'." }];

    interface Fixture {
        gate: DiagnosticGate;
        clock: { now: number };
        files: Set<string>;
    }

    function fixture(settleMs: number = 1000, maxHoldMs: number = 10_000): Fixture {
        const clock = { now: 1_000_000 };
        const files = new Set(["/repo/lib/a.dart", "/lane/lib/b.dart"]);
        const gate = new DiagnosticGate({
            now: () => clock.now,
            fileExists: (path) => files.has(path),
            projectOf: (path) => (path.startsWith("/lane/") ? "/lane" : "/repo"),
        }, settleMs, maxHoldMs);
        return { gate, clock, files };
    }

    const frame = (name: string): Buffer => Buffer.from(name);
    const names = (frames: Buffer[]): string[] => frames.map((item) => item.toString());

    test("holds a non-empty publish until the project has been quiet for the settle time", () => {
        const { gate, clock } = fixture();
        expect(gate.offer(frame("red"), { uri, diagnostics: error })).toEqual([]);
        expect(gate.size).toBe(1);

        clock.now += 999;
        expect(gate.release()).toEqual([]);
        clock.now += 1;
        expect(names(gate.release())).toEqual(["red"]);
        expect(gate.size).toBe(0);
    });

    test("an empty publish drops the held set and is forwarded at once", () => {
        const { gate, clock } = fixture();
        gate.offer(frame("red"), { uri, diagnostics: error });
        clock.now += 400;

        expect(names(gate.offer(frame("clean"), { uri, diagnostics: [] }))).toEqual(["clean"]);
        clock.now += 5000;
        expect(gate.release()).toEqual([]);
    });

    test("a newer publish replaces the held one and restarts its quiet time", () => {
        const { gate, clock } = fixture();
        gate.offer(frame("first"), { uri, diagnostics: error });
        clock.now += 800;
        gate.offer(frame("second"), { uri, diagnostics: error });

        clock.now += 800;
        expect(gate.release()).toEqual([]);
        clock.now += 200;
        expect(names(gate.release())).toEqual(["second"]);
    });

    test("client activity in the same project pushes the held set back, other projects do not", () => {
        const { gate, clock } = fixture();
        gate.offer(frame("red"), { uri, diagnostics: error });
        clock.now += 900;
        gate.touch(other);
        expect(gate.nextWake()).toBe(100);

        gate.touch("file:///repo/lib/c.dart");
        expect(gate.nextWake()).toBe(1000);
        clock.now += 1000;
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("drops a publish for a file that does not exist, and a held set whose file is deleted", () => {
        const { gate, clock, files } = fixture();
        files.delete("/lane/lib/b.dart");
        expect(gate.offer(frame("ghost"), { uri: other, diagnostics: error })).toEqual([]);
        expect(gate.size).toBe(0);

        gate.offer(frame("red"), { uri, diagnostics: error });
        files.delete("/repo/lib/a.dart");
        clock.now += 5000;
        expect(gate.release()).toEqual([]);
        expect(gate.size).toBe(0);
    });

    test("forwards a set held for the max-hold time even in a project that never goes quiet", () => {
        const { gate, clock } = fixture(1000, 3000);
        gate.offer(frame("red"), { uri, diagnostics: error });
        for (let step = 0; step < 2; step++) {
            clock.now += 900;
            gate.touch(uri);
            expect(gate.release()).toEqual([]);
        }
        clock.now += 1200;
        gate.touch(uri);
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("hands back frames that are not held diagnostics untouched", () => {
        const { gate } = fixture();
        expect(names(gate.offer(frame("untitled"), { uri: "untitled:Untitled-1", diagnostics: error }))).toEqual(["untitled"]);
        expect(names(gate.offer(frame("odd"), { uri, diagnostics: "not a list" }))).toEqual(["odd"]);
        expect(gate.size).toBe(0);
    });

    test("flush hands back every held frame whose file exists, oldest first, and empties the gate", () => {
        const { gate, files } = fixture();
        files.add("/repo/lib/c.dart");
        gate.offer(frame("first"), { uri, diagnostics: error });
        gate.offer(frame("second"), { uri: other, diagnostics: error });
        gate.offer(frame("third"), { uri: "file:///repo/lib/c.dart", diagnostics: error });
        files.delete("/lane/lib/b.dart");

        expect(names(gate.flush())).toEqual(["first", "third"]);
        expect(gate.size).toBe(0);
        expect(gate.nextWake()).toBeUndefined();
    });

    test("a busy server holds a set past the settle time, and the quiet time restarts when it goes idle", () => {
        const { gate, clock } = fixture(1000, 60_000);
        gate.setBusy(true);
        gate.offer(frame("red"), { uri, diagnostics: error });

        clock.now += 20_000;
        expect(gate.release()).toEqual([]);
        expect(gate.nextWake()).toBe(40_000);

        gate.setBusy(false);
        expect(gate.nextWake()).toBe(1000);
        clock.now += 999;
        expect(gate.release()).toEqual([]);
        clock.now += 1;
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("the republish after a busy period replaces the held set", () => {
        const { gate, clock } = fixture(1000, 60_000);
        gate.setBusy(true);
        gate.offer(frame("transient"), { uri, diagnostics: error });
        clock.now += 5000;
        gate.setBusy(false);

        // Idle for 300 ms, inside the quiet time: without the restart the set would be due already.
        clock.now += 300;
        expect(gate.release()).toEqual([]);
        expect(gate.size).toBe(1);

        expect(names(gate.offer(frame("clean"), { uri, diagnostics: [] }))).toEqual(["clean"]);
        clock.now += 5000;
        expect(gate.release()).toEqual([]);
    });

    test("a server that stays busy cannot hold a set past the max-hold time", () => {
        const { gate, clock } = fixture(1000, 3000);
        gate.setBusy(true);
        gate.offer(frame("red"), { uri, diagnostics: error });
        clock.now += 2999;
        expect(gate.release()).toEqual([]);
        clock.now += 1;
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("an idle notice without a start leaves the gate as it was", () => {
        const { gate, clock } = fixture();
        gate.offer(frame("red"), { uri, diagnostics: error });
        clock.now += 500;
        gate.setBusy(false);
        expect(gate.nextWake()).toBe(500);
        clock.now += 500;
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("holds a copy of the frame, so a later write to the parser's buffer cannot change it", () => {
        const { gate, clock } = fixture();
        const raw = Buffer.from("red");
        gate.offer(raw, { uri, diagnostics: error });
        raw.write("XXX");

        clock.now += 1000;
        expect(names(gate.release())).toEqual(["red"]);
    });

    test("a zero settle time forwards at once but still drops deleted files", () => {
        const { gate, files } = fixture(0);
        expect(names(gate.offer(frame("red"), { uri, diagnostics: error }))).toEqual(["red"]);
        files.delete("/repo/lib/a.dart");
        expect(gate.offer(frame("ghost"), { uri, diagnostics: error })).toEqual([]);
    });
});

describe("proxy process", () => {
    const sourceDir = import.meta.dir;
    const entry = join(sourceDir, "lsp-proxy-main.ts");
    const proxyModule = join(sourceDir, "lsp-proxy.ts");
    const cleanups: (() => void)[] = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }
    });

    interface Harness {
        workspace: string;
        logPath: string;
        proxy: ChildProcessWithoutNullStreams;
        send(message: object): void;
        logged(): Record<string, unknown>[];
        waitFor(predicate: (messages: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]>;
        /** Frames the proxy wrote to the client, in order. */
        toClient(): Record<string, unknown>[];
        /** Asks the fake server to write `message` to its stdout, as a real server would. */
        emit(message: object): void;
        /** Asks the fake server to write these bytes to its stdout as they are, framed or not. */
        emitRaw(bytes: string): void;
        exitCode(): Promise<number | null>;
    }

    function startProxy(flags: string[]): Harness {
        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ac-lsp-proxy-")));
        const workspace = join(scratch, "ws");
        const logPath = join(scratch, "server.log");
        const fakeServer = join(scratch, "fake-server.ts");
        Bun.spawnSync(["mkdir", "-p", workspace]);
        writeFileSync(fakeServer, [
            `import { appendFileSync } from "node:fs";`,
            `import { frameMessage, FrameParser } from ${JSON.stringify(proxyModule)};`,
            `const parser = new FrameParser();`,
            `process.stdin.on("data", (chunk) => {`,
            `    for (const event of parser.push(chunk)) {`,
            `        const line = event.kind === "message"`,
            `            ? event.body.toString("utf8")`,
            `            : JSON.stringify({ raw: event.raw.toString("utf8") });`,
            `        appendFileSync(process.argv[2], line + "\\n");`,
            `        if (event.kind === "message") {`,
            `            const message = JSON.parse(event.body.toString("utf8"));`,
            `            if (message.method === "test/emit") {`,
            `                process.stdout.write(frameMessage(JSON.stringify(message.params)));`,
            `            } else if (message.method === "test/raw") {`,
            `                process.stdout.write(message.params.bytes);`,
            `            } else if (message.method === "test/exit") {`,
            `                process.stdout.write("", () => process.exit(0));`,
            `            }`,
            `        }`,
            `    }`,
            `});`,
            `process.stdin.on("end", () => process.exit(3));`,
            ``,
        ].join("\n"));
        writeFileSync(logPath, "");

        // Node, not bun: bun drops a "--" that directly follows the script path, and Node runs the shipped bundle.
        const proxy = spawn(
            "node",
            ["--experimental-strip-types", "--no-warnings", entry, ...flags, "--", "bun", fakeServer, logPath],
            { cwd: workspace },
        );
        cleanups.push(() => {
            proxy.kill("SIGKILL");
            rmSync(scratch, { recursive: true, force: true });
        });

        const logged = (): Record<string, unknown>[] => readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);

        const clientParser = new FrameParser();
        const received: Record<string, unknown>[] = [];
        proxy.stdout.on("data", (chunk: Buffer) => {
            for (const event of clientParser.push(chunk)) {
                if (event.kind === "message") {
                    received.push(JSON.parse(event.body.toString("utf8")) as Record<string, unknown>);
                }
            }
        });

        const send = (message: object): void => {
            proxy.stdin.write(frameMessage(JSON.stringify({ jsonrpc: "2.0", ...message })));
        };

        return {
            workspace,
            logPath,
            proxy,
            send,
            toClient: () => received,
            emit: (message: object): void => send({ method: "test/emit", params: { jsonrpc: "2.0", ...message } }),
            emitRaw: (bytes: string): void => send({ method: "test/raw", params: { bytes } }),
            logged,
            waitFor: async (predicate) => {
                const deadline = Date.now() + 3000;
                while (Date.now() < deadline) {
                    const messages = logged();
                    if (predicate(messages)) {
                        return messages;
                    }
                    await Bun.sleep(20);
                }
                throw new Error(`timed out; log holds ${readFileSync(logPath, "utf8")}`);
            },
            exitCode: () => new Promise((resolve) => proxy.on("exit", (code) => resolve(code))),
        };
    }

    function methods(messages: Record<string, unknown>[]): unknown[] {
        return messages.map((message) => message.method);
    }

    test("writes a synthetic didChange before the next client message after a disk rewrite", async () => {
        const harness = startProxy([]);
        const file = join(harness.workspace, "main.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "void main() {}\n");

        harness.send({ method: "textDocument/didOpen", params: { textDocument: {
            uri,
            languageId: "dart",
            version: 1,
            text: "void main() {}\n",
        } } });
        await harness.waitFor((messages) => messages.length === 1);

        writeFileSync(file, "void main() { int x = 'a'; }\n");
        harness.send({ id: 7, method: "textDocument/hover", params: {
            textDocument: { uri },
            position: { line: 0, character: 1 },
        } });

        const messages = await harness.waitFor((all) => methods(all).includes("textDocument/hover"));
        expect(methods(messages)).toEqual([
            "textDocument/didOpen",
            "textDocument/didChange",
            "textDocument/hover",
        ]);
        expect(messages[1]!.params).toEqual({
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: "void main() { int x = 'a'; }\n" }],
        });

        const exit = harness.exitCode();
        harness.proxy.stdin.end();
        expect(await exit).toBe(3);
    });

    test("sends a synthetic didChange on its own when an open file changes while idle", async () => {
        const harness = startProxy([]);
        const file = join(harness.workspace, "idle.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.send({ method: "textDocument/didOpen", params: { textDocument: {
            uri,
            languageId: "dart",
            version: 1,
            text: "a\n",
        } } });
        await harness.waitFor((messages) => messages.length === 1);

        writeFileSync(file, "b\n");
        const messages = await harness.waitFor((all) => methods(all).includes("textDocument/didChange"));
        expect(messages[1]!.params).toEqual({
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: "b\n" }],
        });
    });

    test("--watch-root reports workspace file changes as didChangeWatchedFiles", async () => {
        const harness = startProxy(["--watch-root"]);
        const rootUri = pathToFileURL(harness.workspace).href;

        harness.send({ id: 1, method: "initialize", params: { rootUri, capabilities: {} } });
        await harness.waitFor((messages) => messages.length === 1);

        // Nothing may reach the server between initialize and initialized.
        writeFileSync(join(harness.workspace, "Early.php"), "<?php\n");
        await Bun.sleep(600);
        expect(methods(harness.logged())).toEqual(["initialize"]);

        harness.send({ method: "initialized", params: {} });
        await harness.waitFor((messages) => messages.length === 2);

        const file = join(harness.workspace, "User.php");
        writeFileSync(file, "<?php\n");
        writeFileSync(join(harness.workspace, "notes.txt"), "x");
        expect(existsSync(file)).toBe(true);

        const messages = await harness.waitFor((all) => methods(all).includes("workspace/didChangeWatchedFiles"));
        const notification = messages.find((message) => message.method === "workspace/didChangeWatchedFiles");
        const changes = (notification!.params as { changes: { uri: string; type: number }[] }).changes;
        expect(changes.map((change) => change.uri)).toContain(pathToFileURL(file).href);
        const accepted: number[] = [FileChangeType.Created, FileChangeType.Changed];
        expect(accepted).toContain(changes[0]!.type);
    });

    function publish(uri: string, messages: string[]): object {
        return {
            method: "textDocument/publishDiagnostics",
            params: { uri, diagnostics: messages.map((message) => ({ message })) },
        };
    }

    function diagnosticsAt(harness: Harness, uri: string): number[] {
        return harness.toClient()
            .filter((message) => message.method === "textDocument/publishDiagnostics")
            .map((message) => message.params as { uri: string; diagnostics: unknown[] })
            .filter((params) => params.uri === uri)
            .map((params) => params.diagnostics.length);
    }

    async function untilDelivered(harness: Harness, uri: string): Promise<void> {
        const deadline = Date.now() + 3000;
        while (diagnosticsAt(harness, uri).length === 0 && Date.now() < deadline) {
            await Bun.sleep(20);
        }
    }

    test("holds a diagnostic until the project is quiet, then forwards it once", async () => {
        const harness = startProxy(["--settle", "400"]);
        const file = join(harness.workspace, "held.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        await harness.waitFor((messages) => methods(messages).includes("test/emit"));
        await Bun.sleep(200);
        expect(diagnosticsAt(harness, uri)).toEqual([]);

        await untilDelivered(harness, uri);
        await Bun.sleep(600);
        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("drops a held diagnostic the server withdraws before the quiet time ends", async () => {
        const harness = startProxy(["--settle", "500"]);
        const file = join(harness.workspace, "fixed.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        harness.emit(publish(uri, []));
        await Bun.sleep(900);

        expect(diagnosticsAt(harness, uri)).toEqual([0]);
    });

    test("never forwards diagnostics for a file that is gone, and passes other server output at once", async () => {
        const harness = startProxy(["--settle", "10000"]);
        const gone = pathToFileURL(join(harness.workspace, "removed-worktree", "a.dart")).href;

        harness.emit(publish(gone, ["Target of URI doesn't exist."]));
        harness.emit({ method: "window/logMessage", params: { type: 3, message: "hello" } });
        // Starting the fake server can take over a second on a loaded machine, so wait as long as waitFor does.
        const deadline = Date.now() + 3000;
        while (harness.toClient().length === 0 && Date.now() < deadline) {
            await Bun.sleep(10);
        }

        // The log line is back long before the 10 s quiet time, and the ghost set never follows it.
        expect(harness.toClient().map((message) => message.method)).toEqual(["window/logMessage"]);
        await Bun.sleep(300);
        expect(diagnosticsAt(harness, gone)).toEqual([]);
    });

    test("removes diagnostics above the severity cap and keeps the rest of the message", async () => {
        const harness = startProxy(["--settle", "0", "--max-severity", "2"]);
        const file = join(harness.workspace, "mixed.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit({
            method: "textDocument/publishDiagnostics",
            params: { uri, version: 3, diagnostics: [
                { message: "error", severity: 1 },
                { message: "hint", severity: 4 },
                { message: "warning", severity: 2 },
            ] },
        });
        await untilDelivered(harness, uri);

        const [forwarded] = harness.toClient();
        expect(forwarded).toEqual({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri, version: 3, diagnostics: [
                { message: "error", severity: 1 },
                { message: "warning", severity: 2 },
            ] },
        });
    });

    test("a publish whose diagnostics are all filtered goes out empty, at once, never held", async () => {
        const harness = startProxy(["--settle", "60000", "--max-severity", "1"]);
        const file = join(harness.workspace, "hints.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit({
            method: "textDocument/publishDiagnostics",
            params: { uri, diagnostics: [{ message: "hint", severity: 4 }] },
        });
        const deadline = Date.now() + 1500;
        while (harness.toClient().length === 0 && Date.now() < deadline) {
            await Bun.sleep(10);
        }

        expect(diagnosticsAt(harness, uri)).toEqual([0]);
    });

    test("drops a held diagnostic whose file is deleted before the quiet time ends", async () => {
        const harness = startProxy(["--settle", "400"]);
        const file = join(harness.workspace, "doomed.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        await harness.waitFor((messages) => methods(messages).includes("test/emit"));
        rmSync(file);
        await Bun.sleep(900);

        expect(diagnosticsAt(harness, uri)).toEqual([]);
    });

    test("forwards a held diagnostic after the max-hold time while edits keep the project busy", async () => {
        const harness = startProxy(["--settle", "5000", "--max-hold", "500"]);
        const file = join(harness.workspace, "never-quiet.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");
        harness.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "dart", version: 1, text: "a\n" } } });
        await harness.waitFor((messages) => messages.length === 1);

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        const start = Date.now();
        while (diagnosticsAt(harness, uri).length === 0 && Date.now() - start < 2500) {
            harness.send({ method: "textDocument/didSave", params: { textDocument: { uri } } });
            await Bun.sleep(100);
        }

        expect(diagnosticsAt(harness, uri)).toEqual([1]);
        expect(Date.now() - start).toBeLessThan(2500);
    });

    test("flushes held diagnostics ahead of raw bytes when the server's framing is abandoned", async () => {
        const harness = startProxy(["--settle", "60000"]);
        const file = join(harness.workspace, "flushed.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        harness.emitRaw("Broken-Header\r\n\r\nxx");
        await untilDelivered(harness, uri);

        // Delivered long before the 60 s quiet time, and whole: the client parser read it as a frame.
        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("holds and filters a publish from a server that escapes the slash in the method name", async () => {
        const harness = startProxy(["--settle", "400", "--max-severity", "1"]);
        const file = join(harness.workspace, "escaped.swift");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        const body = JSON.stringify({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri, diagnostics: [{ message: "never used", severity: 2 }, { message: "type error", severity: 1 }] },
        }).replace("textDocument/publishDiagnostics", "textDocument\\/publishDiagnostics");
        expect(body).toContain("textDocument\\/publishDiagnostics");
        harness.emitRaw(frameMessage(body).toString("utf8"));
        await harness.waitFor((messages) => methods(messages).includes("test/raw"));
        await Bun.sleep(200);
        expect(diagnosticsAt(harness, uri)).toEqual([]);

        await untilDelivered(harness, uri);
        await Bun.sleep(300);
        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("holds a publish while the server reports indexing, then releases it after the quiet time", async () => {
        const harness = startProxy(["--settle", "300", "--busy", "indexingStarted,indexingEnded"]);
        const file = join(harness.workspace, "indexing.php");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit({ method: "indexingStarted" });
        harness.emit(publish(uri, ["Undefined type 'PHPUnit\\Framework\\TestCase'."]));
        await harness.waitFor((messages) => methods(messages).filter((method) => method === "test/emit").length === 2);
        await Bun.sleep(900);
        // Three times the settle time has passed, and the server is still indexing.
        expect(diagnosticsAt(harness, uri)).toEqual([]);

        harness.emit({ method: "indexingEnded" });
        await untilDelivered(harness, uri);
        expect(diagnosticsAt(harness, uri)).toEqual([1]);
        expect(harness.toClient().map((message) => message.method)).toContain("indexingStarted");
        expect(harness.toClient().map((message) => message.method)).toContain("indexingEnded");
    });

    test("flushes held diagnostics when the server's output ends", async () => {
        const harness = startProxy(["--settle", "60000"]);
        const file = join(harness.workspace, "ended.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        harness.send({ method: "test/exit", params: {} });
        const exit = harness.exitCode();
        await exit;

        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("still releases a held diagnostic after the client's framing is abandoned", async () => {
        const harness = startProxy(["--settle", "300"]);
        const file = join(harness.workspace, "client-raw.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        await harness.waitFor((messages) => methods(messages).includes("test/emit"));
        harness.proxy.stdin.write("Broken-Header\r\n\r\n");
        await untilDelivered(harness, uri);

        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("an edit in the same project restarts the quiet time of a held diagnostic", async () => {
        const harness = startProxy(["--settle", "500"]);
        const file = join(harness.workspace, "busy.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");
        harness.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "dart", version: 1, text: "a\n" } } });
        await harness.waitFor((messages) => messages.length === 1);

        harness.emit(publish(uri, ["Undefined name 'A'."]));
        await Bun.sleep(350);
        harness.send({ method: "textDocument/didSave", params: { textDocument: { uri } } });
        await Bun.sleep(350);
        expect(diagnosticsAt(harness, uri)).toEqual([]);

        await untilDelivered(harness, uri);
        expect(diagnosticsAt(harness, uri)).toEqual([1]);
    });

    test("writes nothing synthetic once framing is abandoned", async () => {
        const harness = startProxy([]);
        const file = join(harness.workspace, "raw.dart");
        const uri = pathToFileURL(file).href;
        writeFileSync(file, "a\n");

        harness.send({ method: "textDocument/didOpen", params: { textDocument: {
            uri,
            languageId: "dart",
            version: 1,
            text: "a\n",
        } } });
        await harness.waitFor((messages) => messages.length === 1);

        harness.proxy.stdin.write("Broken-Header\r\n\r\n");
        await harness.waitFor((messages) => messages.length === 2);
        writeFileSync(file, "b\n");
        harness.proxy.stdin.write("tail");

        // Longer than the 150 ms directory debounce, so a watcher that survived would have fired.
        await Bun.sleep(600);
        const raw = harness.logged().slice(1).map((message) => message.raw).join("");
        expect(raw).toBe("Broken-Header\r\n\r\ntail");
        expect(methods(harness.logged()).filter((method) => method !== undefined)).toEqual(["textDocument/didOpen"]);
    });
});
