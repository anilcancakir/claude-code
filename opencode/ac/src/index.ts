import { Plugin } from "@opencode/plugin"
import { registerAgentModels } from "./agent-models.ts"
import { registerCommands } from "./commands.ts"
import { loadConfig } from "./config.ts"
import { registerCoordinate } from "./coordinate.ts"
import { registerDiagnostics } from "./diagnostics.ts"
import { registerFallback } from "./fallback.ts"
import { registerMemory } from "./memory.ts"
import { registerPrompt } from "./prompt.ts"
import { registerRules } from "./rules.ts"
import { registerRunGuards } from "./run-guards.ts"
import { registerToolPolicy } from "./tool-policy.ts"
import { registerBackgroundShells } from "./wake.ts"

export default Plugin.define({
    id: "ac",
    async setup(ctx) {
        // Each module reads the plugin option named after it; `models` is read by loadConfig below.
        const { options } = ctx

        // 1. Prompt first: it replaces system[0], so the memory and rules parts appended after it keep their place.
        await registerPrompt(ctx, options.prompt)
        await registerMemory(ctx, options.memory)
        await registerRules(ctx, options.rules)

        // 2. Guards and policy hooks; the run guards own a subscription that must end with the plugin.
        const shells = await registerBackgroundShells(ctx)
        const stopRunGuards = await registerRunGuards(ctx, options.runGuards, shells)
        await registerToolPolicy(ctx, options.toolPolicy)

        // 3. Model chains come from the bundled defaults, overridden by the `models` plugin option. One instance feeds
        //    the agents' starting models and the fallback walk, so both read the same chains.
        const models = loadConfig({ options })
        const stopAgentModels = await registerAgentModels(ctx, models)
        await registerFallback(ctx, models)
        // No directory option: each instance must root itself at its own location, or more than one would relay a lane.
        const stopCoordinate = await registerCoordinate(ctx, models, { shells })
        await registerDiagnostics(ctx, options.diagnostics)
        await registerCommands(ctx)

        return () => {
            stopRunGuards()
            shells.stop()
            stopAgentModels()
            stopCoordinate()
        }
    },
})
