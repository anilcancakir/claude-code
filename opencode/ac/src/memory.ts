import type { Plugin } from "@opencode/plugin"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export interface MemoryOptions {
    /** Session directory; defaults to the plugin instance location. */
    directory?: string
    /** Home that holds `.claude/projects`; defaults to the user's home. */
    home?: string
    /** Agent ids that receive the part; ac subagents never do. */
    primaryAgents?: readonly string[]
}

export const PRIMARY_AGENTS: readonly string[] = ["build"]

const MAX_SLUG_LENGTH = 200

function slugOf(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Claude Code's project directory slug (utils/sessionStoragePortable.ts sanitizePath). Past 200
 * characters Claude Code appends a hash that differs between Bun and Node, so only the shared
 * prefix is returned and `findMemoryDirectory` finds the real directory by prefix scan.
 */
export function sanitizePath(name: string): string {
    return slugOf(name).slice(0, MAX_SLUG_LENGTH)
}

/** Reads a file that may legitimately be absent; any other failure propagates. */
export function readIfPresent(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8")
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return undefined
        throw error
    }
}

/** Nearest ancestor holding a `.git` entry (directory for a repository, file for a worktree). */
export function findGitRoot(start: string): string | undefined {
    let current = resolve(start)
    while (true) {
        if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) return current
        const parent = dirname(current)
        if (parent === current) return undefined
        current = parent
    }
}

/**
 * The main working tree for a linked worktree, so every worktree shares one memory directory
 * (utils/git.ts resolveCanonicalRoot). The gitdir/commondir back-link checks stop a cloned repo
 * from pointing its `.git` file at someone else's repository.
 */
function mainWorkingTree(gitRoot: string): string {
    const gitEntry = join(gitRoot, ".git")
    if (lstatSync(gitEntry).isDirectory()) return gitRoot

    const pointer = readIfPresent(gitEntry)?.trim()
    if (!pointer?.startsWith("gitdir:")) return gitRoot
    const worktreeGitDir = resolve(gitRoot, pointer.slice("gitdir:".length).trim())

    // A submodule's gitdir has no commondir file; it is its own repository.
    const commonDirText = readIfPresent(join(worktreeGitDir, "commondir"))
    if (commonDirText === undefined) return gitRoot
    const commonDir = resolve(worktreeGitDir, commonDirText.trim())

    if (dirname(worktreeGitDir) !== join(commonDir, "worktrees")) return gitRoot
    const backlink = readIfPresent(join(worktreeGitDir, "gitdir"))?.trim()
    if (!backlink || !existsSync(backlink)) return gitRoot
    if (realpathSync(backlink) !== join(realpathSync(gitRoot), ".git")) return gitRoot

    // A bare repository's common dir is not inside a working tree; it is the stable identity.
    return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir
}

export function findCanonicalGitRoot(start: string): string | undefined {
    const gitRoot = findGitRoot(start)
    return gitRoot === undefined ? undefined : mainWorkingTree(gitRoot)
}

function projectDirectory(projectsDir: string, base: string): string | undefined {
    const slug = slugOf(base)
    if (slug.length <= MAX_SLUG_LENGTH) return join(projectsDir, slug)

    const prefix = `${slug.slice(0, MAX_SLUG_LENGTH)}-`
    let entries
    try {
        entries = readdirSync(projectsDir, { withFileTypes: true })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
    const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    return match ? join(projectsDir, match.name) : undefined
}

export function findMemoryDirectory(directory: string, home: string): string | undefined {
    const base = findCanonicalGitRoot(directory) ?? directory
    const project = projectDirectory(join(home, ".claude", "projects"), base)
    return project === undefined ? undefined : join(project, "memory")
}

/**
 * Appends Claude Code's auto-memory index for the session's repository to primary agents. The
 * index is reread per request so edits made from Claude Code show up; unchanged content keeps the
 * request prefix stable. Topic files are left for the model to read on demand.
 */
export function registerMemory(ctx: Plugin.Context, options: MemoryOptions = {}) {
    const directory = options.directory ?? ctx.location.directory
    const home = options.home ?? homedir()
    const primaryAgents = options.primaryAgents ?? PRIMARY_AGENTS

    return ctx.session.hook("context", (event) => {
        if (!primaryAgents.includes(event.agent)) return

        const memoryDirectory = findMemoryDirectory(directory, home)
        if (memoryDirectory === undefined) return
        const index = readIfPresent(join(memoryDirectory, "MEMORY.md"))?.trim()
        if (!index) return

        event.system.push({
            type: "text",
            text: `Claude Code memory (${memoryDirectory}), read-only: read topic files with read, never edit them.\n\n${index}`,
        })
    })
}
