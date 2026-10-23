import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

export interface PromptOptions {
    /** Agent ids whose base prompt ac owns; every other agent keeps its own system text. */
    primaryAgents?: readonly string[]
}

type Family = "gpt" | "glm" | "kimi" | "deepseek"
type ToolDefinition = SessionContext["tools"][string]

const FAMILIES: readonly Family[] = [
    "gpt",
    "glm",
    "kimi",
    "deepseek",
]

const SUBAGENT_TOOL = "subagent"

/**
 * Replaces upstream's "NEVER set this unless the user explicitly asks" (core/src/tool/plugin/subagent.ts:36-39),
 * which would stop an ac flow from re-running a worker on the next model of its fallback chain.
 */
const SUBAGENT_MODEL_DESCRIPTION = [
    "Leave unset to run the agent on its configured model.",
    "Set it when the user asks for a particular model or variant, or when an ac skill, command or plan tells you to",
    "re-run a subagent on a fallback model after its configured model failed or was unavailable.",
    'The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant.',
    "Do not guess the ID: take it from that ac instruction or look it up with the models tool.",
].join(" ")

function readPrompt(name: string): string {
    return readFileSync(fileURLToPath(new URL(`./prompts/${name}.md`, import.meta.url)), "utf8").trim()
}

/** Same substring rule as opencode's own per-model prompts (core/src/plugin/optimize.ts:16-60). */
function familyOf(modelID: string): Family | undefined {
    const id = modelID.toLowerCase()
    return FAMILIES.find((family) => id.includes(family))
}

function withFallbackModel(tool: ToolDefinition): void {
    const properties = tool.input.properties as Record<string, Record<string, unknown>> | undefined
    const model = properties?.model
    if (!properties || !model) return

    // The schema object is shared with the tool registry, so copy down instead of writing through it.
    tool.input = {
        ...tool.input,
        properties: {
            ...properties,
            model: {
                ...model,
                description: SUBAGENT_MODEL_DESCRIPTION,
            },
        },
    }
}

/**
 * Owns system[0] for the primary agent: the ac core plus the overlay for the model's family. The texts are
 * fixed at registration, so every request of a session sends a byte-identical prefix and its cache holds.
 */
export async function registerPrompt(ctx: Plugin.Context, options: PromptOptions = {}): Promise<void> {
    const primaryAgents = new Set(options.primaryAgents ?? ["build"])

    // 1. Render every variant once; nothing per turn reaches the system text.
    const core = readPrompt("core")
    const rendered = new Map<Family | undefined, string>([[undefined, core]])
    for (const family of FAMILIES) rendered.set(family, `${core}\n\n${readPrompt(family)}`)

    const hook = (event: SessionContext): void => {
        // 2. The subagent tool is offered to any agent that may delegate, not only the primary one.
        const subagent = event.tools[SUBAGENT_TOOL]
        if (subagent) withFallbackModel(subagent)

        // 3. Subagents (ac/* and opencode's own) carry their own system text; leave it in place.
        if (!primaryAgents.has(event.agent)) return
        const base = event.system[0]
        if (!base) return
        event.system[0] = {
            ...base,
            text: rendered.get(familyOf(event.model.id)) as string,
        }
    }

    await ctx.session.hook("context", hook)
    await ctx.session.hook("compaction", hook)
    await ctx.session.hook("generate", hook)
}
