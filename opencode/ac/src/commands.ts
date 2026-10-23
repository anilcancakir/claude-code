import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition } from "@opencode/plugin/promise/command"

type Skill = "plan" | "execute" | "commit" | "qa"

/** Descriptions are the frontmatter of the CC plugin, so both hosts list the same command text. */
const COMMANDS: ReadonlyArray<{ skill: Skill; description: string }> = [
    {
        skill: "plan",
        description:
            "Plan a change interactively: research in parallel, ask the decisions only you can make, " +
            "then write a tiered plan. Writes no code.",
    },
    {
        skill: "execute",
        description:
            "Run an approved ac plan to completion, wave by wave, with cost-tiered workers, " +
            "per-wave verification and a final review.",
    },
    {
        skill: "commit",
        description:
            "Split the changes into atomic commits, preflight and push them. " +
            "Pass --skip-preflight or --no-push to skip a step.",
    },
    {
        skill: "qa",
        description:
            "Test a session's or a plan's work the way a QA engineer would: derive cases from the requirement " +
            "and the diff, run them against the live app with the project's own test tool " +
            "(playwright-cli as the fallback), fix critical and high findings, retest once, " +
            "and record learnings in .ac/qa/learnings.md.",
    },
]

/**
 * Each command only forwards the argument text and attaches its skill: the skill body carries the workflow,
 * and no `agent` is set so the session keeps the agent the user is on.
 */
export async function registerCommands(ctx: Plugin.Context): Promise<void> {
    await ctx.command.transform((editor) => {
        for (const { skill, description } of COMMANDS) {
            const definition: CommandDefinition = {
                name: `ac/${skill}`,
                description,
                execute: async ({ sessionID, prompt, delivery }) => {
                    await ctx.session.prompt({
                        ...prompt,
                        sessionID,
                        skills: [{ id: skill }],
                        delivery,
                    })
                },
            }
            editor.add(definition)
        }
    })
}
