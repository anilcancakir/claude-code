import type { Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { ModelConfig, ModelRef } from "./config.ts"
import { parseModelRef } from "./fallback.ts"

const AC_AGENT_PREFIX = "ac/"

/** Published by the host after a plugin generation has loaded, the built-in config plugins included. */
const PLUGINS_SETTLED_EVENT = "plugin.updated"

async function untilPluginsSettled(ctx: Plugin.Context): Promise<void> {
    for await (const event of ctx.event.subscribe()) {
        if (event.type === PLUGINS_SETTLED_EVENT) return
    }
}

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
 */
export async function registerAgentModels(ctx: Plugin.Context, config: ModelConfig): Promise<void> {
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
    untilPluginsSettled(ctx)
        .then(() => ctx.agent.transform(apply))
        .catch((error: unknown) => console.error("ac agent models: could not register the model transform", error))
}
