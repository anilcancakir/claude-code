import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { PRIMARY_AGENTS } from "./memory.ts"

export interface PromptOptions {
    /** Agent ids whose base prompt ac owns; every other agent keeps its own system text. */
    primaryAgents?: readonly string[]
    /** Appends the family overlay, without the core, to the system text of every `ac/*` subagent. Default true. */
    subagentOverlay?: boolean
}

type ToolDefinition = SessionContext["tools"][string]

/** The two renderings of one family overlay: the primary agent gets both parts, an ac subagent the shared one. */
interface Overlay {
    primary: string
    subagent: string
}

/**
 * Overlay file per model family, in match order. The Claude family lives in `anthropic.md`: on a case-insensitive
 * disk `claude.md` is the same name as CLAUDE.md, which Claude Code loads as nested project instructions.
 */
const FAMILY_FILES = {
    gpt: "gpt",
    glm: "glm",
    kimi: "kimi",
    deepseek: "deepseek",
    qwen: "qwen",
    claude: "anthropic",
} as const

type Family = keyof typeof FAMILY_FILES

const FAMILIES = Object.keys(FAMILY_FILES) as Family[]

const SUBAGENT_TOOL = "subagent"
const AC_SUBAGENT_PREFIX = "ac/"

/** Everything after this line of an overlay addresses the user or the `question` tool, so subagents never see it. */
const PRIMARY_ONLY_MARKER = "<!-- primary-only -->"

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

function readOverlay(family: Family): Overlay {
    const [shared = "", primaryOnly = ""] = readPrompt(FAMILY_FILES[family])
        .split(PRIMARY_ONLY_MARKER)
        .map((part) => part.trim())

    return {
        primary: [shared, primaryOnly].filter(Boolean).join("\n\n"),
        subagent: shared,
    }
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
 * Owns system[0] for the primary agent: the ac core plus the overlay for the model's family. An `ac/*` subagent
 * keeps its agent body and gets the subagent part of that overlay appended. The texts are fixed at registration
 * and depend only on (agent, family), so every request of a session sends a byte-identical prefix and its
 * cache holds.
 */
export async function registerPrompt(ctx: Plugin.Context, options: PromptOptions = {}): Promise<void> {
    const primaryAgents = new Set(options.primaryAgents ?? PRIMARY_AGENTS)
    const subagentOverlay = options.subagentOverlay ?? true

    // 1. Render every variant once; nothing per turn reaches the system text.
    const core = readPrompt("core")
    const overlays = new Map(FAMILIES.map((family) => [family, readOverlay(family)]))
    const rendered = new Map<Family | undefined, string>([[undefined, core]])
    for (const [family, overlay] of overlays) rendered.set(family, `${core}\n\n${overlay.primary}`)

    const hook = (event: SessionContext): void => {
        // 2. The subagent tool is offered to any agent that may delegate, not only the primary one.
        const subagent = event.tools[SUBAGENT_TOOL]
        if (subagent) withFallbackModel(subagent)

        const base = event.system[0]
        if (!base) return
        const family = familyOf(event.model.id)

        // 3. The primary agent's base prompt is ac's own.
        if (primaryAgents.has(event.agent)) {
            event.system[0] = {
                ...base,
                text: rendered.get(family) as string,
            }
            return
        }

        // 4. An ac subagent's system[0] is its agent body, rebuilt per request; opencode's own subagents stay as is.
        const overlay = family && overlays.get(family)
        if (!subagentOverlay || !overlay || !event.agent.startsWith(AC_SUBAGENT_PREFIX)) return
        event.system[0] = {
            ...base,
            text: `${base.text}\n\n${overlay.subagent}`,
        }
    }

    await ctx.session.hook("context", hook)
    await ctx.session.hook("compaction", hook)
    await ctx.session.hook("generate", hook)
}
