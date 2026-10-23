import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseJsonc } from "../src/config.ts"
import { install } from "../scripts/install.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const SCRIPT = join(REPO_ROOT, "opencode/ac/scripts/install.ts")
const NOW = new Date(2026, 9, 23, 14, 5, 9)

interface Variant {
    id: string
    body: Record<string, unknown>
}

interface Model {
    limit: { context: number; output: number }
    capabilities: { tools: boolean }
    variants: Variant[]
}

interface Provider {
    package: string
    settings: { baseURL: string; apiKey: string }
    models: Record<string, Model>
}

interface Rendered {
    model: string
    default_agent: string
    update: string
    websearch: boolean
    snapshots: boolean
    agents: Record<string, { model?: string; disabled?: boolean }>
    plugins: unknown[]
    providers: Record<string, Provider>
    mcp: { servers: Record<string, unknown> }
    permissions: unknown[]
    instructions: string[]
    skills: string[]
}

let home: string

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ac-oc-install-"))
})

afterEach(() => {
    rmSync(home, { recursive: true, force: true })
})

const configDir = () => join(home, ".config", "opencode")
const readJsonc = <T>(path: string): T => parseJsonc(readFileSync(path, "utf8"), path) as T

function seedV1(): void {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(join(configDir(), "opencode.json"), '{"theme":"v1"}')
}

function render(): Rendered {
    install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW })
    return readJsonc<Rendered>(join(configDir(), "opencode.jsonc"))
}

describe("install backup", () => {
    test("moves an existing v1 config into a timestamped backup directory", () => {
        seedV1()

        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW })

        const backup = join(home, ".config", "opencode.bak-v1-20261023-140509")
        expect(readFileSync(join(backup, "opencode.json"), "utf8")).toBe('{"theme":"v1"}')
        expect(existsSync(join(configDir(), "opencode.json"))).toBe(false)
        expect(existsSync(join(configDir(), "opencode.jsonc"))).toBe(true)
    })

    test("creates no backup when there is no previous config", () => {
        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW })

        expect(readdirSync(join(home, ".config")).filter((name) => name.includes(".bak-v1-"))).toEqual([])
    })
})

describe("install outputs", () => {
    test("opencode.jsonc parses as JSONC with every placeholder resolved", () => {
        render()

        const raw = readFileSync(join(configDir(), "opencode.jsonc"), "utf8")
        expect(raw).not.toContain("<repo>")
        expect(raw).toContain(`${REPO_ROOT}/plugins/ac/cli/ac.js`)
    })

    test("cli.json enables notifications and sound", () => {
        render()

        const cli = readJsonc<{ attention: unknown }>(join(configDir(), "cli.json"))

        expect(cli.attention).toEqual({ notifications: true, sound: true })
    })

    test("agents/ac is a symlink to the repo agents directory", () => {
        render()

        const link = join(configDir(), "agents", "ac")
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(realpathSync(link)).toBe(realpathSync(join(REPO_ROOT, "opencode/ac/agents")))
    })

    test("AGENTS.md drops the provenance line and maintainer notes but keeps the placeholders", () => {
        render()

        const text = readFileSync(join(configDir(), "AGENTS.md"), "utf8")
        expect(text).not.toContain("ported-from")
        expect(text).not.toContain("MAINTAINER NOTES")
        expect(text.startsWith("# Role")).toBe(true)
        expect(text).toContain("<name>")
    })
})

describe("install dry run", () => {
    test("writes nothing and leaves a v1 config in place", () => {
        seedV1()

        const lines = install({ repoRoot: REPO_ROOT, home, dryRun: true, now: NOW })

        expect(readdirSync(join(home, ".config"))).toEqual(["opencode"])
        expect(readdirSync(configDir())).toEqual(["opencode.json"])
        expect(lines.join("\n")).toContain("opencode.bak-v1-20261023-140509")
    })

    test("the CLI accepts --home and --dry-run and prints the plan", () => {
        const result = Bun.spawnSync(["bun", SCRIPT, "--dry-run", "--home", home])

        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("opencode.jsonc")
        expect(existsSync(join(home, ".config"))).toBe(false)
    })

    test("the CLI rejects an unknown flag", () => {
        const result = Bun.spawnSync(["bun", SCRIPT, "--nope"])

        expect(result.exitCode).toBe(2)
    })
})

