import type { Plugin } from "@opencode/plugin"

/**
 * Background shells that will wake a session, for the stop guards. A background `shell` call returns at once with
 * `metadata.status: "running"` and a `shellID` (core/src/tool/plugin/shell.ts:84-93); its completion arrives as a
 * synthetic message with `metadata.source: "shell"` and the same `shellID` (core/src/shell/result.ts:46-61), which
 * starts the session's next turn. Ending a turn while one runs is how a session waits for it.
 *
 * Only a shell the strict rules of plugins/ac/hooks/lib/wake-count.jq call finite counts: a test, build, lint or
 * install run, or a command bounded by `timeout N`. A dev server or a log follow never ends, and counting one would
 * switch the guard off for the rest of the run, so a wrong allow costs the run where a wrong block costs one turn.
 */

const FINITE = new RegExp(
    "\\b(test|tests|spec|build|analyze|analyse|lint|check|typecheck|tsc|compile|install|audit|format)\\b" +
        "|\\b(pytest|phpunit|pest|jest|vitest|rspec|pint|phpstan|larastan|eslint|ruff|mypy)\\b" +
        "|\\bgh +run +watch\\b|\\bgh +pr +checks\\b",
)

const LOOPS = /\b(until|while)\b|\bsleep +infinity\b/

const FOLLOWS = new RegExp(
    "\\btail\\b[^|;&\\n]*\\s-[a-zA-Z0-9]*[fF]\\b|--follow\\b|\\blogcat\\b|--console\\b" +
        "|\\b(journalctl|logs)\\b[^|;&\\n]*\\s-f\\b|\\bidevicesyslog\\b" +
        "|(^|[|;&({!\\n'\"`])[ \\t]*((sudo|nohup|exec|time|nice|env|command|stdbuf|do|then|else|elif|if" +
        "|[A-Za-z_][A-Za-z0-9_]*=[^ ]*)( +-[^ ]+( +[0-9]+)?)* +)*([^ \\t]*/)?watch +-" +
        "|\\b(flutter|adb) +logs?\\b|\\b(inotifywait|fswatch|watchexec)\\b|\\b(build_runner|cargo) +watch\\b" +
        "|\\bkubectl\\b[^|;&\\n]*\\s-w\\b|\\bstripe +listen\\b|\\bssh\\b[^|;&\\n]*\\s-[a-zA-Z]*N" +
        "|\\b(tsc|vitest|jest|bun)\\b[^|;&\\n]*\\s--watch\\b|\\b(npm|pnpm|yarn|bun)( +run)? +watch\\b",
)

const LONG_LIVED = new RegExp(
    "\\b(npm|bun|pnpm|yarn|composer)( +run)? +(dev|start|serve|preview)\\b" +
        "|\\b(next|nuxt|astro|remix|expo|wrangler) +(dev|start)\\b" +
        "|\\bvite(?= *($|[;&|]| +(dev|serve|preview|--)))" +
        "|\\bartisan +(serve|queue:work|queue:listen|horizon|reverb:start|pail|schedule:work)\\b" +
        "|\\b(caddy +run|emulator +-avd|octane:start|sail +up|phx\\.server|hugo +server)\\b" +
        "|\\b(uvicorn|gunicorn|hypercorn|nodemon|ngrok|redis-server)\\b|\\brails +(s|server)\\b" +
        "|\\brunserver\\b|http\\.server|\\bphp\\b[^|;&\\n]*\\s-S\\b|\\bnpx +serve\\b|flutter +run\\b" +
        "|\\bdocker( +compose)?\\b[^|;&\\n]* up\\b(?![^|;&\\n]*( -d\\b|--detach))" +
        "|\\b(node|bun|deno|tsx|python3?|php) +\\S*server\\S*\\.(c?m?[jt]s|py|php)\\b",
)

