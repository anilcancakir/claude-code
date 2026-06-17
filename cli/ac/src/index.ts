import { Command } from "commander";
import { runMcpProxy } from "./mcp.ts";

const program = new Command();

program
    .name("ac")
    .description("ac CLI. Companion runtime for the ac Claude Code plugin.")
    .version("0.4.2");

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

await program.parseAsync(process.argv);
