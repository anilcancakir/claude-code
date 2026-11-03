#!/usr/bin/env node
// src/lsp-proxy.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
          languageId: String(textDocument.languageId ?? ""),
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
var EDIT_METHODS = new Set([
  ...DOCUMENT_SYNC_METHODS,
  "textDocument/didSave"
]);
function editedUri(message) {
  const uri = message.params?.textDocument?.uri;
  return EDIT_METHODS.has(message.method) && typeof uri === "string" ? uri : undefined;
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
    options.onChange?.(document.uri);
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
  ".idea",
  ".worktrees"
]);
var IGNORED_SEQUENCES = [
  [
    ".claude",
    "worktrees"
  ],
  [
    ".ac",
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
function rootAtProject(params, cwd, exists, home = homedir()) {
  const root = resolveWorkspaceRoot(params, cwd);
  const project = projectOfDirectory(root, exists);
  if (project === root || project === home || project === dirname(project)) {
    return;
  }
  const uri = pathToFileURL(project).href;
  return {
    ...params,
    rootUri: uri,
    rootPath: project,
    workspaceFolders: [{ uri, name: basename(project) }]
  };
}
var DEFAULT_SETTLE_MS = 6000;
var DEFAULT_MAX_HOLD_MS = 300000;
function findProjectRoot(path, exists) {
  let directory = dirname(path);
  for (;; ) {
    if (exists(join(directory, ".git"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return dirname(path);
    }
    directory = parent;
  }
}
function projectOfDirectory(directory, exists) {
  return findProjectRoot(join(directory, "_"), exists);
}
var NOISE_PROFILES = {
  php: [
    {
      codes: ["P1009", "P1010", "P1011", "P1012", "P1013", "P1014"],
      requires: ["composer.json"],
      missing: ["vendor"],
      withinProject: true
    },
    {
      codes: ["P1009", "P1010", "P1011", "P1012", "P1013", "P1014"],
      foreignProject: true
    }
  ],
  typescript: [
    {
      codes: ["2307", "2792", "7016", "2688", "2580", "2591", "2581", "2592", "2582", "2593", "7026"],
      keep: /module '[./]/,
      missing: ["node_modules"]
    }
  ],
  swift: [
    {
      message: /^The package access level used on/
    },
    {
      message: /^No such module '/,
      missing: ["Package.swift", "compile_commands.json", "buildServer.json"]
    }
  ]
};
function isForeignProject(path, options) {
  const workspace = options.workspaceProject;
  const project = options.projectOf(path);
  if (workspace === undefined || project === workspace || !options.hasAncestorEntry(join(project, "_"), ".git", project)) {
    return false;
  }
  const inside = relative(workspace, project);
  return inside.startsWith("..") || isAbsolute(inside) || isIgnoredPath(inside);
}
function isNoise(diagnostic, path, options) {
  const severity = typeof diagnostic.severity === "number" ? diagnostic.severity : 1;
  if (severity > options.maxSeverity) {
    return true;
  }
  const message = String(diagnostic.message ?? "");
  const code = String(diagnostic.code ?? "");
  return options.rules.some((rule) => {
    const matched = rule.codes?.includes(code) === true || rule.message?.test(message) === true;
    if (!matched || rule.keep?.test(message) === true) {
      return false;
    }
    if (rule.foreignProject === true && !isForeignProject(path, options)) {
      return false;
    }
    const ceiling = rule.withinProject === true ? options.projectOf(path) : undefined;
    if (rule.requires !== undefined && !rule.requires.some((name) => options.hasAncestorEntry(path, name, ceiling))) {
      return false;
    }
    return rule.missing === undefined || rule.missing.every((name) => !options.hasAncestorEntry(path, name, ceiling));
  });
}
function filterDiagnostics(params, options) {
  const uri = params.uri;
  if (typeof uri !== "string" || !uri.startsWith("file:") || !Array.isArray(params.diagnostics)) {
    return;
  }
  let path;
  try {
    path = fileURLToPath(uri);
  } catch {
    return;
  }
  const diagnostics = params.diagnostics;
  const kept = diagnostics.filter((diagnostic) => !isNoise(diagnostic, path, options));
  return kept.length === diagnostics.length ? undefined : {
    ...params,
    diagnostics: kept
  };
}
function ancestorEntryOnDisk(path, name, ceiling) {
  for (let directory = dirname(path);; directory = dirname(directory)) {
    if (existsSync(join(directory, name))) {
      return true;
    }
    if (directory === ceiling || dirname(directory) === directory) {
      return false;
    }
  }
}

class DiagnosticGate {
  deps;
  settleMs;
  maxHoldMs;
  held = new Map;
  activity = new Map;
  busy = false;
  idleSince = 0;
  constructor(deps, settleMs, maxHoldMs) {
    this.deps = deps;
    this.settleMs = settleMs;
    this.maxHoldMs = maxHoldMs;
  }
  get size() {
    return this.held.size;
  }
  offer(raw, params) {
    const uri = params.uri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) {
      return [raw];
    }
    if (!Array.isArray(params.diagnostics) || params.diagnostics.length === 0) {
      this.held.delete(uri);
      return [raw];
    }
    let path;
    try {
      path = fileURLToPath(uri);
    } catch {
      return [raw];
    }
    if (!this.deps.fileExists(path)) {
      this.held.delete(uri);
      return [];
    }
    if (this.settleMs <= 0) {
      return [raw];
    }
    const now = this.deps.now();
    this.held.set(uri, {
      raw: Buffer.from(raw),
      path,
      project: this.deps.projectOf(path),
      firstHeld: this.held.get(uri)?.firstHeld ?? now,
      lastOffer: now
    });
    return [];
  }
  setBusy(busy) {
    if (this.busy && !busy) {
      this.idleSince = this.deps.now();
    }
    this.busy = busy;
  }
  touch(uri) {
    if (!uri.startsWith("file:")) {
      return;
    }
    try {
      this.activity.set(this.deps.projectOf(fileURLToPath(uri)), this.deps.now());
    } catch {}
  }
  release() {
    const now = this.deps.now();
    const frames = [];
    for (const [uri, held] of this.held) {
      if (!this.deps.fileExists(held.path)) {
        this.held.delete(uri);
      } else if (now >= this.dueAt(held)) {
        frames.push(held.raw);
        this.held.delete(uri);
      }
    }
    return frames;
  }
  flush() {
    const frames = [];
    for (const held of this.held.values()) {
      if (this.deps.fileExists(held.path)) {
        frames.push(held.raw);
      }
    }
    this.held.clear();
    return frames;
  }
  nextWake() {
    let earliest;
    for (const held of this.held.values()) {
      const due = this.dueAt(held);
      earliest = earliest === undefined ? due : Math.min(earliest, due);
    }
    return earliest === undefined ? undefined : Math.max(0, earliest - this.deps.now());
  }
  dueAt(held) {
    const limit = held.firstHeld + this.maxHoldMs;
    if (this.busy) {
      return limit;
    }
    const quiet = Math.max(held.lastOffer, this.activity.get(held.project) ?? 0, this.idleSince) + this.settleMs;
    return Math.min(quiet, limit);
  }
}
function createBusyReader(busy) {
  const start = Buffer.from(JSON.stringify(busy.start));
  const end = Buffer.from(JSON.stringify(busy.end));
  return (body) => {
    if (!body.includes(start) && !body.includes(end)) {
      return;
    }
    try {
      const message = JSON.parse(body.toString("utf8"));
      if (message.id !== undefined) {
        return;
      }
      return message.method === busy.start ? "start" : message.method === busy.end ? "end" : undefined;
    } catch {
      return;
    }
  };
}
var MAX_TIMER_MS = 2147483647;
function parseMilliseconds(flag, value) {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) > MAX_TIMER_MS) {
    throw new Error(`"${flag}" needs a whole number of milliseconds up to ${MAX_TIMER_MS}`);
  }
  return Number(value);
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
  let gitRoot = false;
  let settleMs = DEFAULT_SETTLE_MS;
  let maxHoldMs = DEFAULT_MAX_HOLD_MS;
  let maxSeverity = 4;
  let busy;
  let idleMs;
  const profiles = [];
  const extensions = [];
  const flags = argv.slice(0, separator);
  for (let index = 0;index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--watch-root") {
      watchRoot = true;
      continue;
    }
    if (flag === "--git-root") {
      gitRoot = true;
      continue;
    }
    if (flag === "--ext" && flags[index + 1] !== undefined) {
      extensions.push(flags[++index]);
      continue;
    }
    if (flag === "--settle") {
      settleMs = parseMilliseconds(flag, flags[++index]);
      continue;
    }
    if (flag === "--max-hold") {
      maxHoldMs = parseMilliseconds(flag, flags[++index]);
      continue;
    }
    if (flag === "--max-severity") {
      const value = flags[++index];
      if (value === undefined || !/^[1-4]$/.test(value)) {
        throw new Error('"--max-severity" needs 1 (errors), 2 (and warnings), 3 (and information) or 4 (everything)');
      }
      maxSeverity = Number(value);
      continue;
    }
    if (flag === "--profile") {
      const name = flags[++index];
      if (name === undefined || !Object.hasOwn(NOISE_PROFILES, name)) {
        throw new Error(`"--profile" needs one of: ${Object.keys(NOISE_PROFILES).join(", ")}`);
      }
      profiles.push(name);
      continue;
    }
    if (flag === "--busy") {
      const match = /^([^\s,"]+),([^\s,"]+)$/.exec(flags[++index] ?? "");
      if (match === null || match[1] === match[2]) {
        throw new Error('"--busy" needs two different notification methods, <start>,<end>');
      }
      busy = { start: match[1], end: match[2] };
      continue;
    }
    if (flag === "--idle") {
      const ms = parseMilliseconds(flag, flags[++index]);
      idleMs = ms > 0 ? ms : undefined;
      continue;
    }
    throw new Error(`unknown or incomplete option "${flag}"`);
  }
  return {
    watchRoot,
    gitRoot,
    extensions: extensions.length > 0 ? extensions : [".php"],
    settleMs,
    maxHoldMs,
    maxSeverity,
    profiles,
    busy,
    idleMs,
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
function diskGateDeps() {
  const roots = new Map;
  return {
    now: () => Date.now(),
    fileExists: (path) => existsSync(path),
    projectOf: (path) => {
      const directory = dirname(path);
      let root = roots.get(directory);
      if (root === undefined) {
        root = findProjectRoot(path, existsSync);
        roots.set(directory, root);
      }
      return root;
    }
  };
}
var PUBLISH_MARKERS = [
  Buffer.from('"textDocument/publishDiagnostics"'),
  Buffer.from('"textDocument\\/publishDiagnostics"')
];
function publishMessage(body) {
  if (!PUBLISH_MARKERS.some((marker) => body.includes(marker))) {
    return;
  }
  try {
    const message = JSON.parse(body.toString("utf8"));
    return message.method === "textDocument/publishDiagnostics" && typeof message.params === "object" && message.params !== null ? message : undefined;
  } catch {
    return;
  }
}
var SHUTDOWN_GRACE_MS = 5000;
var TERMINATE_GRACE_MS = 3000;
function runLspProxy(argv) {
  let options;
  try {
    options = parseProxyArgs(argv);
  } catch (error) {
    process.stderr.write(`${LOG_PREFIX} ${errorMessage(error)}
` + `usage: lsp-proxy [--watch-root] [--git-root] [--ext .php]... [--settle <ms>] [--max-hold <ms>] [--max-severity <1-4>] [--profile <name>]... [--busy <start>,<end>] [--idle <ms>] -- <server command> [args...]
`);
    process.exit(2);
  }
  const log = createOnceLogger();
  const deps = diskDeps(log);
  const table = new DocumentTable;
  const parser = new FrameParser;
  let server;
  let serverParser = new FrameParser;
  const gateDeps = diskGateDeps();
  const gate = new DiagnosticGate(gateDeps, options.settleMs, options.maxHoldMs);
  const filterOptions = {
    maxSeverity: options.maxSeverity,
    rules: options.profiles.flatMap((name) => NOISE_PROFILES[name] ?? []),
    hasAncestorEntry: ancestorEntryOnDisk,
    projectOf: gateDeps.projectOf
  };
  const busyEdge = options.busy === undefined ? undefined : createBusyReader(options.busy);
  let gateTimer;
  let gateClosed = false;
  const idleMs = options.idleMs ?? 0;
  const tracksIdle = idleMs > 0;
  let state = "running";
  let idleTimer;
  let killTimer;
  let serverBusy = false;
  let clientEnded = false;
  const clientRequests = new Set;
  const serverRequests = new Set;
  const queued = [];
  let initializeParams;
  let initializedFrame;
  let configurationFrame;
  let proxyRequests = 0;
  let initializeId;
  let shutdownId;
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
  const writeSweep = (sweepOptions) => {
    if (passthrough()) {
      return;
    }
    const synced = {
      ...sweepOptions,
      onChange: (uri) => gate.touch(uri)
    };
    const bodies = sweepDocuments(table, deps, synced);
    if (state !== "running") {
      return;
    }
    for (const body of bodies) {
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
    if (changes.length === 0 || passthrough() || state !== "running") {
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
    const uri = pathToFileURL(path).href;
    gate.touch(uri);
    batch.record(uri, watchEventType(eventType, existsSync(path)));
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
  const parseClientBody = (body) => {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch (error) {
      log("json", `forwarding a client body that is not JSON untracked: ${errorMessage(error)}`);
      return;
    }
  };
  const canIdleStop = () => tracksIdle && state === "running" && initializedFrame !== undefined && !passthrough() && serverParser.failure === undefined;
  const restartIdleClock = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (canIdleStop()) {
      idleTimer = setTimeout(stopWhenIdle, idleMs);
    }
  };
  const stopWhenIdle = () => {
    idleTimer = undefined;
    if (!canIdleStop()) {
      return;
    }
    if (clientRequests.size > 0 || serverRequests.size > 0 || serverBusy || gateTimer !== undefined) {
      idleTimer = setTimeout(stopWhenIdle, idleMs);
      return;
    }
    stopServer();
  };
  const proxyRequestId = (method) => `ac-lsp-proxy:${method}:${++proxyRequests}`;
  const stopServer = () => {
    state = "stopping";
    log("idle-stop", `stopping the language server after ${idleMs} ms without client messages`);
    shutdownId = proxyRequestId("shutdown");
    toServer(frameMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: shutdownId,
      method: "shutdown"
    })));
    const child = server;
    killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
    }, SHUTDOWN_GRACE_MS);
  };
  const restartServer = () => {
    state = "starting";
    log("restart", "restarting the language server for a client message");
    startServer();
    initializeId = proxyRequestId("initialize");
    toServer(frameMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: initializeParams
    })));
  };
  const replaySession = () => {
    state = "running";
    toServer(initializedFrame);
    if (configurationFrame !== undefined) {
      toServer(configurationFrame);
    }
    sweepDocuments(table, deps, {
      onChange: (uri) => gate.touch(uri)
    });
    for (const document of table.all()) {
      toServer(frameMessage(JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text
          }
        }
      })));
    }
    for (const entry of queued.splice(0)) {
      acceptClient(entry.event, entry.message);
    }
    if (clientEnded) {
      server.stdin.end();
    }
    restartIdleClock();
  };
  const serverStopped = () => {
    clearTimeout(killTimer);
    killTimer = undefined;
    state = "stopped";
    shutdownId = undefined;
    clientRequests.clear();
    serverRequests.clear();
    clearTimeout(gateTimer);
    gateTimer = undefined;
    gate.flush();
    gate.setBusy(false);
    serverBusy = false;
    process.stdin.resume();
    if (clientEnded) {
      finish(0);
      return;
    }
    for (const entry of queued.splice(0)) {
      acceptClient(entry.event, entry.message);
    }
  };
  const recordSession = (raw, message) => {
    if (message.id !== undefined && message.method === undefined) {
      serverRequests.delete(message.id);
    } else if (message.id !== undefined) {
      clientRequests.add(message.id);
    }
    if (message.method === "initialize") {
      initializeParams = message.params;
    } else if (message.method === "initialized") {
      initializedFrame = Buffer.from(raw);
    } else if (message.method === "workspace/didChangeConfiguration") {
      configurationFrame = Buffer.from(raw);
    }
  };
  const handleMessage = (raw, message) => {
    writeSweep({
      skipUri: message === undefined ? undefined : syncedUri(message)
    });
    if (message?.method === "initialize") {
      const rerooted = options.gitRoot ? rootAtProject(message.params, process.cwd(), existsSync) : undefined;
      if (rerooted !== undefined) {
        message.params = rerooted;
        raw = frameMessage(JSON.stringify(message));
      }
      filterOptions.workspaceProject = projectOfDirectory(resolveWorkspaceRoot(message.params, process.cwd()), existsSync);
    }
    toServer(raw);
    if (tracksIdle) {
      if (message !== undefined) {
        recordSession(raw, message);
      }
      restartIdleClock();
    }
    if (message === undefined) {
      return;
    }
    table.apply(message);
    const edited = editedUri(message);
    if (edited !== undefined) {
      gate.touch(edited);
    }
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
  const relayClient = (event, message) => {
    if (event.kind === "raw") {
      log("framing", `framing abandoned, passing client bytes through raw: ${parser.failure}`);
      stopWatching();
      toServer(event.raw);
      return;
    }
    handleMessage(event.raw, message);
  };
  const acceptClient = (event, message) => {
    if (state === "running") {
      relayClient(event, message);
      return;
    }
    if (state === "starting" && message?.method === undefined && serverRequests.has(message?.id)) {
      relayClient(event, message);
      return;
    }
    if (state !== "stopped") {
      queued.push({
        event,
        message
      });
      return;
    }
    if (message?.method === "shutdown" && message.id !== undefined) {
      toClient(frameMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: null
      })));
      return;
    }
    if (message?.method === "exit") {
      finish(0);
      return;
    }
    if (message?.method === "$/cancelRequest" || message?.id !== undefined && message.method === undefined) {
      return;
    }
    queued.push({
      event,
      message
    });
    restartServer();
  };
  process.stdin.on("data", (chunk) => {
    for (const event of parser.push(chunk)) {
      acceptClient(event, event.kind === "message" ? parseClientBody(event.body) : undefined);
    }
  });
  process.stdin.on("end", () => {
    const rest = parser.drain();
    if (state === "stopped") {
      finish(0);
      return;
    }
    if (state !== "running") {
      clientEnded = true;
      return;
    }
    if (rest.length > 0) {
      toServer(rest);
    }
    server.stdin.end();
  });
  const toClient = (bytes) => {
    if (!process.stdout.write(bytes)) {
      server.stdout.pause();
    }
  };
  process.stdout.on("drain", () => server.stdout.resume());
  const closeGate = () => {
    gateClosed = true;
    clearTimeout(gateTimer);
    gateTimer = undefined;
    for (const frame of gate.flush()) {
      toClient(frame);
    }
  };
  const armGate = () => {
    clearTimeout(gateTimer);
    gateTimer = undefined;
    const wait = gate.nextWake();
    if (wait === undefined || gateClosed) {
      return;
    }
    gateTimer = setTimeout(() => {
      gateTimer = undefined;
      for (const frame of gate.release()) {
        toClient(frame);
      }
      armGate();
    }, wait);
  };
  const consumeServerMessage = (body) => {
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return false;
    }
    const id = message?.id;
    if (id === undefined) {
      return false;
    }
    if (message?.method !== undefined) {
      serverRequests.add(id);
      return false;
    }
    if (id === initializeId) {
      initializeId = undefined;
      replaySession();
      return true;
    }
    if (id === shutdownId) {
      shutdownId = undefined;
      toServer(frameMessage(JSON.stringify({
        jsonrpc: "2.0",
        method: "exit"
      })));
      server.stdin.end();
      return true;
    }
    clientRequests.delete(id);
    return false;
  };
  const readServer = (chunk) => {
    for (const event of serverParser.push(chunk)) {
      if (event.kind === "raw") {
        log("server-framing", `framing abandoned on server output, passing it through raw: ${serverParser.failure}`);
        closeGate();
        toClient(event.raw);
        continue;
      }
      if (tracksIdle && consumeServerMessage(event.body)) {
        continue;
      }
      const published = publishMessage(event.body);
      if (published === undefined) {
        const edge = busyEdge?.(event.body);
        if (edge !== undefined) {
          gate.setBusy(edge === "start");
          serverBusy = edge === "start";
        }
        toClient(event.raw);
        continue;
      }
      const kept = filterDiagnostics(published.params, filterOptions);
      const frame = kept === undefined ? event.raw : frameMessage(JSON.stringify({ ...published, params: kept }));
      for (const out of gate.offer(frame, kept ?? published.params)) {
        toClient(out);
      }
    }
    armGate();
  };
  const endServerOutput = () => {
    if (state === "stopping") {
      return;
    }
    closeGate();
    const rest = serverParser.drain();
    if (rest.length > 0) {
      toClient(rest);
    }
  };
  const serverClosed = (code) => {
    if (state === "stopping") {
      serverStopped();
      return;
    }
    if (state === "starting") {
      log("restart-failed", "the restarted language server exited before answering initialize");
      finish(1);
      return;
    }
    finish(code ?? 1);
  };
  const startServer = () => {
    server = spawn(options.command, options.args, {
      stdio: [
        "pipe",
        "pipe",
        "inherit"
      ]
    });
    serverParser = new FrameParser;
    server.stdin.on("drain", () => process.stdin.resume());
    server.stdin.on("error", (error) => {
      log("server-stdin", `writing to the server failed: ${errorMessage(error)}`);
    });
    server.stdout.on("data", readServer);
    server.stdout.on("end", endServerOutput);
    server.on("error", (error) => {
      log("spawn", `server process failed: ${errorMessage(error)}`);
      finish(1);
    });
    server.on("close", serverClosed);
  };
  const terminate = (signal) => {
    if (state === "stopped") {
      finish(0);
      return;
    }
    server.kill(signal);
    if (state === "stopping") {
      finish(0);
    }
  };
  process.stdout.on("error", (error) => {
    log("stdout", `writing to the client failed, stopping the server: ${errorMessage(error)}`);
    terminate("SIGTERM");
  });
  const finish = (code) => {
    if (finished) {
      return;
    }
    finished = true;
    stopWatching();
    clearTimeout(gateTimer);
    gateTimer = undefined;
    if (process.stdout.destroyed) {
      process.exit(code);
    }
    process.stdout.write("", () => process.exit(code));
  };
  startServer();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      terminate(signal);
    });
  }
}

// src/lsp-proxy-main.ts
runLspProxy(process.argv.slice(2));
