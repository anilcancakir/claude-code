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
import { loadConfig, parseJsonc } from "../src/config.ts"
import { install } from "../scripts/install.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const SCRIPT = join(REPO_ROOT, "opencode/ac/scripts/install.ts")
const NOW = new Date(2026, 9, 23, 14, 5, 9)
const PRESET_PATH = join(REPO_ROOT, "opencode/ac/config/presets/claude.jsonc")
const AGENTS_DIR = join(REPO_ROOT, "opencode/ac/agents")

/**
 * Claude models opencode serves from its models.dev catalogue under the built-in `anthropic` provider, with the
 * variants core/src/variant.ts (anthropicMessages) derives from each model's `reasoning_options` in the snapshot
 * (`.anthropic.models`): the effort values, plus `none` where the model also offers the thinking toggle.
 */
const ANTHROPIC_CATALOGUE: Record<string, string[]> = {
    "claude-opus-5-5": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ],
    "claude-sonnet-5-5": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ],
    "claude-haiku-5-5": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ],
}

interface Preset {
    title: string
    tiers: Record<string, string[]>
}

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

function render(preset?: string, now: Date = NOW): Rendered {
    install({ repoRoot: REPO_ROOT, home, dryRun: false, now, preset })
    return readJsonc<Rendered>(join(configDir(), "opencode.jsonc"))
}

const claudePreset = (): Preset => readJsonc<Preset>(PRESET_PATH)
const acAgents = (): string[] =>
    readdirSync(AGENTS_DIR)
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.replace(/\.md$/, ""))

/** Chain entries that name neither a provider the rendered config declares nor a Claude catalogue model. */
function unresolvedRefs(rendered: Rendered, refs: string[]): string[] {
    return refs.filter((ref) => {
        const [path = "", variant] = ref.split("#")
        const slash = path.indexOf("/")
        const providerID = path.slice(0, slash)
        const modelID = path.slice(slash + 1)
        const declared = rendered.providers?.[providerID]?.models?.[modelID]
        const variantIDs = declared
            ? declared.variants.map((entry) => entry.id)
            : providerID === "anthropic"
              ? ANTHROPIC_CATALOGUE[modelID]
              : undefined
        return !variantIDs || (variant !== undefined && !variantIDs.includes(variant))
    })
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

describe("install re-run on an ac v2 install", () => {
    const LATER = new Date(2026, 9, 24, 9, 0, 0)

    function seedV2(): void {
        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW })
        writeFileSync(join(configDir(), "service.json"), '{"port":4096}')
        writeFileSync(join(configDir(), "AGENTS.md"), "# Role\n\nFilled in by the operator.\n")
        writeFileSync(join(configDir(), "opencode.jsonc"), "{}")
        writeFileSync(join(configDir(), "cli.json"), "{}")
    }

    test("rewrites opencode.jsonc, cli.json and the agents link and moves nothing", () => {
        seedV2()

        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: LATER })

        expect(readdirSync(join(home, ".config"))).toEqual(["opencode"])
        expect(readFileSync(join(configDir(), "service.json"), "utf8")).toBe('{"port":4096}')
        expect(readFileSync(join(configDir(), "AGENTS.md"), "utf8")).toBe("# Role\n\nFilled in by the operator.\n")
        expect(readFileSync(join(configDir(), "opencode.jsonc"), "utf8")).toContain(`${REPO_ROOT}/opencode/ac`)
        expect(readJsonc<{ attention: unknown }>(join(configDir(), "cli.json")).attention).toEqual({
            notifications: true,
            sound: true,
        })
        const link = join(configDir(), "agents", "ac")
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(realpathSync(link)).toBe(realpathSync(join(REPO_ROOT, "opencode/ac/agents")))
    })

    test("copies the existing opencode.jsonc to a timestamped backup before overwriting it", () => {
        seedV2()

        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: LATER })

        expect(readFileSync(join(configDir(), "opencode.jsonc.bak-20261024-090000"), "utf8")).toBe("{}")
        expect(readFileSync(join(configDir(), "opencode.jsonc"), "utf8")).toContain(`${REPO_ROOT}/opencode/ac`)
    })

    test("backs up cli.json only when it differs from the template", () => {
        seedV2()
        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: LATER })
        expect(readFileSync(join(configDir(), "cli.json.bak-20261024-090000"), "utf8")).toBe("{}")

        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: new Date(2026, 9, 25, 10, 0, 0) })

        expect(existsSync(join(configDir(), "cli.json.bak-20261025-100000"))).toBe(false)
        expect(existsSync(join(configDir(), "opencode.jsonc.bak-20261025-100000"))).toBe(true)
    })

    test("a first install, which has nothing to overwrite, leaves no backup file", () => {
        install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW })

        expect(readdirSync(configDir()).filter((name) => name.includes(".bak-"))).toEqual([])
    })

    test("the dry run names the backups and writes none", () => {
        seedV2()

        const lines = install({ repoRoot: REPO_ROOT, home, dryRun: true, now: LATER }).join("\n")

        expect(lines).toContain("opencode.jsonc.bak-20261024-090000")
        expect(lines).toContain("cli.json.bak-20261024-090000")
        expect(readdirSync(configDir()).filter((name) => name.includes(".bak-"))).toEqual([])
    })

    test("the dry run of a re-run names no move and no AGENTS.md write", () => {
        seedV2()

        const lines = install({ repoRoot: REPO_ROOT, home, dryRun: true, now: LATER }).join("\n")

        expect(lines).not.toContain("move")
        expect(lines).not.toContain("AGENTS.md")
        expect(lines).toContain("opencode.jsonc")
        expect(readFileSync(join(configDir(), "opencode.jsonc"), "utf8")).toBe("{}")
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

    test("the CLI accepts --preset claude and prints the build and title models only", () => {
        const result = Bun.spawnSync(["bun", SCRIPT, "--dry-run", "--preset", "claude", "--home", home])
        const { tiers, title } = claudePreset()

        expect(result.exitCode).toBe(0)
        const lines = result.stdout.toString().split("\n").filter((line) => line.includes("set model"))
        expect(lines).toEqual([
            `would set model build -> ${tiers.main?.[0]}`,
            `would set model title -> ${title}`,
        ])
        expect(existsSync(join(home, ".config"))).toBe(false)
    })

    test.each(["nope", "../presets/claude", "Claude"])("the CLI rejects the preset %s", (preset) => {
        const result = Bun.spawnSync(["bun", SCRIPT, "--dry-run", "--preset", preset, "--home", home])

        expect(result.exitCode).toBe(2)
        expect(existsSync(join(home, ".config"))).toBe(false)
    })
})

