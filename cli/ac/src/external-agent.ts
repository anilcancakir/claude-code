import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ExternalCli = "codex" | "gemini" | "opencode";

export const LOCAL_TOOL_NAME = "call-external-agent" as const;

export const EXTERNAL_AGENT_TOOL_DEFINITION: Tool = {
    name: LOCAL_TOOL_NAME,
    description: "Dispatch a prompt to a local AI coding CLI (codex, gemini, opencode) running in a chosen directory. Returns the CLI's completion text.",
    inputSchema: {
        type: "object",
        properties: {
            cli: {
                type: "string",
                enum: ["codex", "gemini", "opencode"],
                description: "Which local CLI to invoke.",
            },
            prompt: {
                type: "string",
                description: "Prompt to send to the CLI (non-empty).",
            },
            directory: {
                type: "string",
                description: "Absolute path to the working directory for the CLI.",
            },
            model: {
                type: "string",
                description: "Optional model identifier passed to the CLI (e.g. gpt-5.5, gemini-2.5-flash, anthropic/claude-sonnet-4-6).",
            },
            timeout_seconds: {
                type: "number",
                minimum: 10,
                maximum: 3600,
                description: "Optional hard timeout in seconds (default 600).",
            },
        },
        required: ["cli", "prompt", "directory"],
    },
};

export interface ValidatedInputs {
    cli: ExternalCli;
    prompt: string;
    directory: string;
    model: string | undefined;
    timeoutSeconds: number;
}

export function validateInputs(args: unknown): ValidatedInputs {
    const a = args as Record<string, unknown>;

    const cli = a["cli"];
    if (cli !== "codex" && cli !== "gemini" && cli !== "opencode") {
        throw new McpError(ErrorCode.InvalidParams, "cli must be one of codex|gemini|opencode");
    }

    const prompt = a["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "prompt must be a non-empty string");
    }

    const directory = a["directory"];
    if (typeof directory !== "string" || !isAbsolute(directory)) {
        throw new McpError(ErrorCode.InvalidParams, "directory must be an absolute path");
    }

    let stat;
    try {
        stat = statSync(directory);
    } catch {
        throw new McpError(ErrorCode.InvalidParams, "directory does not exist");
    }
    if (!stat.isDirectory()) {
        throw new McpError(ErrorCode.InvalidParams, "directory is not a directory");
    }

    const model = typeof a["model"] === "string" && a["model"].length > 0 ? a["model"] : undefined;

    const rawTimeout = a["timeout_seconds"];
    const parsed = typeof rawTimeout === "number" ? rawTimeout : 600;
    const timeoutSeconds = Math.min(Math.max(parsed, 10), 3600);

    return { cli, prompt, directory, model, timeoutSeconds };
}

const modelSlot = (flag: string, m: string | undefined): string[] =>
    m && m.length > 0 ? [flag, m] : [];

export function buildArgv(
    cli: ExternalCli,
    prompt: string,
    directory: string,
    model: string | undefined,
): string[] {
    switch (cli) {
        case "codex": {
            const bin = process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] ?? "codex";
            return [bin, "--cd", directory, "exec", ...modelSlot("--model", model), "--skip-git-repo-check", "-"];
        }
        case "gemini": {
            const bin = process.env["AC_EXTERNAL_AGENT_GEMINI_BIN"] ?? "gemini";
            return [bin, "-p", prompt, ...modelSlot("--model", model)];
        }
        case "opencode": {
            const bin = process.env["AC_EXTERNAL_AGENT_OPENCODE_BIN"] ?? "opencode";
            return [bin, "run", "--dir", directory, ...modelSlot("--model", model)];
        }
    }
}

const STREAM_BUFFER_CAP = 8 * 1024 * 1024;
const TAIL_BYTES = 65536;

const activeChildren = new Set<ChildProcess>();

export function getActiveChildren(): Set<ChildProcess> {
    return activeChildren;
}

export function truncateTail(buf: Buffer): string {
    if (buf.length <= TAIL_BYTES) return buf.toString("utf8");

    const droppedBytes = buf.length - TAIL_BYTES;
    const start = buf.length - TAIL_BYTES;
    let offset = start;
    // Walk past at most 3 UTF-8 continuation bytes so the tail decodes without leading U+FFFD.
    while (offset < buf.length - 1 && (buf[offset]! & 0xC0) === 0x80) {
        offset++;
        if (offset - start > 3) break;
    }
    return `[truncated ${droppedBytes} bytes from head]\n${buf.subarray(offset).toString("utf8")}`;
}

// POSIX: signal the whole process group via negative PID. Windows SIGKILL: taskkill /T /F.
// `child.pid` may be undefined when spawn never produced a pid (e.g. ENOENT) — no-op then.
function killGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
        if (signal === "SIGKILL") {
            try {
                spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
            } catch {
                child.kill("SIGKILL");
            }
        } else {
            child.kill();
        }
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        // Group may have already exited; fall back to direct kill best-effort.
        try { child.kill(signal); } catch { /* exited */ }
    }
}

// Waits for a child to exit, resolving immediately if it has already exited.
function exitPromise(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once("exit", () => resolve());
    });
}