const WORD = "[^\\s;&|`()]+"
const LEADING_SETUP = new RegExp(
    "^[ \\t]*((cd[ \\t]+" + WORD + "|[A-Za-z_][A-Za-z0-9_]*=(" + WORD + ")?" +
        "|export([ \\t]+[A-Za-z_][A-Za-z0-9_]*(=" + WORD + ")?)+)[ \\t]*&&[ \\t]*)*",
)
const TIMEOUT_HEAD = /^(?<pre>[^\n]*?)\bg?timeout\b/
const TIMEOUT = new RegExp(
    "^\\s*([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*g?timeout" +
        "(\\s+(-k\\s*\\S+|--kill-after=\\S+|-s\\s*\\S+|--signal=\\S+|--foreground|--preserve-status|-v|--verbose))*" +
        "\\s+(?<n>[0-9]+(\\.[0-9]+)?)(?<u>[smhd]?)\\s",
)
const UNIT_SECONDS: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }

/** One simple command under `timeout N` with 0 < N <= 1 h ends by construction, whatever it wraps (wake-count.jq). */
function bounded(command: string): boolean {
    const singleQuoted = command.replace(/'[^']*'/g, "''")
    const bare = singleQuoted
        .replace(/"(\\.|[^"\\])*"/g, '""')
        .replace(/[0-9]*>&[0-9-]+/g, "")
        .replace(/&>>?|>&/g, ">")
    const rest = bare.replace(LEADING_SETUP, "")
    const head = TIMEOUT_HEAD.exec(singleQuoted)
    const limit = TIMEOUT.exec(rest)
    if (!head || !limit?.groups) return false
    if (/\$\(|`|[<>]\(/.test(head.groups?.pre ?? "")) return false
    const seconds = Number(limit.groups.n) * (UNIT_SECONDS[limit.groups.u ?? ""] ?? 0)
    if (!(seconds > 0 && seconds <= 3600)) return false
    if (/[;&|\n]/.test(rest)) return false
    return !/\[\+[0-9]+ chars\]$/.test(command)
}

/** Whether a background shell running `command` will end and wake its session (the strict mode of wake-count.jq). */
export function wakes(command: string): boolean {
    if (bounded(command)) return true
    return FINITE.test(command) && !LOOPS.test(command) && !FOLLOWS.test(command) && !LONG_LIVED.test(command)
}

/** A missed completion must not keep a guard disarmed for good, so an entry ages out after this. */
const PENDING_TTL_MS = 2 * 3_600_000

interface Pending {
    readonly sessionID: string
    readonly startedAt: number
}

export interface BackgroundShells {
    /** Background shells of `sessionID` that will wake it and have not reported back. */
    pending(sessionID: string): number
}

/** Tracks every session's waking background shells from the shell tool's results and completion messages. */
export async function registerBackgroundShells(ctx: Plugin.Context): Promise<BackgroundShells & { stop(): void }> {
    const shells = new Map<string, Pending>()

    await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== "shell" || event.status !== "completed") return
        const metadata = (event.result as { metadata?: { status?: unknown; shellID?: unknown } }).metadata
        if (metadata?.status !== "running" || typeof metadata.shellID !== "string") return
        const command = (event.input as { command?: unknown } | undefined)?.command
        if (typeof command !== "string" || !wakes(command)) return
        shells.set(metadata.shellID, { sessionID: event.sessionID, startedAt: Date.now() })
    })

    const controller = new AbortController()
    const follow = async (): Promise<void> => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type !== "session.synthetic") continue
            const metadata = event.data.metadata as { source?: unknown; shellID?: unknown } | undefined
            if (metadata?.source === "shell" && typeof metadata.shellID === "string") shells.delete(metadata.shellID)
        }
    }
    follow().catch((error: unknown) => console.error("ac background shells: event stream ended", error))

    return {
        pending: (sessionID) => {
            const now = Date.now()
            let count = 0
            for (const [id, shell] of shells) {
                if (now - shell.startedAt > PENDING_TTL_MS) shells.delete(id)
                else if (shell.sessionID === sessionID) count++
            }
            return count
        },
        stop: () => controller.abort(),
    }
}
