import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findCanonicalGitRoot, registerMemory, sanitizePath } from "../src/memory.ts"
import { createFakeCtx } from "./fake-ctx.ts"

let sandbox: string
let home: string
let repo: string

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        stdio: "ignore",
    })
}

function writeMemory(slug: string, content: string): void {
    const dir = join(home, ".claude", "projects", slug, "memory")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "MEMORY.md"), content)
}

async function systemFor(agent: string, directory: string): Promise<string[]> {
    const { ctx, fire } = createFakeCtx()
    await registerMemory(ctx, { directory, home })
    const event = await fire.session("context", {
        agent,
        sessionID: "ses_1",
        system: [{ type: "text", text: "core prompt" }],
    })
    return event.system.map((part) => part.text)
}

beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ac-oc-memory-")))
    home = join(sandbox, "home")
    repo = join(sandbox, "main-repo")
    mkdirSync(home, { recursive: true })
    mkdirSync(repo, { recursive: true })
    git(repo, "init", "-q")
    git(repo, "commit", "-q", "--allow-empty", "-m", "init")
})

afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
})

describe("sanitizePath", () => {
    test("replaces every non-alphanumeric with a hyphen", () => {
        expect(sanitizePath("/Users/anilcan/Code/claude-code")).toBe("-Users-anilcan-Code-claude-code")
    })

    test("keeps a path of exactly 200 characters whole", () => {
        expect(sanitizePath(`/${"a".repeat(199)}`)).toHaveLength(200)
    })
})

describe("findCanonicalGitRoot", () => {
    test("a plain repository resolves to itself from a nested directory", () => {
        mkdirSync(join(repo, "src", "deep"), { recursive: true })

        expect(findCanonicalGitRoot(join(repo, "src", "deep"))).toBe(repo)
    })

    test("a linked worktree resolves to the main repository", () => {
        const worktree = join(sandbox, "linked")
        git(repo, "worktree", "add", "-q", worktree)

        expect(findCanonicalGitRoot(worktree)).toBe(repo)
    })

    test("a directory outside any repository resolves to nothing", () => {
        expect(findCanonicalGitRoot(home)).toBeUndefined()
    })
})

describe("registerMemory", () => {
    test("injects MEMORY.md after the prompt part for the build agent", async () => {
        writeMemory(sanitizePath(repo), "- [Rule](rule.md) - a remembered rule\n")

        const system = await systemFor("build", repo)

        expect(system).toHaveLength(2)
        expect(system[0]).toBe("core prompt")
        expect(system[1]).toContain("Claude Code memory")
        expect(system[1]).toContain("read-only: read topic files with read, never edit them")
        expect(system[1]).toContain("- [Rule](rule.md) - a remembered rule")
    })

    test("a worktree shares the main repository memory", async () => {
        const worktree = join(sandbox, "linked")
        git(repo, "worktree", "add", "-q", worktree)
        writeMemory(sanitizePath(repo), "shared index")

        const system = await systemFor("build", worktree)

        expect(system[1]).toContain("shared index")
    })

    test("missing MEMORY.md injects nothing", async () => {
        expect(await systemFor("build", repo)).toEqual(["core prompt"])
    })

    test("a blank MEMORY.md injects nothing", async () => {
        writeMemory(sanitizePath(repo), "\n  \n")

        expect(await systemFor("build", repo)).toEqual(["core prompt"])
    })

    test("ac subagents get no memory", async () => {
        writeMemory(sanitizePath(repo), "shared index")

        expect(await systemFor("ac/oracle", repo)).toEqual(["core prompt"])
    })

    test("a path over 200 characters is found by prefix scan", async () => {
        const long = join(sandbox, "x".repeat(210))
        mkdirSync(long, { recursive: true })
        git(long, "init", "-q")
        writeMemory(`${sanitizePath(long).slice(0, 200)}-hash123`, "long path index")

        const system = await systemFor("build", long)

        expect(system[1]).toContain("long path index")
    })

    test("rereads the file on every request so edits show up", async () => {
        const { ctx, fire } = createFakeCtx()
        await registerMemory(ctx, { directory: repo, home })
        const request = () =>
            fire.session("context", { agent: "build", sessionID: "ses_1", system: [{ type: "text", text: "core" }] })

        expect((await request()).system).toHaveLength(1)
        writeMemory(sanitizePath(repo), "now present")

        expect((await request()).system[1]?.text).toContain("now present")
    })
})
