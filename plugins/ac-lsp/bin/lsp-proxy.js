#!/usr/bin/env node
// src/lsp-proxy.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var MAX_HEADER_BYTES = 64 * 1024;
var MAX_BODY_BYTES = 64 * 1024 * 1024;
var HEADER_TERMINATOR = `\r
\r
`;
var DIRECTORY_DEBOUNCE_MS = 150;
var WATCH_BATCH_MS = 300;
var LOG_PREFIX = "[ac-lsp-proxy]";

class FrameParser {
  failure;
  chunks = [];
  length = 0;
  frameLength;
  bodyStart = 0;
  push(chunk) {
    if (this.failure !== undefined) {
      return [
        {
          kind: "raw",
          raw: chunk
        }
      ];
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    const events = [];
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
        body: buffer.subarray(this.bodyStart, this.frameLength)
      });
      const rest = buffer.subarray(this.frameLength);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.length = rest.length;
      this.frameLength = undefined;
    }
    return events;
  }
  drain() {
    const rest = this.collapse();
    this.chunks = [];
    this.length = 0;
    this.frameLength = undefined;
    return rest;
  }
  readHeader(buffer) {
    const end = buffer.indexOf(HEADER_TERMINATOR);
    if (end === -1) {
      return buffer.length > MAX_HEADER_BYTES ? "header block exceeds 64 KiB" : undefined;
    }
    if (end > MAX_HEADER_BYTES) {
      return "header block exceeds 64 KiB";
    }
    let contentLength;
    for (const line of buffer.subarray(0, end).toString("latin1").split(`\r
`)) {
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
    return;
  }
  abandon(reason) {
    this.failure = reason;
    return {
      kind: "raw",
      raw: this.drain()
    };
  }
  collapse() {
    if (this.chunks.length !== 1) {
      this.chunks = [Buffer.concat(this.chunks, this.length)];
    }
    return this.chunks[0];
  }
}
function frameMessage(body) {
  const bytes = Buffer.from(body, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${bytes.length}${HEADER_TERMINATOR}`, "latin1"),
    bytes
  ]);
}
function applyContentChanges(text, changes) {
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
function offsetAt(text, position) {
  let lineStart = 0;
  for (let line = 0;line < position.line; line++) {
    const breakAt = nextLineBreak(text, lineStart);
    if (breakAt === -1) {
      return text.length;
    }
    lineStart = breakAt + (text.startsWith(`\r
`, breakAt) ? 2 : 1);
  }
  const lineEnd = nextLineBreak(text, lineStart);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(lineStart + Math.max(position.character, 0), limit);
}
function nextLineBreak(text, from) {
  for (let index = from;index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      return index;
    }
  }
  return -1;
}

class DocumentTable {
  documents = new Map;
  apply(message) {
    const textDocument = message.params?.textDocument;
    const uri = textDocument?.uri;
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
          stamp: undefined
        });
        return;
      case "textDocument/didChange": {
        const document = this.documents.get(uri);
        if (document === undefined) {
          return;
        }
        document.text = applyContentChanges(document.text, message.params.contentChanges ?? []);
        document.version = Math.max(document.version, Number(textDocument.version ?? 0));
        document.stamp = undefined;
        return;
      }
      case "textDocument/didClose":
        this.documents.delete(uri);
        return;
    }
  }
  get(uri) {
    return this.documents.get(uri);
  }
  all() {
    return this.documents.values();
  }
  directories() {
    const directories = new Set;
    for (const document of this.documents.values()) {
      if (document.path !== undefined) {
        directories.add(dirname(document.path));
      }
    }
    return directories;
  }
}
var DOCUMENT_SYNC_METHODS = new Set([
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose"
]);
function syncedUri(message) {
  const uri = message.params?.textDocument?.uri;
  return DOCUMENT_SYNC_METHODS.has(message.method) && typeof uri === "string" ? uri : undefined;
}
function filePathOf(uri) {
  return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
}
function sweepDocuments(table, deps, options) {
  const bodies = [];
  for (const document of table.all()) {
    if (document.path === undefined || document.uri === options.skipUri) {
      continue;
    }
    if (options.directory !== undefined && dirname(document.path) !== options.directory) {
      continue;
    }
    const stamp = deps.stat(document.path);
    if (stamp === undefined || sameStamp(stamp, document.stamp)) {
      continue;
    }
    document.stamp = stamp;
    const text = deps.readText(document.path);
    if (text === undefined || text === document.text) {
      continue;
    }
    document.text = text;
    document.version += 1;
    bodies.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: {
          uri: document.uri,
          version: document.version
        },
        contentChanges: [
          {
            text
          }
        ]
      }
    }));
  }
  return bodies;
}
function sameStamp(current, previous) {
  return previous !== undefined && previous.mtimeMs === current.mtimeMs && previous.size === current.size;
}
var FileChangeType = {
  Created: 1,
  Changed: 2,
  Deleted: 3
};
var IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".dart_tool",
  "build",
  "storage",
  ".idea"
]);
var IGNORED_SEQUENCES = [
  [
    ".claude",
    "worktrees"
  ],
  [
    "vendor",
    "composer"
  ]
];
function isIgnoredPath(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  for (let index = 0;index < segments.length; index++) {
    const segment = segments[index];
    if (IGNORED_SEGMENTS.has(segment)) {
      return true;
    }
    if (IGNORED_SEQUENCES.some(([first, second]) => segment === first && segments[index + 1] === second)) {
      return true;
    }
  }
  return false;
}
function isReportablePath(relativePath, extensions) {
  return extensions.some((extension) => relativePath.endsWith(extension)) && !isIgnoredPath(relativePath);
}
function isWatchLimitError(error) {
  const code = error?.code;
  return code === "EMFILE" || code === "ENOSPC";
}

class DirectoryTreeWatcher {
  root;
  onEvent;
  log;
  watchers = new Map;
  exhausted = false;
  closed = false;
  constructor(root, onEvent, log) {
    this.root = root;
    this.onEvent = onEvent;
    this.log = log;
  }
  start() {
    return this.walk(this.root, false);
  }
  watchedDirectories() {
    return [...this.watchers.keys()];
  }
  close() {
    this.closed = true;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
  async walk(start, announceFiles) {
    const queue = [
      start
    ];
    for (let directory = queue.shift();directory !== undefined; directory = queue.shift()) {
      if (this.closed || this.exhausted || this.watchers.has(directory) || !this.watchDirectory(directory)) {
        continue;
      }
      let entries;
      try {
        entries = await readdir(directory, {
          withFileTypes: true
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
  watchDirectory(directory) {
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
  handleEvent(eventType, path) {
    if (this.closed) {
      return;
    }
    this.onEvent(eventType, path);
    if (eventType !== "rename" || isIgnoredPath(relative(this.root, path))) {
      return;
    }
    let stats;
    try {
      stats = statSync(path, {
        throwIfNoEntry: false
      });
    } catch (error) {
      this.log("tree-stat", `cannot tell whether ${path} is a new directory: ${errorMessage(error)}`);
      return;
    }
    if (stats?.isDirectory() === true) {
      this.walk(path, true);
      return;
    }
    if (stats === undefined) {
      this.forget(path);
    }
  }
  forget(path) {
    for (const [directory, watcher] of this.watchers) {
      if (directory === path || directory.startsWith(`${path}${sep}`)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
  }
  handleWatchFailure(directory, error) {
    this.watchers.get(directory)?.close();
    this.watchers.delete(directory);
    if (isWatchLimitError(error)) {
      this.exhausted = true;
      this.log("tree-limit", `out of watch handles, no further workspace directories watched: ${errorMessage(error)}`);
      return;
    }
    this.log("tree-skip", `skipping a directory that cannot be watched ${directory}: ${errorMessage(error)}`);
  }
}
function watchEventType(eventType, exists) {
  if (!exists) {
    return FileChangeType.Deleted;
  }
  return eventType === "rename" ? FileChangeType.Created : FileChangeType.Changed;
}

class WatchedFileBatch {
  changes = new Map;
  record(uri, type) {
    this.changes.set(uri, type);
  }
  take() {
    const changes = [...this.changes].map(([uri, type]) => ({
      uri,
      type
    }));
    this.changes.clear();
    return changes;
  }
  get size() {
    return this.changes.size;
  }
}
function resolveWorkspaceRoot(params, cwd) {
  const candidates = [
    params?.workspaceFolders?.[0]?.uri,
    params?.rootUri
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("file:")) {
      return fileURLToPath(candidate);
    }
  }
  return cwd;
}
function parseProxyArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    throw new Error('missing "--" before the server command');
  }
  const command = argv[separator + 1];
  if (command === undefined) {
    throw new Error('missing server command after "--"');
  }
  let watchRoot = false;
  const extensions = [];
  const flags = argv.slice(0, separator);
  for (let index = 0;index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--watch-root") {
      watchRoot = true;
      continue;
    }
    if (flag === "--ext" && flags[index + 1] !== undefined) {
      extensions.push(flags[++index]);
      continue;
    }
    throw new Error(`unknown or incomplete option "${flag}"`);
  }
  return {
    watchRoot,
    extensions: extensions.length > 0 ? extensions : [".php"],
    command,
    args: argv.slice(separator + 2)
  };
}
function createOnceLogger() {
  const seen = new Set;
  return (key, message) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    process.stderr.write(`${LOG_PREFIX} ${message}
`);
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function diskDeps(log) {
  return {
    stat: (path) => {
      try {
        const stats = statSync(path, {
          throwIfNoEntry: false
        });
        return stats === undefined ? undefined : {
          mtimeMs: stats.mtimeMs,
          size: stats.size
        };
      } catch (error) {
        log("stat", `stat failed, skipping sync for ${path}: ${errorMessage(error)}`);
        return;
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        log("read", `read failed, skipping sync for ${path}: ${errorMessage(error)}`);
        return;
      }
    }
  };
}
function runLspProxy(argv) {
  let options;
  try {
    options = parseProxyArgs(argv);
  } catch (error) {
    process.stderr.write(`${LOG_PREFIX} ${errorMessage(error)}
` + `usage: lsp-proxy [--watch-root] [--ext .php]... -- <server command> [args...]
`);
    process.exit(2);
  }
  const log = createOnceLogger();
  const deps = diskDeps(log);
  const table = new DocumentTable;
  const parser = new FrameParser;
  const server = spawn(options.command, options.args, {
    stdio: [
      "pipe",
      "pipe",
      "inherit"
    ]
  });
  const directoryWatchers = new Map;
  const directoryTimers = new Map;
  let directoryWatchDisabled = false;
  let rootWatcher;
  let pendingRoot;
  let batchTimer;
  const batch = new WatchedFileBatch;
  let finished = false;
  const passthrough = () => parser.failure !== undefined;
  const toServer = (bytes) => {
    if (!server.stdin.write(bytes)) {
      process.stdin.pause();
    }
  };
  server.stdin.on("drain", () => process.stdin.resume());
  server.stdin.on("error", (error) => log("server-stdin", `writing to the server failed: ${errorMessage(error)}`));
  const writeSweep = (sweepOptions) => {
    if (passthrough()) {
      return;
    }
    for (const body of sweepDocuments(table, deps, sweepOptions)) {
      toServer(frameMessage(body));
    }
  };
  const closeDirectoryWatcher = (directory) => {
    directoryWatchers.get(directory)?.close();
    directoryWatchers.delete(directory);
    clearTimeout(directoryTimers.get(directory));
    directoryTimers.delete(directory);
  };
  const disableDirectoryWatching = (reason) => {
    log("directory-watch", `directory watching disabled, syncing on client messages only: ${reason}`);
    directoryWatchDisabled = true;
    for (const directory of [...directoryWatchers.keys()]) {
      closeDirectoryWatcher(directory);
    }
  };
  const handleDirectoryWatchFailure = (directory, error) => {
    if (isWatchLimitError(error)) {
      disableDirectoryWatching(errorMessage(error));
      return;
    }
    closeDirectoryWatcher(directory);
    log("directory-skip", `cannot watch ${directory}, syncing it on client messages: ${errorMessage(error)}`);
  };
  const watchDirectory = (directory) => {
    try {
      const watcher = watch(directory, () => {
        clearTimeout(directoryTimers.get(directory));
        directoryTimers.set(directory, setTimeout(() => {
          directoryTimers.delete(directory);
          writeSweep({
            directory
          });
        }, DIRECTORY_DEBOUNCE_MS));
      });
      watcher.on("error", (error) => handleDirectoryWatchFailure(directory, error));
      directoryWatchers.set(directory, watcher);
    } catch (error) {
      handleDirectoryWatchFailure(directory, error);
    }
  };
  const reconcileDirectoryWatchers = () => {
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
  const flushBatch = () => {
    batchTimer = undefined;
    const changes = batch.take();
    if (changes.length === 0 || passthrough()) {
      return;
    }
    toServer(frameMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: {
        changes
      }
    })));
  };
  const recordTreeEvent = (root, eventType, path) => {
    if (!isReportablePath(relative(root, path), options.extensions)) {
      return;
    }
    batch.record(pathToFileURL(path).href, watchEventType(eventType, existsSync(path)));
    batchTimer ??= setTimeout(flushBatch, WATCH_BATCH_MS);
  };
  const watchRoot = (root) => {
    if (process.platform === "linux") {
      const tree = new DirectoryTreeWatcher(root, (eventType, path) => recordTreeEvent(root, eventType, path), log);
      rootWatcher = tree;
      tree.start();
      return;
    }
    try {
      const watcher = watch(root, {
        recursive: true
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
  const stopWatching = () => {
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
  const handleMessage = (raw, body) => {
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch (error) {
      log("json", `forwarding a client body that is not JSON untracked: ${errorMessage(error)}`);
    }
    writeSweep({
      skipUri: message === undefined ? undefined : syncedUri(message)
    });
    toServer(raw);
    if (message === undefined) {
      return;
    }
    table.apply(message);
    reconcileDirectoryWatchers();
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
  process.stdin.on("data", (chunk) => {
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
    end: false
  });
  process.stdout.on("error", (error) => {
    log("stdout", `writing to the client failed, stopping the server: ${errorMessage(error)}`);
    server.kill("SIGTERM");
  });
  const finish = (code) => {
    if (finished) {
      return;
    }
    finished = true;
    stopWatching();
    if (process.stdout.destroyed) {
      process.exit(code);
    }
    process.stdout.write("", () => process.exit(code));
  };
  server.on("error", (error) => {
    log("spawn", `server process failed: ${errorMessage(error)}`);
    finish(1);
  });
  server.on("close", (code) => finish(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.kill(signal);
    });
  }
}

// src/lsp-proxy-main.ts
runLspProxy(process.argv.slice(2));