describe("rendered opencode.jsonc", () => {
    test("every models.jsonc chain entry resolves to a declared provider or a Claude catalogue model", () => {
        const rendered = render()
        const models = readJsonc<{ tiers: Record<string, string[]> }>(
            join(REPO_ROOT, "opencode/ac/config/models.jsonc"),
        )

        expect(unresolvedRefs(rendered, Object.values(models.tiers).flat())).toEqual([])
    })

    test("every claude preset chain entry and its title model resolve the same way", () => {
        const rendered = render("claude")
        const { tiers, title } = claudePreset()

        expect(unresolvedRefs(rendered, [...Object.values(tiers).flat(), title])).toEqual([])
    })

    test("the resolution check reports an undeclared provider, model or variant", () => {
        const rendered = render()

        expect(unresolvedRefs(rendered, [
            "acme/big#high",
            "anthropic/claude-opus-5-5#ultra",
            "codefast-glm/glm-5.3#medium",
            "anthropic/claude-sonnet-5-5#xhigh",
        ])).toEqual([
            "acme/big#high",
            "anthropic/claude-opus-5-5#ultra",
            "codefast-glm/glm-5.3#medium",
        ])
    })

    test("the codefast providers declare only the four routed model families", () => {
        const { providers } = render()

        expect(Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, Object.keys(provider.models)])))
            .toEqual({
                "codefast-glm": ["glm-5.3"],
                "codefast-kimi": ["kimi-k3"],
                "codefast-deepseek": ["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash"],
                "codefast-qwen": ["qwen3.8-flash"],
            })
    })

    test("the default and build models are the head of the main chain, the title model a fast low variant", () => {
        const config = render()
        const chains = loadConfig({ env: {} })

        expect(config.model).toBe(chains.chain("main")[0] as string)
        expect(config.agents.build?.model).toBe(chains.chain("main")[0] as string)
        expect(config.agents.title?.model).toBe("codefast-qwen/qwen3.8-flash#low")
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
            for (const model of Object.values(provider.models)) {
                expect(model.limit).toEqual({ context: 256000, output: 65536 })
                expect(model.capabilities.tools).toBe(true)
                expect(model.variants.map((variant) => variant.id)).toEqual(["low", "high", "max"])
                for (const variant of model.variants) expect(variant.body).toEqual({ reasoning_effort: variant.id })
            }
        }
    })

    test("the global config disables the built-in agents and base prompts the plugin replaces", () => {
        const config = render()

        expect(config.default_agent).toBe("build")
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

describe("install --preset claude", () => {
    const pluginEntry = (rendered: Rendered) => rendered.plugins.at(-1) as { package: string; options?: unknown }

    test("the default and build models are the head of the preset main chain, the title model Claude Haiku", () => {
        const rendered = render("claude")
        const { tiers } = claudePreset()

        expect(rendered.model).toBe(tiers.main?.[0] as string)
        expect(rendered.agents.build?.model).toBe(tiers.main?.[0] as string)
        expect(rendered.agents.title?.model).toBe("anthropic/claude-haiku-5-5#low")
    })

    test("renders no per-agent override: the plugin gives each ac agent the head of its tier chain", () => {
        const rendered = render("claude")
        const { tiers } = claudePreset()

        expect(Object.keys(rendered.agents).filter((id) => id.startsWith("ac/"))).toEqual([])
        const { models } = pluginEntry(rendered).options as { models: { tiers: Record<string, string[]> } }
        for (const agent of acAgents()) {
            expect(tiers[agent]?.[0]).toBeString()
            expect(models.tiers[agent]?.[0]).toBe(tiers[agent]?.[0] as string)
        }
    })

    test("the ac plugin entry hands the preset chains to the fallback as plugin options", () => {
        const rendered = render("claude")

        expect(pluginEntry(rendered)).toEqual({
            package: `${REPO_ROOT}/opencode/ac`,
            options: { models: { tiers: claudePreset().tiers } },
        })
        expect(loadConfig({ env: {}, options: { models: { tiers: claudePreset().tiers } } }).chain("oracle")[0])
            .toBe("anthropic/claude-opus-5-5#high")
    })

    test("keeps the rest of the template: providers, disabled agents, permissions, mcp and plugin toggles", () => {
        const preset = render("claude")
        rmSync(configDir(), { recursive: true, force: true })
        const base = render()

        expect(preset.providers).toEqual(base.providers)
        expect(preset.permissions).toEqual(base.permissions)
        expect(preset.mcp).toEqual(base.mcp)
        expect(preset.instructions).toEqual(base.instructions)
        expect(preset.skills).toEqual(base.skills)
        expect(preset.plugins.slice(0, -1)).toEqual(base.plugins.slice(0, -1))
        for (const id of ["plan", "explore", "general"]) expect(preset.agents[id]?.disabled).toBe(true)
        expect(readFileSync(join(configDir(), "opencode.jsonc"), "utf8")).not.toContain("<repo>")
    })

    test("a re-run without --preset restores the default render and backs up the preset one", () => {
        render("claude")
        const presetText = readFileSync(join(configDir(), "opencode.jsonc"), "utf8")
        writeFileSync(join(configDir(), "service.json"), '{"port":4096}')
        writeFileSync(join(configDir(), "AGENTS.md"), "# Role\n\nFilled in by the operator.\n")

        const restored = render(undefined, new Date(2026, 9, 24, 9, 0, 0))

        expect(Object.keys(restored.agents).filter((id) => id.startsWith("ac/"))).toEqual([])
        expect(pluginEntry(restored)).toEqual({ package: `${REPO_ROOT}/opencode/ac` })
        expect(restored.model).toBe(loadConfig({ env: {} }).chain("main")[0] as string)
        expect(restored.agents.title?.model).toBe("codefast-qwen/qwen3.8-flash#low")
        expect(readFileSync(join(configDir(), "opencode.jsonc.bak-20261024-090000"), "utf8")).toBe(presetText)
        expect(readFileSync(join(configDir(), "service.json"), "utf8")).toBe('{"port":4096}')
        expect(readFileSync(join(configDir(), "AGENTS.md"), "utf8")).toBe("# Role\n\nFilled in by the operator.\n")
    })

    test("the default preset renders the template unchanged and names only the build and title models", () => {
        const lines = install({ repoRoot: REPO_ROOT, home, dryRun: true, now: NOW, preset: "codefast" })

        expect(lines.filter((line) => line.includes("set model"))).toEqual([
            "would set model build -> codefast-glm/glm-5.3#high",
            "would set model title -> codefast-qwen/qwen3.8-flash#low",
        ])
        render("codefast")
        const template = readFileSync(join(REPO_ROOT, "opencode/ac/templates/opencode.jsonc"), "utf8")
        expect(readFileSync(join(configDir(), "opencode.jsonc"), "utf8")).toBe(template.replaceAll("<repo>", REPO_ROOT))
    })

    test("an unknown preset throws before anything is written", () => {
        expect(() => install({ repoRoot: REPO_ROOT, home, dryRun: false, now: NOW, preset: "nope" })).toThrow("nope")
        expect(existsSync(join(home, ".config"))).toBe(false)
    })
})

interface Rule {
    action: string
    resource: string
    effect: "allow" | "deny" | "ask"
}

const OPERATOR_HOME = "/Users/operator"

/** opencode's Wildcard.match (packages/core/src/util/wildcard.ts): `*` spans `/`, a trailing ` *` is optional. */
function wildcard(input: string, pattern: string): boolean {
    let escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
    return new RegExp(`^${escaped}$`, "s").test(input)
}

/** Path actions get `~/` expanded, as expandPermissions does in packages/core/src/config/plugin/agent.ts. */
function expandHome(rules: Rule[]): Rule[] {
    return rules.map((rule) =>
        ["external_directory", "read", "edit"].includes(rule.action) && rule.resource.startsWith("~/")
            ? { ...rule, resource: join(OPERATOR_HOME, rule.resource.slice(2)) }
            : rule,
    )
}

/** A markdown agent gets the global rules first and its own after; the last matching rule wins. */
function effectFor(agent: string, action: string, resource: string): Rule["effect"] {
    const template = readJsonc<{ permissions: Rule[] }>(join(REPO_ROOT, "opencode/ac/templates/opencode.jsonc"))
    const text = readFileSync(join(REPO_ROOT, "opencode/ac/agents", `${agent}.md`), "utf8")
    const frontmatter = Bun.YAML.parse(text.split(/^---$/m)[1] ?? "") as { permissions: Rule[] }
    const rules = [...expandHome(template.permissions), ...expandHome(frontmatter.permissions)]
    const last = rules.reverse().find((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))
    return last?.effect ?? "ask"
}

describe("agent permissions under opencode's precedence", () => {
    const agents = readdirSync(join(REPO_ROOT, "opencode/ac/agents")).map((file) => file.replace(/\.md$/, ""))

    test("ac/plan-worker-junior cannot edit the CC transcript store", () => {
        expect(effectFor("plan-worker-junior", "edit", `${OPERATOR_HOME}/.claude/projects/x/memory/MEMORY.md`)).toBe(
            "deny",
        )
    })

    test("ac/oracle cannot read a nested .env but can read .env.example", () => {
        expect(effectFor("oracle", "read", "backend/.env")).toBe("deny")
        expect(effectFor("oracle", "read", ".env.example")).toBe("allow")
    })

    test.each(agents)("%s carries the global protections as its last word", (agent) => {
        expect(effectFor(agent, "edit", `${OPERATOR_HOME}/.claude/projects/x/memory/MEMORY.md`)).toBe("deny")
        expect(effectFor(agent, "read", ".env")).toBe("deny")
        expect(effectFor(agent, "read", "backend/.env.local")).toBe("deny")
        expect(effectFor(agent, "read", "worker/.dev.vars")).toBe("deny")
        for (const template of [".env.example", ".env.sample", ".env.dist", ".env.template"]) {
            expect(effectFor(agent, "read", template)).toBe("allow")
        }
    })
})
