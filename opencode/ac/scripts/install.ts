import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface InstallOptions {
    /** Checkout that holds plugins/ac and opencode/ac; replaces `<repo>` in the templates. */
    repoRoot: string
    /** Directory whose `.config/opencode` receives the install; tests pass a temp dir, never the real home. */
    home: string
    dryRun: boolean
    now: Date
}

const PROVENANCE_LINE = /^<!-- ported-from:[^\n]*-->\n/
const LEADING_COMMENT = /^<!--[\s\S]*?-->\n\n?/

const pad = (value: number): string => String(value).padStart(2, "0")

function timestamp(now: Date): string {
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** The template's provenance line and maintainer notes are for this repo; placeholders stay for the operator step. */
export function renderAgentsMd(template: string): string {
    return template.replace(PROVENANCE_LINE, "").replace(LEADING_COMMENT, "")
}

/** Returns one line per action; with `dryRun` the lines describe what would happen and nothing is written. */
export function install({ repoRoot, home, dryRun, now }: InstallOptions): string[] {
    const configDir = join(home, ".config", "opencode")
    const backupDir = join(home, ".config", `opencode.bak-v1-${timestamp(now)}`)
    const templates = join(repoRoot, "opencode/ac/templates")
    const verb = dryRun ? "would" : "did"
    const lines: string[] = []

    // 1. Back up, never delete: a v1 config can hold keys and history the operator may still want.
    if (existsSync(configDir)) {
        if (!dryRun) renameSync(configDir, backupDir)
        lines.push(`${verb} move ${configDir} -> ${backupDir}`)
    }

    // 2. The two config files, with the checkout path resolved.
    if (!dryRun) mkdirSync(configDir, { recursive: true })
    const opencodeJsonc = readFileSync(join(templates, "opencode.jsonc"), "utf8").replaceAll("<repo>", repoRoot)
    if (!dryRun) writeFileSync(join(configDir, "opencode.jsonc"), opencodeJsonc)
    lines.push(`${verb} write ${join(configDir, "opencode.jsonc")}`)

    if (!dryRun) copyFileSync(join(templates, "cli.json"), join(configDir, "cli.json"))
    lines.push(`${verb} write ${join(configDir, "cli.json")}`)

    // 3. Global instructions; the operator step fills the remaining placeholders.
    if (!dryRun) {
        writeFileSync(join(configDir, "AGENTS.md"), renderAgentsMd(readFileSync(join(templates, "AGENTS.md"), "utf8")))
    }
    lines.push(`${verb} write ${join(configDir, "AGENTS.md")} (placeholders left to fill)`)

    // 4. Agents ship as files, not plugin registrations: global permissions are appended after plugin agents' rules.
    const link = join(configDir, "agents", "ac")
    if (!dryRun) {
        mkdirSync(join(configDir, "agents"), { recursive: true })
        symlinkSync(join(repoRoot, "opencode/ac/agents"), link)
    }
    lines.push(`${verb} link ${link} -> ${join(repoRoot, "opencode/ac/agents")}`)

    return lines
}

/** Returns undefined for an argument list the installer does not accept. */
function parseArgs(argv: string[]): { dryRun: boolean; home: string } | undefined {
    let dryRun = false
    let home = homedir()
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--dry-run") dryRun = true
        else if (arg === "--home" && argv[i + 1]) home = resolve(argv[++i] as string)
        else return undefined
    }
    return { dryRun, home }
}

if (import.meta.main) {
    const args = parseArgs(process.argv.slice(2))
    if (!args) {
        console.error("usage: bun scripts/install.ts [--dry-run] [--home <dir>]")
        process.exit(2)
    }
    const repoRoot = resolve(import.meta.dir, "../../..")
    for (const line of install({ repoRoot, home: args.home, dryRun: args.dryRun, now: new Date() })) console.log(line)
}
