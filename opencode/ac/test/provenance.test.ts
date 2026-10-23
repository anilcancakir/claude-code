import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { findDrift, stamp } from "../scripts/provenance.ts"

let repo: string

function put(rel: string, body: string): void {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), body)
}

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ac-oc-prov-"))
})

afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
})

describe("stamp", () => {
    test("writes the header as the first line of a plain file", () => {
        put("plugins/ac/skills/x/SKILL.md", "source body\n")
        put("opencode/ac/skills/x/SKILL.md", "# Ported\n")

        stamp(repo, "opencode/ac/skills/x/SKILL.md", "plugins/ac/skills/x/SKILL.md")

        const first = readFileSync(join(repo, "opencode/ac/skills/x/SKILL.md"), "utf8").split("\n")[0]
        expect(first).toMatch(/^<!-- ported-from: plugins\/ac\/skills\/x\/SKILL\.md sha256:[0-9a-f]{64} -->$/)
    })

    test("writes the header on the first line after YAML frontmatter", () => {
        put("plugins/ac/agents/a.md", "source\n")
        put("opencode/ac/agents/a.md", "---\nmode: subagent\n---\nBody\n")

        stamp(repo, "opencode/ac/agents/a.md", "plugins/ac/agents/a.md")

        const lines = readFileSync(join(repo, "opencode/ac/agents/a.md"), "utf8").split("\n")
        expect(lines[0]).toBe("---")
        expect(lines[2]).toBe("---")
        expect(lines[3]).toMatch(/^<!-- ported-from: plugins\/ac\/agents\/a\.md sha256:[0-9a-f]{64} -->$/)
        expect(lines[4]).toBe("Body")
    })

    test("restamping refreshes the hash and keeps a single header", () => {
        put("plugins/ac/agents/a.md", "v1\n")
        put("opencode/ac/agents/a.md", "---\nmode: subagent\n---\nBody\n")
        stamp(repo, "opencode/ac/agents/a.md", "plugins/ac/agents/a.md")
        appendFileSync(join(repo, "plugins/ac/agents/a.md"), "v2\n")

        stamp(repo, "opencode/ac/agents/a.md", "plugins/ac/agents/a.md")

        const text = readFileSync(join(repo, "opencode/ac/agents/a.md"), "utf8")
        expect(text.match(/ported-from/g)?.length).toBe(1)
        expect(findDrift(repo)).toEqual([])
    })
})

describe("findDrift", () => {
    test("a header-less tree passes", () => {
        put("opencode/ac/agents/a.md", "no header\n")

        expect(findDrift(repo)).toEqual([])
    })

    test("a fresh stamp passes, and one appended byte in the source fails naming the source path", () => {
        put("plugins/ac/agents/oracle.md", "source\n")
        put("opencode/ac/agents/oracle.md", "---\nmode: subagent\n---\nBody\n")
        stamp(repo, "opencode/ac/agents/oracle.md", "plugins/ac/agents/oracle.md")
        expect(findDrift(repo)).toEqual([])

        appendFileSync(join(repo, "plugins/ac/agents/oracle.md"), "x")

        const drift = findDrift(repo)
        expect(drift.length).toBe(1)
        expect(drift[0]).toContain("plugins/ac/agents/oracle.md")
        expect(drift[0]).toContain("opencode/ac/agents/oracle.md")
    })

    test("a recorded source that no longer exists fails naming the source path", () => {
        put("plugins/ac/templates/t.md", "source\n")
        put("opencode/ac/templates/t.md", "Body\n")
        stamp(repo, "opencode/ac/templates/t.md", "plugins/ac/templates/t.md")
        rmSync(join(repo, "plugins/ac/templates/t.md"))

        expect(findDrift(repo)[0]).toContain("plugins/ac/templates/t.md")
    })
})

describe("the real tree", () => {
    test("no ported file has drifted from its recorded source", () => {
        const root = resolve(import.meta.dir, "../../..")

        expect(findDrift(root)).toEqual([])
    })
})
