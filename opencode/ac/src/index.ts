import { Plugin } from "@opencode/plugin"
import { registerCommands } from "./commands.ts"
import { loadConfig } from "./config.ts"
import { registerDiagnostics } from "./diagnostics.ts"
import { registerFallback } from "./fallback.ts"
import { registerMemory } from "./memory.ts"
import { registerPrompt } from "./prompt.ts"
import { registerRules } from "./rules.ts"
import { registerRunGuards } from "./run-guards.ts"
import { registerToolPolicy } from "./tool-policy.ts"

export default Plugin.define({
    id: "ac",
    async setup(ctx) {
        // 1. Prompt first: it replaces system[0], so the memory and rules parts appended after it keep their place.
        await registerPrompt(ctx)
        await registerMemory(ctx)
        await registerRules(ctx)

        // 2. Guards and policy hooks; the run guards own a subscription that must end with the plugin.
        const stopRunGuards = await registerRunGuards(ctx)
        await registerToolPolicy(ctx)

        // 3. Fallback chains come from the bundled defaults, overridden by the `models` plugin option.
        await registerFallback(ctx, loadConfig({ options: ctx.options }))
        await registerDiagnostics(ctx)
        await registerCommands(ctx)

        return stopRunGuards
    },
})
