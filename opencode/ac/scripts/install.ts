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
import { parseJsonc } from "../src/config.ts"

export interface InstallOptions {
    /** Checkout that holds plugins/ac and opencode/ac; replaces `<repo>` in the templates. */
    repoRoot: string
    /** Directory whose `.config/opencode` receives the install; tests pass a temp dir, never the real home. */
    home: string
    dryRun: boolean
    now: Date
}

/** The slice of the opencode.jsonc template the install lines name. */
interface OpencodeConfig {
    agents: Record<string, { model?: string }>
}

interface RenderedConfig {
    text: string
    /** Agent id and the model the rendered config gives it, in the order the install lines name them. */
    models: [string, string][]
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

/** The template verbatim with the checkout path resolved, so its comments reach the operator's file. */
export function renderOpencodeJsonc(template: string, repoRoot: string): RenderedConfig {
    const text = template.replaceAll("<repo>", repoRoot)
    const config = parseJsonc(text, "templates/opencode.jsonc") as OpencodeConfig
    return {
        text,
        models: [
            ["build", config.agents.build?.model as string],
            ["title", config.agents.title?.model as string],
        ],
    }
}

/** The agents/ac symlink only this installer creates; its presence marks the tree as an ac v2 install. */
function isSymlink(path: string): boolean {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}

/**
 * Returns one line per action; with `dryRun` the lines describe what would happen and nothing is written.
 * A v1 tree is moved aside whole. A re-run on an ac v2 install rewrites only the files this repo owns
 * (opencode.jsonc, cli.json, the agents link), copying the first two to `<name>.bak-<stamp>` beforehand, and
 * leaves the operator's AGENTS.md, service.json and the rest.
 */
export function install({ repoRoot, home, dryRun, now }: InstallOptions): string[] {
    const configDir = join(home, ".config", "opencode")
    const backupDir = join(home, ".config", `opencode.bak-v1-${timestamp(now)}`)
    const templates = join(repoRoot, "opencode/ac/templates")
    const link = join(configDir, "agents", "ac")
    const verb = dryRun ? "would" : "did"
    const lines: string[] = []
    const rerun = isSymlink(link)
    const rendered = renderOpencodeJsonc(readFileSync(join(templates, "opencode.jsonc"), "utf8"), repoRoot)

    // 1. Back up, never delete: a v1 config can hold keys and history the operator may still want.
    if (!rerun && existsSync(configDir)) {
        if (!dryRun) renameSync(configDir, backupDir)
        lines.push(`${verb} move ${configDir} -> ${backupDir}`)
    }

    // 2. The two config files, with the checkout path resolved. A file this run replaces is copied aside first, since
    //    the operator may have edited it by hand; cli.json is copied only when the template would change it.
    if (!dryRun) mkdirSync(configDir, { recursive: true })
    const cliJson = readFileSync(join(templates, "cli.json"), "utf8")
    const suffix = `.bak-${timestamp(now)}`

    const target = join(configDir, "opencode.jsonc")
    // An unchanged file needs no copy, so re-running the install leaves no new backup behind.
    if (existsSync(target) && readFileSync(target, "utf8") !== rendered.text) {
        if (!dryRun) copyFileSync(target, `${target}${suffix}`)
        lines.push(`${verb} copy ${target} -> ${target}${suffix}`)
    }
    if (!dryRun) writeFileSync(target, rendered.text)
    lines.push(`${verb} write ${target}`)
    for (const [agent, model] of rendered.models) lines.push(`${verb} set model ${agent} -> ${model}`)

    const cliTarget = join(configDir, "cli.json")
    if (existsSync(cliTarget) && readFileSync(cliTarget, "utf8") !== cliJson) {
        if (!dryRun) copyFileSync(cliTarget, `${cliTarget}${suffix}`)
        lines.push(`${verb} copy ${cliTarget} -> ${cliTarget}${suffix}`)
    }
    if (!dryRun) writeFileSync(cliTarget, cliJson)
    lines.push(`${verb} write ${cliTarget}`)

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
        const value = argv[i + 1]
        if (arg === "--dry-run") dryRun = true
        else if (arg === "--home" && value) home = resolve(argv[++i] as string)
        else return undefined
    }
    return { dryRun, home }
}

if (import.meta.main) {
    const repoRoot = resolve(import.meta.dir, "../../..")
    const args = parseArgs(process.argv.slice(2))
    if (!args) {
        console.error("usage: bun scripts/install.ts [--dry-run] [--home <dir>]")
        process.exit(2)
    }
    for (const line of install({ repoRoot, now: new Date(), ...args })) console.log(line)
}
