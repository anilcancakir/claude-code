import { Command } from "commander";
import { runMcpProxy } from "./mcp.ts";
import { runReviewCounters } from "./review-counters.ts";

const program = new Command();

program
    .name("ac")
    .description("ac CLI. Companion runtime for the ac Claude Code plugin.")
    .version("0.8.0");

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

await program.parseAsync(process.argv);
