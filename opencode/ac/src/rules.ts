import type { Plugin } from "@opencode/plugin"
import { readdirSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { findGitRoot, PRIMARY_AGENTS, readIfPresent } from "./memory.ts"

export interface RulesOptions {
    /** Session directory; defaults to the plugin instance location. */
    directory?: string
    /** Agent ids that receive the always-on rules. */
    primaryAgents?: readonly string[]
}

export interface Rule {
    /** Path relative to the repository root, for the model-facing header. */
    name: string
    body: string
    /** Undefined means the rule applies to every path. */
    patterns: string[] | undefined
}

const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"])
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Splits on commas that sit outside braces, so `src/*.{ts,tsx}` stays one pattern. */
function splitOutsideBraces(text: string): string[] {
    const parts: string[] = []
    let current = ""
    let depth = 0
    for (const char of text) {
        if (char === "{") depth++
        if (char === "}") depth--
        if (char === "," && depth === 0) {
            parts.push(current)
            current = ""
        } else {
            current += char
        }
    }
    parts.push(current)
    return parts
}

function unquote(value: string): string {
    const text = value.trim()
    const quote = text[0]
    return (quote === '"' || quote === "'") && text.endsWith(quote) && text.length > 1 ? text.slice(1, -1) : text
}

function pathsFrom(frontmatter: string): string[] | undefined {
    const lines = frontmatter.split(/\r?\n/)
    const index = lines.findIndex((line) => /^paths:/.test(line))
    if (index === -1) return undefined

    const inline = (lines[index] as string).slice("paths:".length).trim()
    let raw: string[]
    if (inline === "") {
        raw = []
        for (const line of lines.slice(index + 1)) {
            const item = /^\s*-\s*(.+)$/.exec(line)
            if (!item) break
            raw.push(item[1] as string)
        }
    } else {
        const list = inline.startsWith("[") && inline.endsWith("]") ? inline.slice(1, -1) : inline
        raw = splitOutsideBraces(list)
    }

    const patterns = raw.map(unquote).filter((pattern) => pattern !== "")
    // Claude Code treats a match-all `paths` the same as no `paths`.
    return patterns.every((pattern) => pattern === "**") ? undefined : patterns
}

export function parseRule(source: string): Pick<Rule, "body" | "patterns"> {
    const match = FRONTMATTER.exec(source)
    if (!match) return { body: source, patterns: undefined }
    return { body: source.slice(match[0].length), patterns: pathsFrom(match[1] as string) }
}

function globToRegex(glob: string): string {
    let out = ""
    let braces = 0
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i] as string
        if (char === "*" && glob[i + 1] === "*") {
            const slash = glob[i + 2] === "/"
            out += slash ? "(?:.*/)?" : ".*"
            i += slash ? 2 : 1
        } else if (char === "*") {
            out += "[^/]*"
        } else if (char === "?") {
            out += "[^/]"
        } else if (char === "{") {
            braces++
            out += "(?:"
        } else if (char === "}" && braces > 0) {
            braces--
            out += ")"
        } else if (char === "," && braces > 0) {
            out += "|"
        } else {
            out += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&")
        }
    }
    return out
}

/**
 * Gitignore-style matching as Claude Code does for rule `paths`: a pattern without a slash matches
 * at any depth, a leading slash anchors it, and a match on a directory covers everything inside.
 */
export function matchesRule(patterns: readonly string[], relativePath: string): boolean {
    return patterns.some((pattern) => {
        let glob = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern
        if (glob.startsWith("/")) glob = glob.slice(1)
        else if (!glob.includes("/")) glob = `**/${glob}`
        return glob !== "" && new RegExp(`^(?:${globToRegex(glob)})(?:/.*)?$`).test(relativePath)
    })
}

function loadRules(root: string): Rule[] {
    const rulesDirectory = join(root, ".claude", "rules")
    let entries
    try {
        entries = readdirSync(rulesDirectory, { withFileTypes: true })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }

    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort()
        .flatMap((file) => {
            const source = readIfPresent(join(rulesDirectory, file))
            if (source === undefined) return []
            const rule = parseRule(source)
            return rule.body.trim() === "" ? [] : [{ name: `.claude/rules/${file}`, ...rule }]
        })
}

function targetPath(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null) return undefined
    const path = (input as Record<string, unknown>).path
    return typeof path === "string" ? path : undefined
}

function ruleText(rule: Rule): string {
    return `Project rule (${rule.name}):\n\n${rule.body.trim()}`
}

/**
 * Ports `.claude/rules` from Claude Code: rules without `paths` ride along as system parts for
 * primary agents; path-scoped rules arrive once per session as a synthetic message after the first
 * read, edit or write of a matching file. Rules are reread on each event so edits take effect.
 */
export function registerRules(ctx: Plugin.Context, options: RulesOptions = {}) {
    const directory = options.directory ?? ctx.location.directory
    const root = findGitRoot(directory) ?? directory
    const primaryAgents = options.primaryAgents ?? PRIMARY_AGENTS
    const injected = new Set<string>()

    const context = ctx.session.hook("context", (event) => {
        if (!primaryAgents.includes(event.agent)) return
        for (const rule of loadRules(root)) {
            if (rule.patterns === undefined) event.system.push({ type: "text", text: ruleText(rule) })
        }
    })

    const afterTool = ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || !FILE_TOOLS.has(event.tool)) return
        const target = targetPath(event.input)
        if (target === undefined) return

        const relativePath = relative(root, resolve(directory, target))
        if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) return

        for (const rule of loadRules(root)) {
            if (rule.patterns === undefined || !matchesRule(rule.patterns, relativePath)) continue
            const key = `${event.sessionID}\0${rule.name}`
            if (injected.has(key)) continue
            injected.add(key)
            await ctx.session.synthetic({
                sessionID: event.sessionID,
                text: ruleText(rule),
                description: `Rule ${rule.name}`,
            })
        }
    })

    return Promise.all([context, afterTool])
}
