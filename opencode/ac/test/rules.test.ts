import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchesRule, parseRule, registerRules } from "../src/rules.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const REAL_RULES = join(import.meta.dir, "..", "..", "..", ".claude", "rules")

let root: string

function setup() {
    const fake = createFakeCtx()
    return { fake, ready: registerRules(fake.ctx, { directory: root }) }
}

function afterRead(
    fake: ReturnType<typeof createFakeCtx>,
    path: string,
    overrides: { tool?: string; sessionID?: string; status?: "completed" | "error"; agent?: string } = {},
) {
    return fake.fire.tool("execute.after", {
        tool: overrides.tool ?? "read",
        sessionID: overrides.sessionID ?? "ses_1",
        agent: overrides.agent ?? "build",
        status: overrides.status ?? "completed",
        input: { path },
    })
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ac-oc-rules-")))
    mkdirSync(join(root, ".git"))
    cpSync(REAL_RULES, join(root, ".claude", "rules"), { recursive: true })
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

describe("parseRule", () => {
    test("no frontmatter is an unscoped rule", () => {
        expect(parseRule("# Title\nbody\n")).toEqual({ body: "# Title\nbody\n", patterns: undefined })
    })

    test("a block list of paths is scoped and the frontmatter is stripped", () => {
        const rule = parseRule('---\npaths:\n  - "a/**/*.md"\n  - b/**\n---\n\n# T\n')

        expect(rule.patterns).toEqual(["a/**/*.md", "b/**"])
        expect(rule.body).toBe("\n# T\n")
    })

    test("an inline comma string splits outside braces", () => {
        expect(parseRule("---\npaths: src/*.{ts,tsx}, docs/**\n---\nx").patterns).toEqual([
            "src/*.{ts,tsx}",
            "docs/**",
        ])
    })

    test("an inline flow list is accepted", () => {
        expect(parseRule('---\npaths: ["a.md", "b.md"]\n---\nx').patterns).toEqual(["a.md", "b.md"])
    })

    test("a match-all paths value is unscoped", () => {
        expect(parseRule('---\npaths:\n  - "**"\n---\nx').patterns).toBeUndefined()
    })

    test("frontmatter without paths is unscoped", () => {
        expect(parseRule("---\ndescription: hi\n---\nx").patterns).toBeUndefined()
    })
})

describe("matchesRule", () => {
    test("a directory pattern matches everything inside it", () => {
        expect(matchesRule(["cli/ac/**"], "cli/ac/src/index.ts")).toBe(true)
        expect(matchesRule(["cli/ac/**"], "cli/other.ts")).toBe(false)
    })

    test("double star spans zero or more directories", () => {
        expect(matchesRule(["cli/**/*.ts"], "cli/a.ts")).toBe(true)
        expect(matchesRule(["cli/**/*.ts"], "cli/ac/src/a.ts")).toBe(true)
        expect(matchesRule(["cli/**/*.ts"], "cli/ac/src/a.md")).toBe(false)
    })

    test("a pattern without a slash matches at any depth", () => {
        expect(matchesRule(["*.md"], "docs/deep/readme.md")).toBe(true)
    })

    test("braces alternate", () => {
        expect(matchesRule(["src/*.{ts,tsx}"], "src/a.tsx")).toBe(true)
        expect(matchesRule(["src/*.{ts,tsx}"], "src/a.js")).toBe(false)
    })
})

describe("registerRules at session start", () => {
    test("golden-rules.md (no paths) is appended after the prompt part", async () => {
        const { fake, ready } = setup()
        await ready

        const event = await fake.fire.session("context", {
            agent: "build",
            sessionID: "ses_1",
            system: [{ type: "text", text: "core prompt" }],
        })

        expect(event.system[0]?.text).toBe("core prompt")
        expect(event.system.slice(1).map((part) => part.text).join("\n")).toContain("# Golden Rules")
    })

    test("path-scoped rules are not in the system parts", async () => {
        const { fake, ready } = setup()
        await ready

        const event = await fake.fire.session("context", {
            agent: "build",
            sessionID: "ses_1",
            system: [{ type: "text", text: "core prompt" }],
        })

        const all = event.system.map((part) => part.text).join("\n")
        expect(all).not.toContain("# `ac` plugin authoring rules")
        expect(all).not.toContain("# CLI build rules")
        expect(all).not.toContain("# `ac` hook authoring rules")
    })

    test("ac subagents get no unscoped rules", async () => {
        const { fake, ready } = setup()
        await ready

        const event = await fake.fire.session("context", {
            agent: "ac/oracle",
            sessionID: "ses_1",
            system: [{ type: "text", text: "core prompt" }],
        })

        expect(event.system).toHaveLength(1)
    })

    test("no rules directory injects nothing", async () => {
        rmSync(join(root, ".claude"), { recursive: true })
        const { fake, ready } = setup()
        await ready

        const event = await fake.fire.session("context", {
            agent: "build",
            sessionID: "ses_1",
            system: [{ type: "text", text: "core prompt" }],
        })

        expect(event.system).toHaveLength(1)
    })
})

describe("registerRules path-scoped injection", () => {
    test("ac-plugin.md is injected once after reading a matching file", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, join(root, "plugins/ac/agents/x.md"))
        await afterRead(fake, join(root, "plugins/ac/agents/y.md"))

        expect(fake.calls.synthetic).toHaveLength(1)
        const call = fake.calls.synthetic[0]
        expect(call?.sessionID).toBe("ses_1" as never)
        expect(call?.text).toContain("# `ac` plugin authoring rules")
        expect(call?.text).not.toContain("paths:")
    })

    test("a relative tool path is resolved against the directory", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, "plugins/ac/agents/x.md", { tool: "edit" })

        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a rule matched by two different files is injected once", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, join(root, "plugins/ac/cli/ac.js"), { tool: "write" })
        await afterRead(fake, join(root, "cli/ac/src/index.ts"))

        const texts = fake.calls.synthetic.map((call) => call.text)
        expect(texts).toHaveLength(1)
        expect(texts[0]).toContain("# CLI build rules")
    })

    test("each session is injected separately", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, join(root, "plugins/ac/hooks/a.sh"), { sessionID: "ses_1" })
        await afterRead(fake, join(root, "plugins/ac/hooks/a.sh"), { sessionID: "ses_2" })

        expect(fake.calls.synthetic.map((call) => call.sessionID)).toEqual(["ses_1", "ses_2"] as never)
    })

    test("subagent sessions are injected too", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, join(root, "plugins/ac/hooks/a.sh"), { agent: "ac/junior", sessionID: "ses_sub" })

        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a patch injects the rules of every file it adds, updates, moves to or deletes", async () => {
        const { fake, ready } = setup()
        await ready
        const patchText = [
            "*** Begin Patch",
            "*** Add File: plugins/ac/agents/new.md",
            "+x",
            "*** Update File: README.md",
            "@@",
            "-a",
            "+b",
            "*** Move to: cli/ac/src/moved.ts",
            "*** Delete File: plugins/ac/hooks/gone.sh",
            "*** End Patch",
        ].join("\n")

        await fake.fire.tool("execute.after", {
            tool: "patch",
            sessionID: "ses_1",
            agent: "build",
            status: "completed",
            input: { patchText },
        })

        const texts = fake.calls.synthetic.map((call) => call.text).join("\n")
        expect(fake.calls.synthetic).toHaveLength(3)
        expect(texts).toContain("# `ac` plugin authoring rules")
        expect(texts).toContain("# CLI build rules")
        expect(texts).toContain("# `ac` hook authoring rules")
    })

    test("a patch touching only unmatched files, or without patch text, injects nothing", async () => {
        const { fake, ready } = setup()
        await ready

        await fake.fire.tool("execute.after", {
            tool: "patch",
            sessionID: "ses_1",
            agent: "build",
            status: "completed",
            input: { patchText: "*** Begin Patch\n*** Add File: README.md\n+x\n*** End Patch" },
        })
        await fake.fire.tool("execute.after", {
            tool: "patch",
            sessionID: "ses_1",
            agent: "build",
            status: "completed",
            input: {},
        })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("non file tools, failed calls and non matching paths inject nothing", async () => {
        const { fake, ready } = setup()
        await ready

        await afterRead(fake, join(root, "plugins/ac/agents/x.md"), { tool: "grep" })
        await afterRead(fake, join(root, "plugins/ac/agents/x.md"), { status: "error" })
        await afterRead(fake, join(root, "README.md"))
        await afterRead(fake, join(tmpdir(), "elsewhere/plugins/ac/agents/x.md"))

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a rule written after registration is picked up", async () => {
        const { fake, ready } = setup()
        await ready
        writeFileSync(join(root, ".claude", "rules", "late.md"), "---\npaths:\n  - late/**\n---\nlate rule\n")

        await afterRead(fake, join(root, "late/a.txt"))

        expect(fake.calls.synthetic[0]?.text).toContain("late rule")
    })
})
