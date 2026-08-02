import { Command } from "commander";
import { runMcpProxy } from "./mcp.ts";
import { scaffoldPlan } from "./plan-scaffold.ts";
import { runReviewCounters } from "./review-counters.ts";

const program = new Command();

program
    .name("ac")
    .description("ac CLI. Companion runtime for the ac Claude Code plugin.")
    .version("0.9.0");

program
    .command("mcp")
    .description("Run the ac stdio MCP server (proxies tools to kodizm).")
    .option(
        "--url <value>",
        "Override the kodizm MCP endpoint (defaults to https://mcp.kodizm.com; "
            + "use http://127.0.0.1:<port>/mcp/kodizm for local dev).",
    )
    .option(
        "--token <value>",
        "Override the kdz- bearer token (also reads KODIZM_MCP_TOKEN).",
    )
    .action(async (opts: { token?: string; url?: string }): Promise<void> => {
        await runMcpProxy(
            {
                token: opts.token,
                url: opts.url,
            },
        );
    });

program
    .command("review-counters <log>")
    .description(
        "Print the review-loop counters derived from an append-only log: "
            + "ITER=<n> PREV=<v> GATE=<OK|MAX_ITER> NEW=<count>.",
    )
    .option(
        "--run-prefix <value>",
        "Heading that scopes counters to one run (for example '## Run ').",
        "## Run ",
    )
    .option(
        "--iter-prefix <value>",
        "Heading that marks one logged pass (for example '## Phase 3d Iteration').",
        "## Phase 3d Iteration",
    )
    .option("--cap <value>", "Iteration cap; GATE reads MAX_ITER once ITER exceeds it.", "3")
    .action(
        (
            log: string,
            opts: { cap: string; iterPrefix: string; runPrefix: string },
        ): void => {
            const cap = Number.parseInt(opts.cap, 10);
            process.stdout.write(
                runReviewCounters(log, {
                    cap: Number.isNaN(cap) ? 3 : cap,
                    iterPrefix: opts.iterPrefix,
                    runPrefix: opts.runPrefix,
                }) + "\n",
            );
        },
    );

program
    .command("plan-scaffold <slug>")
    .description(
        "Create .ac/plans/<slug>/ with research/ and evidence/, and write a plan.md skeleton "
            + "carrying the template's sections in order. Leaves an existing plan.md untouched.",
    )
    .option("--dir <value>", "Project root to scaffold under.", process.cwd())
    .action((slug: string, opts: { dir: string }): void => {
        const result = scaffoldPlan(slug, { dir: opts.dir });
        const state = result.created ? "created" : "exists, left untouched";
        process.stdout.write(`${result.planPath} (${state})\n`);
    });

await program.parseAsync(process.argv);