// Sends SIGTERM to every active child's process group, waits up to graceMs for them to exit,
// then SIGKILL-escalates survivors. Races the whole sequence against the graceMs ceiling.
export async function killAllActiveChildren(graceMs: number): Promise<void> {
    // 1. Snapshot active children before any signals race ahead.
    const children = Array.from(activeChildren);
    if (children.length === 0) return;

    // 2. Send SIGTERM to every group.
    for (const child of children) {
        killGroup(child, "SIGTERM");
    }

    // 3. After 2s, escalate to SIGKILL for any survivors still in the set.
    const sigkillTimer = setTimeout(() => {
        for (const child of children) {
            if (activeChildren.has(child)) {
                killGroup(child, "SIGKILL");
            }
        }
    }, 2000);

    // 4. Race: wait for all children to exit OR the hard ceiling, whichever comes first.
    await Promise.race([
        Promise.all(children.map((c) => exitPromise(c))),
        new Promise<void>((r) => setTimeout(r, graceMs)),
    ]);

    clearTimeout(sigkillTimer);
}

export async function runExternalAgent(
    args: unknown,
    options?: { spawnImpl?: typeof spawn; timeoutMsOverride?: number },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { cli, prompt, directory, model, timeoutSeconds } = validateInputs(args);
    const argv = buildArgv(cli, prompt, directory, model);
    const bin = argv[0]!;
    const rest = argv.slice(1);

    const env = { ...process.env };
    delete env.KODIZM_MCP_TOKEN;
    delete env.KODIZM_MCP_URL;
    delete env.AC_EXTERNAL_AGENT_CODEX_BIN;
    delete env.AC_EXTERNAL_AGENT_GEMINI_BIN;
    delete env.AC_EXTERNAL_AGENT_OPENCODE_BIN;

    const spawnFn = options?.spawnImpl ?? spawn;
    const child = spawnFn(bin, rest, {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
    });

    activeChildren.add(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutCapped = false;
    let stderrCapped = false;

    if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
            if (stdoutCapped) return;
            if (stdoutLen + chunk.length > STREAM_BUFFER_CAP) {
                stdoutCapped = true;
                return;
            }
            stdoutChunks.push(chunk);
            stdoutLen += chunk.length;
        });
    }
    if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
            if (stderrCapped) return;
            if (stderrLen + chunk.length > STREAM_BUFFER_CAP) {
                stderrCapped = true;
                return;
            }
            stderrChunks.push(chunk);
            stderrLen += chunk.length;
        });
    }

    if (cli !== "gemini" && child.stdin) {
        child.stdin.write(prompt + "\n");
        child.stdin.end();
    } else if (child.stdin) {
        child.stdin.end();
    }

    const timeoutMs = options?.timeoutMsOverride ?? timeoutSeconds * 1000;

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // Clears both timers so a SIGKILL never fires against a recycled PID after exit.
    const done = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
    };

    type ExitResult = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
        | { kind: "error"; error: Error };

    const outcome = await new Promise<ExitResult>((resolve) => {
        child.once("exit", (code, signal) => {
            done();
            activeChildren.delete(child);
            resolve({ kind: "exit", code, signal });
        });
        child.once("error", (error) => {
            done();
            activeChildren.delete(child);
            resolve({ kind: "error", error });
        });
        timeoutTimer = setTimeout(() => {
            timedOut = true;
            killGroup(child, "SIGTERM");
            killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
        }, timeoutMs);
    });

    // Drain remaining buffered data from the streams (data events may fire after exit).
    // Skip on error path: streams may be destroyed without ever emitting end/close.
    if (outcome.kind === "exit") {
        await Promise.all([
            new Promise<void>((r) => {
                if (!child.stdout || child.stdout.readableEnded || child.stdout.destroyed) { r(); return; }
                child.stdout.once("end", () => r());
                child.stdout.once("close", () => r());
            }),
            new Promise<void>((r) => {
                if (!child.stderr || child.stderr.readableEnded || child.stderr.destroyed) { r(); return; }
                child.stderr.once("end", () => r());
                child.stderr.once("close", () => r());
            }),
        ]);
    }

    const stdoutBuffer = Buffer.concat(stdoutChunks, stdoutLen);
    const stderrBuffer = Buffer.concat(stderrChunks, stderrLen);

    if (outcome.kind === "error") {
        const err = outcome.error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
            throw new McpError(
                ErrorCode.InternalError,
                `${cli} binary not found (set AC_EXTERNAL_AGENT_${cli.toUpperCase()}_BIN or install ${cli})`,
            );
        }
        throw new McpError(ErrorCode.InternalError, `${cli} spawn failed: ${err.message}`);
    }

    if (timedOut) {
        throw new McpError(ErrorCode.InternalError, `${cli} timed out after ${timeoutSeconds}s`);
    }

    const code = outcome.code;
    if (code === 0) {
        const text = (stdoutCapped ? "[stdout buffer cap reached]\n" : "") + truncateTail(stdoutBuffer);
        return { content: [{ type: "text", text }] };
    }

    const tail = (stderrCapped ? "[stderr buffer cap reached]\n" : "") + truncateTail(stderrBuffer);
    throw new McpError(ErrorCode.InternalError, `${cli} exited ${code}: ${tail}`);
}
