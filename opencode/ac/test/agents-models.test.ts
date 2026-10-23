import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, parseJsonc } from "../src/config.ts"

const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url))
const MODEL_LINE = /^model:\s*"([^"]+)"\s*$/m
const PRESET_PATH = fileURLToPath(new URL("../config/presets/claude.jsonc", import.meta.url))

const temporaries: string[] = []

/** Agents whose frontmatter `model:` differs from the head of their tier chain; the tier is the file name. */
function mismatchedAgents(directory: string): string[] {
    const config = loadConfig({ env: {} })
    return readdirSync(directory)
        .filter((file) => file.endsWith(".md"))
        .filter((file) => {
            const tier = basename(file, ".md")
            const declared = MODEL_LINE.exec(readFileSync(join(directory, file), "utf8"))?.[1]
            return declared !== config.chain(tier)[0]
        })
        .map((file) => basename(file, ".md"))
}

afterEach(() => {
    for (const directory of temporaries.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("agent models", () => {
    test("every agent declares the head of its tier chain", () => {
        expect(readdirSync(AGENTS_DIR).filter((file) => file.endsWith(".md"))).toHaveLength(10)
        expect(mismatchedAgents(AGENTS_DIR)).toEqual([])
    })

    test("an agent edited away from its chain head is reported", () => {
        const copy = mkdtempSync(join(tmpdir(), "ac-oc-agents-"))
        temporaries.push(copy)
        cpSync(AGENTS_DIR, copy, { recursive: true })
        const oracle = join(copy, "oracle.md")
        writeFileSync(oracle, readFileSync(oracle, "utf8").replace(MODEL_LINE, 'model: "acme/other#low"'))

        expect(mismatchedAgents(copy)).toEqual(["oracle"])
    })

    test("the claude preset has a chain for every agent file, which the plugin turns into the agent's model", () => {
        const { tiers } = parseJsonc(readFileSync(PRESET_PATH, "utf8"), PRESET_PATH) as {
            tiers: Record<string, string[]>
        }

        const unrouted = readdirSync(AGENTS_DIR)
            .filter((file) => file.endsWith(".md"))
            .map((file) => basename(file, ".md"))
            .filter((tier) => !tiers[tier]?.[0])
        expect(unrouted).toEqual([])
    })
})
