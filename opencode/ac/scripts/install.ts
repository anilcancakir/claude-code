import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
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

/** The agents/ac symlink only this installer creates; its presence marks the tree as an ac v2 install. */
function isSymlink(path: string): boolean {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}

/**
 * Returns one line per action; with `dryRun` the lines describe what would happen and nothing is written.
 * A v1 tree is moved aside whole. A re-run on an ac v2 install rewrites only the files this repo owns
 * (opencode.jsonc, cli.json, the agents link) and leaves the operator's AGENTS.md, service.json and the rest.
 */
export function install({ repoRoot, home, dryRun, now }: InstallOptions): string[] {
    const configDir = join(home, ".config", "opencode")
    const backupDir = join(home, ".config", `opencode.bak-v1-${timestamp(now)}`)
    const templates = join(repoRoot, "opencode/ac/templates")
    const link = join(configDir, "agents", "ac")
    const verb = dryRun ? "would" : "did"
    const lines: string[] = []
    const rerun = isSymlink(link)

    // 1. Back up, never delete: a v1 config can hold keys and history the operator may still want.
    if (!rerun && existsSync(configDir)) {
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

    // 3. Global instructions, first install only: the operator fills the placeholders and owns the file after.
    if (!rerun) {
        if (!dryRun) {
            const agentsMd = renderAgentsMd(readFileSync(join(templates, "AGENTS.md"), "utf8"))
            writeFileSync(join(configDir, "AGENTS.md"), agentsMd)
        }
        lines.push(`${verb} write ${join(configDir, "AGENTS.md")} (placeholders left to fill)`)
    }

    // 4. Agents ship as files, not plugin registrations, so opencode loads them from the repo working tree.
    //    Their markdown rules sit after the global ones, which is why each agent carries its own protections.
    if (!dryRun) {
        mkdirSync(join(configDir, "agents"), { recursive: true })
        if (rerun) rmSync(link)
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
