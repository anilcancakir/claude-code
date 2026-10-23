import type { Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { ModelConfig, ModelRef } from "./config.ts"
import { parseModelRef } from "./fallback.ts"
import { log } from "./log.ts"

const AC_AGENT_PREFIX = "ac/"

/** Published by the host after a plugin generation has loaded, the built-in config plugins included. */
const PLUGINS_SETTLED_EVENT = "plugin.updated"

/**
 * Moves every `ac/<tier>` agent to the head of its tier chain, so one place (the `models` plugin option over
 * config/models.jsonc) decides both the model a worker starts on and the chain `ac_fallback_next` walks.
 *
 * The transform is registered once the host has settled its plugins, not at setup. Transforms run in registration
 * order on every rebuild of the agent state, and opencode loads package plugins before its own config plugin, which
 * is the one that applies a markdown agent's frontmatter `model` (core/src/plugin/supervisor.ts:100-102,
 * core/src/config/plugin/agent.ts:84-107). A transform registered at setup would run before the markdown agents exist
 * and the frontmatter model would be applied over it. Only `model` is written: the agents already carry their
 * permissions, and an update of an existing agent adds no rule (config/plugin/agent.ts:103-105).
 *
 * A later activation that reloads the config plugin but not this one (a plugin listed after ac changed) re-registers
 * the config plugin's transform behind ours (core/src/plugin.ts:108-146), so every `plugin.updated` moves this one
 * back to the end. Registering a transform publishes no `plugin.updated`, so this cannot loop.
 */
export async function registerAgentModels(ctx: Plugin.Context, config: ModelConfig): Promise<() => void> {
    const apply = (editor: AgentEditor): void => {
        for (const { id } of editor.list()) {
            const tier = id.slice(AC_AGENT_PREFIX.length)
            // A tier without a chain keeps its frontmatter model.
            if (!id.startsWith(AC_AGENT_PREFIX) || !config.hasChain(tier)) continue
            const head = config.chain(tier)[0] as ModelRef
            editor.update(id, (agent) => {
                agent.model = parseModelRef(head)
            })
        }
    }

    // Not awaited: the host finishes activating only after this setup returns, and that is the event waited for.
    const controller = new AbortController()
    const follow = async (): Promise<void> => {
        let registration: { dispose: () => Promise<void> } | undefined
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type !== PLUGINS_SETTLED_EVENT) continue
            await registration?.dispose()
            registration = await ctx.agent.transform(apply)
        }
    }
    follow().catch((error: unknown) => log("error", "ac agent models: could not register the model transform", error))

    return () => controller.abort()
}
