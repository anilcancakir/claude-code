import pkg from "../package.json" with { type: "json" };

/**
 * The single source of truth for the CLI and MCP server version.
 *
 * Read from `package.json` rather than typed in, because it used to be typed in: `mcp.ts` advertised
 * "0.9.1" to every MCP client while both manifests had moved to 0.11.0.
 */
export const AC_VERSION: string = pkg.version;
