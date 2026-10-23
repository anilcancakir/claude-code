import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { inspect } from "node:util"

/**
 * The plugin's own log file. The background service sends stdout to /dev/null and gives plugins no logger, so a
 * plugin's console output is lost there; fallback switches and guard failures are appended here as well.
 * `AC_OPENCODE_LOG` names another file, and an empty value turns the file off (the tests run that way).
 */
function logPath(): string | undefined {
    const configured = process.env.AC_OPENCODE_LOG
    if (configured === "") return undefined
    return configured ?? join(homedir(), ".local/share/ac-opencode/ac.log")
}

/** `inspect` never throws on a cycle or a BigInt, where JSON.stringify would, inside a caller's catch block. */
function render(detail: unknown): string {
    if (detail instanceof Error) return detail.stack ?? detail.message
    return typeof detail === "string" ? detail : inspect(detail, { depth: 4, breakLength: Infinity })
}

/** One line to the console and to the log file; a file that cannot be written is reported on the console. */
export function log(level: "info" | "error", message: string, ...details: unknown[]): void {
    const text = [message, ...details.map(render)].join(" ")
    console[level](message, ...details)

    const path = logPath()
    if (path === undefined) return
    try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch (error) {
        console.error("ac log: could not write", path, error)
    }
}