describe("rendered opencode.jsonc", () => {
    test("every models.jsonc chain entry resolves to a declared provider, model and variant", () => {
        const rendered = render()
        const models = readJsonc<{ tiers: Record<string, string[]> }>(
            join(REPO_ROOT, "opencode/ac/config/models.jsonc"),
        )

        const unresolved: string[] = []
        for (const refs of Object.values(models.tiers)) {
            for (const ref of refs) {
                const [path = "", variant] = ref.split("#")
                const slash = path.indexOf("/")
                const providerID = path.slice(0, slash)
                const modelID = path.slice(slash + 1)
                if (providerID === "opencode-go") continue

                const model = rendered.providers?.[providerID]?.models?.[modelID]
                const variantIDs = (model?.variants ?? []).map((entry) => entry.id)
                if (!model || (variant && !variantIDs.includes(variant))) unresolved.push(ref)
            }
        }

        expect(unresolved).toEqual([])
    })

    test("each codefast provider is an openai-compatible endpoint keyed by an env substitution", () => {
        const { providers } = render()

        expect(Object.keys(providers).sort()).toEqual([
            "codefast-deepseek",
            "codefast-glm",
            "codefast-kimi",
            "codefast-qwen",
        ])
        for (const provider of Object.values(providers)) {
            expect(provider.package).toBe("aisdk:@ai-sdk/openai-compatible")
            expect(provider.settings.apiKey).toBe("{env:CODEFAST_API_KEY}")
            expect(provider.settings.baseURL).toMatch(/^https:\/\/api\.codefast\.app\/[a-z0-9-]+\/v1$/)
            const models = Object.values(provider.models)
            expect(models).toHaveLength(1)
            for (const model of models) {
                expect(model.limit).toEqual({ context: 256000, output: 65536 })
                expect(model.capabilities.tools).toBe(true)
                expect(model.variants.map((variant) => variant.id)).toEqual(["low", "high", "max"])
                for (const variant of model.variants) expect(variant.body).toEqual({ reasoning_effort: variant.id })
            }
        }
    })

    test("the global config disables the built-in agents and base prompts the plugin replaces", () => {
        const config = render()

        expect(config.model).toBe("codefast-glm/glm-5.3")
        expect(config.default_agent).toBe("build")
        expect(config.agents.build?.model).toBe("codefast-glm/glm-5.3#high")
        expect(config.agents.title?.model).toBe("codefast-qwen/qwen3.8-max#low")
        for (const id of ["plan", "explore", "general"]) expect(config.agents[id]?.disabled).toBe(true)
        expect(config.plugins.slice(0, 6)).toEqual([
            "*",
            "-opencode.prompt.openai",
            "-opencode.prompt.kimi",
            "-opencode.prompt.anthropic",
            "-opencode.prompt.arcee",
            "-opencode.prompt.meta",
        ])
        expect(config.plugins.at(-1)).toEqual({ package: `${REPO_ROOT}/opencode/ac` })
        expect(config.websearch).toBe(false)
        expect(config.snapshots).toBe(false)
        expect(config.update).toBe("notify")
    })

    test("the ac MCP server is a direct local server that receives the kodizm env", () => {
        const { mcp } = render()

        expect(mcp.servers.ac).toEqual({
            type: "local",
            command: ["node", `${REPO_ROOT}/plugins/ac/cli/ac.js`, "mcp", "--client", "opencode"],
            codemode: false,
            environment: {
                KODIZM_MCP_TOKEN: "{env:KODIZM_MCP_TOKEN}",
                KODIZM_MCP_URL: "{env:KODIZM_MCP_URL}",
            },
        })
    })

    test("permissions deny the CC transcript store and hidden tools and ask for dev vars", () => {
        const { permissions } = render()

        expect(permissions).toEqual([
            { action: "edit", resource: "~/.claude/projects/**", effect: "deny" },
            { action: "opencode_list_mcp_resources", resource: "*", effect: "deny" },
            { action: "opencode_read_mcp_resource", resource: "*", effect: "deny" },
            { action: "ac_search-history", resource: "*", effect: "deny" },
            { action: "skill", resource: "report", effect: "deny" },
            { action: "read", resource: "*.dev.vars", effect: "ask" },
        ])
    })

    test("instructions pick up the project CC memory files and skills point at the repo", () => {
        const config = render()

        expect(config.instructions).toEqual(["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"])
        expect(config.skills).toEqual([`${REPO_ROOT}/opencode/ac/skills`])
    })

    test("the templates carry no secret value", () => {
        render()

        for (const name of ["opencode.jsonc", "cli.json"]) {
            expect(readFileSync(join(configDir(), name), "utf8")).not.toMatch(/sk-|kdz-|Bearer [A-Za-z0-9]/)
        }
    })
})
