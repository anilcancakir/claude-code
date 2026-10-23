import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config.ts"
import { registerAgentModels } from "../src/agent-models.ts"
import { createFakeCtx, type FakeAgent, type FakeCtx } from "./fake-ctx.ts"

/** Fixture chains, independent of config/models.jsonc, so a preset edit cannot break the mapping mechanics. */
const TIERS = {
    "plan-worker-junior": { replace: ["anthropic/claude-sonnet-5-5#high", "codefast-glm/glm-5.3#high"] },
    oracle: { replace: ["openrouter/anthropic/claude-opus-5-5"] },
}

const FRONTMATTER = { providerID: "codefast-deepseek", id: "deepseek-v4.1-flash-1017", variant: "high" }
const PERMISSIONS = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "edit", resource: "~/.claude/projects/**", effect: "deny" },
]

/** An agent as the host builds it from a markdown file: frontmatter model, global rules, then its own. */
const markdownAgent = (id: string): FakeAgent => ({ id, model: { ...FRONTMATTER }, permissions: [...PERMISSIONS] })

const AGENTS: FakeAgent[] = [
    markdownAgent("ac/plan-worker-junior"),
    markdownAgent("ac/oracle"),
    markdownAgent("ac/not-a-tier"),
    markdownAgent("build"),
    markdownAgent("explore"),
    markdownAgent("acme/plan-worker-junior"),
]

/** Resolves once the fake's event loop has delivered what was pushed and the registration it triggers has run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function setup(agents: FakeAgent[] = AGENTS): Promise<FakeCtx> {
    const fake = createFakeCtx({ agents })
    // The host's config plugin: it applies the markdown frontmatter model to every agent in its own transform.
    await fake.ctx.agent.transform((editor) => {
        for (const agent of editor.list()) agent.model = { ...FRONTMATTER } as never
    })
    await registerAgentModels(fake.ctx, loadConfig({ env: {}, options: { models: { tiers: TIERS } } }))
    return fake
}

async function settle(fake: FakeCtx): Promise<void> {
    fake.pushEvent({ type: "plugin.updated" })
    await flush()
    fake.applyTransforms()
}

describe("registerAgentModels", () => {
    test("an ac agent runs the head of its tier chain once the host has settled its plugins", async () => {
        const fake = await setup()

        await settle(fake)

        expect(fake.agents.get("ac/plan-worker-junior")?.model).toEqual({
            providerID: "anthropic",
            id: "claude-sonnet-5-5",
            variant: "high",
        })
    })

    test("a model id with slashes and no variant parses like the host's Model.Ref.parse", async () => {
        const fake = await setup()

        await settle(fake)

        expect(fake.agents.get("ac/oracle")?.model).toEqual({
            providerID: "openrouter",
            id: "anthropic/claude-opus-5-5",
        })
    })

    test("a tier left on the bundled chains takes the head of that default chain", async () => {
        const fake = createFakeCtx({ agents: [markdownAgent("ac/explore")] })
        const config = loadConfig({ env: {}, options: { models: { tiers: TIERS } } })
        await registerAgentModels(fake.ctx, config)

        await settle(fake)

        const head = config.chain("explore")[0] as string
        const model = fake.agents.get("ac/explore")?.model
        expect(`${model?.providerID}/${model?.id}#${model?.variant}`).toBe(head)
    })

    test("a transform registered at setup would run before the host's own and lose, so none is registered yet", async () => {
        const fake = await setup()

        fake.applyTransforms()

        expect(fake.agents.get("ac/plan-worker-junior")?.model).toEqual(FRONTMATTER)
    })

    test("the model wins over a host transform that registers after the plugin's setup", async () => {
        const fake = createFakeCtx({ agents: AGENTS })
        await registerAgentModels(fake.ctx, loadConfig({ env: {}, options: { models: { tiers: TIERS } } }))
        await fake.ctx.agent.transform((editor) => {
            for (const agent of editor.list()) agent.model = { ...FRONTMATTER } as never
        })

        await settle(fake)

        expect(fake.agents.get("ac/plan-worker-junior")?.model?.providerID).toBe("anthropic")
    })

    test("a later activation that re-registers the host's transform behind ours is answered on its update", async () => {
        const fake = await setup()
        await settle(fake)

        // A plugin listed after ac changed: the host reloads the suffix and its config transform lands last.
        await fake.ctx.agent.transform((editor) => {
            for (const agent of editor.list()) agent.model = { ...FRONTMATTER } as never
        })
        fake.applyTransforms()
        expect(fake.agents.get("ac/plan-worker-junior")?.model).toEqual(FRONTMATTER)

        await settle(fake)

        expect(fake.agents.get("ac/plan-worker-junior")?.model?.providerID).toBe("anthropic")
    })

    test("ignores every other event type", async () => {
        const fake = await setup()

        fake.pushEvent({ type: "agent.updated" })
        await flush()
        fake.applyTransforms()

        expect(fake.agents.get("ac/plan-worker-junior")?.model).toEqual(FRONTMATTER)
    })

    test("agents that are not ac tiers keep their model", async () => {
        const fake = await setup()

        await settle(fake)

        for (const id of ["ac/not-a-tier", "build", "explore", "acme/plan-worker-junior"]) {
            expect(fake.agents.get(id)?.model).toEqual(FRONTMATTER)
        }
    })

    test("touches the model only: permissions keep their identity and content, no agent appears or goes", async () => {
        const fake = await setup()
        const seen = new Map<string, { list: unknown[]; copy: unknown[] }>()
        await fake.ctx.agent.transform((editor) => {
            for (const agent of editor.list()) seen.set(agent.id, { list: agent.permissions, copy: [...agent.permissions] })
        })
        await settle(fake)

        expect([...fake.agents.keys()]).toEqual(AGENTS.map((agent) => agent.id))
        for (const [id, agent] of fake.agents) {
            expect(agent.permissions).toBe(seen.get(id)?.list as never)
            expect(agent.permissions).toEqual(PERMISSIONS)
            expect(Object.keys(agent).sort()).toEqual(["id", "model", "permissions"])
        }
    })

    test("applies again on every rebuild of the agent state", async () => {
        const fake = await setup()
        await settle(fake)

        fake.applyTransforms()
        fake.applyTransforms()

        expect(fake.agents.get("ac/plan-worker-junior")?.model?.providerID).toBe("anthropic")
    })

    test("returns before the host settles, so setup never waits on its own activation", async () => {
        const fake = createFakeCtx({ agents: AGENTS })

        const registered = registerAgentModels(fake.ctx, loadConfig({ env: {} }))

        expect(await Promise.race([registered.then(() => "returned"), flush().then(() => "blocked")])).toBe("returned")
    })
})
