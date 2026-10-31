// Contract pinned here: the stdio LSP proxy forwards every client and server byte unchanged, and only
// inserts whole synthetic notifications. Framing survives arbitrary chunking and falls back to raw
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
    applyContentChanges,
    DirectoryTreeWatcher,
    DocumentTable,
    FileChangeType,
    frameMessage,
    FrameParser,
    isIgnoredPath,
    isReportablePath,
    isWatchLimitError,
    MAX_BODY_BYTES,
    MAX_HEADER_BYTES,
    parseProxyArgs,
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
            command: "srv",
            args: ["--stdio"],
        });
    });

    test("defaults to no root watch and the .php extension", () => {
        expect(parseProxyArgs(["--", "dart", "language-server"])).toEqual({
            watchRoot: false,
            extensions: [".php"],
            command: "dart",
            args: ["language-server"],
        });
    });

    test("rejects a missing separator, a missing command and an unknown flag", () => {
        expect(() => parseProxyArgs(["dart"])).toThrow();
        expect(() => parseProxyArgs(["--"])).toThrow();
        expect(() => parseProxyArgs(["--nope", "--", "dart"])).toThrow();
        expect(() => parseProxyArgs(["--ext", "--", "dart"])).toThrow();
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
            `import { FrameParser } from ${JSON.stringify(proxyModule)};`,
            `const parser = new FrameParser();`,
            `process.stdin.on("data", (chunk) => {`,
            `    for (const event of parser.push(chunk)) {`,
            `        const line = event.kind === "message"`,
            `            ? event.body.toString("utf8")`,
            `            : JSON.stringify({ raw: event.raw.toString("utf8") });`,
            `        appendFileSync(process.argv[2], line + "\\n");`,
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

        return {
            workspace,
            logPath,
            proxy,
            send: (message: object): void => {
                proxy.stdin.write(frameMessage(JSON.stringify({ jsonrpc: "2.0", ...message })));
            },
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
