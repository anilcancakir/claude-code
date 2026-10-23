import type { Plugin } from "@opencode/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import { existsSync, realpathSync } from "node:fs"
import { basename, extname, isAbsolute, relative, resolve } from "node:path"

/** A checker runs as `<bin> <...args> <absolute file>` with no shell; `bin` with a slash is project-relative. */
export interface Checker {
    bin: string
    args: readonly string[]
}

export interface DiagnosticsOptions {
    /** Root every checked file must live under. Defaults to the plugin location's directory. */
    directory?: string
    /** Extension (with dot) to checkers. An entry replaces the default for that extension; `[]` disables it. */
    checkers?: Readonly<Record<string, readonly Checker[]>>
    timeoutMs?: number
}

const WATCHED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch"])
const MAX_BLOCK_CHARS = 4000
const MIN_BLOCK_CHARS = 200
const DEFAULT_TIMEOUT_MS = 20_000
const TRUNCATED = "\n...[truncated]"

/** Typecheck for ts/tsx/js stays in the execute wave verification: per-edit it would cost a whole project run. */
const DEFAULT_CHECKERS: Readonly<Record<string, readonly Checker[]>> = {
    ".php": [
        { bin: "php", args: ["-l"] },
        { bin: "vendor/bin/pint", args: ["--test"] },
    ],
    ".dart": [{ bin: "dart", args: ["analyze"] }],
}

export async function registerDiagnostics(ctx: Plugin.Context, options: DiagnosticsOptions = {}) {
    const root = realpathSync(options.directory ?? ctx.location.directory)
    const checkers = { ...DEFAULT_CHECKERS, ...options.checkers }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || !WATCHED_TOOLS.has(event.tool)) return

        const block = await diagnose(touchedPaths(event.tool, event.input), root, checkers, timeoutMs)
        if (block === undefined) return

        // Reassigned rather than mutated: content may still be unset here and opencode truncates after this hook.
        event.result = withBlock(event.result, block)
    })
}

function touchedPaths(tool: string, input: unknown): string[] {
    if (typeof input !== "object" || input === null) return []
    const fields = input as Record<string, unknown>

    if (tool !== "patch") return typeof fields.path === "string" ? [fields.path] : []
    if (typeof fields.patchText !== "string") return []

    // Update and Move headers are both taken: whichever side no longer exists is skipped by the existence check.
    const paths = new Set<string>()
    for (const line of fields.patchText.split("\n")) {
        const header = /^\*\*\* (?:Add File|Update File|Move to):\s*(.+?)\s*$/.exec(line)
        if (header?.[1] !== undefined) paths.add(header[1])
    }
    return [...paths]
}

async function diagnose(
    paths: readonly string[],
    root: string,
    checkers: Readonly<Record<string, readonly Checker[]>>,
    timeoutMs: number,
): Promise<string | undefined> {
    const blocks: string[] = []
    let remaining = MAX_BLOCK_CHARS

    for (const path of paths) {
        if (remaining < MIN_BLOCK_CHARS) break

        const file = locate(path, root)
        if (file === undefined) continue

        const failures: string[] = []
        for (const checker of checkers[extname(file.real).toLowerCase()] ?? []) {
            const bin = resolveBin(checker.bin, root)
            if (bin === undefined) continue

            const failure = await run(bin, checker, file.real, timeoutMs)
            if (failure !== undefined) failures.push(failure.replaceAll(file.real, file.relative))
        }
        if (failures.length === 0) continue

        const block = renderBlock(file.relative, failures.join("\n"), remaining)
        blocks.push(block)
        remaining -= block.length + 1
    }

    return blocks.length === 0 ? undefined : blocks.join("\n")
}

/** Resolves symlinks on both sides so a link inside the project cannot lead a checker outside it. */
function locate(path: string, root: string): { real: string; relative: string } | undefined {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) return undefined

    const real = realpathSync(absolute)
    const inside = relative(root, real)
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined

    return { real, relative: inside.split("\\").join("/") }
}

function resolveBin(bin: string, root: string): string | undefined {
    // Bun.which also answers for absolute paths, and only for executable ones.
    return Bun.which(bin.includes("/") ? resolve(root, bin) : bin) ?? undefined
}

/** Resolves to the failure text, or undefined when the checker exited 0: clean runs print noise the model does not need. */
async function run(bin: string, checker: Checker, file: string, timeoutMs: number): Promise<string | undefined> {
    const label = `${basename(checker.bin)} ${checker.args.join(" ")}`.trim()
    const proc = Bun.spawn([bin, ...checker.args, file], { stdout: "pipe", stderr: "pipe" })

    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        proc.kill("SIGKILL")
    }, timeoutMs)

    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        if (timedOut) return `[${label}] timed out after ${Math.round(timeoutMs / 1000)}s`
        if (code === 0) return undefined

        // php -l prints the same error on both streams; stdout carries it for the others.
        const output = (stdout.trim() === "" ? stderr : stdout).trim()
        return `[${label}] ${output === "" ? `exited with code ${code}` : output}`
    } finally {
        clearTimeout(timer)
    }
}

function renderBlock(file: string, body: string, budget: number): string {
    const open = `<diagnostics file="${file.replaceAll('"', "&quot;")}">\n`
    const close = "\n</diagnostics>"
    const room = budget - open.length - close.length
    const text = body.length <= room ? body : `${body.slice(0, Math.max(0, room - TRUNCATED.length))}${TRUNCATED}`

    return `${open}${text}${close}`
}

function withBlock(result: Result, block: string): Result {
    const parts =
        typeof result.content === "string"
            ? result.content === ""
                ? []
                : [{ type: "text" as const, text: result.content }]
            : [...(result.content ?? [])]

    // Setting content stops opencode falling back to the stringified output, so carry that text over.
    if (parts.length === 0 && result.output !== undefined) {
        parts.push({ type: "text", text: stringify(result.output) })
    }

    return { ...result, content: [...parts, { type: "text", text: block }] }
}

function stringify(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
}
