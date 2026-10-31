import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR: string = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT: string = join(SCRIPT_DIR, "..", "..");
const OUT_DIR: string = join(REPO_ROOT, "plugins", "ac", "cli");
const OUT_FILE: string = join(OUT_DIR, "ac.js");
const OUT_MANIFEST: string = join(OUT_DIR, "package.json");
const ENTRY: string = join(SCRIPT_DIR, "src", "index.ts");
const SHEBANG: string = "#!/usr/bin/env node\n";
const PROXY_OUT_DIR: string = join(REPO_ROOT, "plugins", "ac-lsp", "bin");
const PROXY_OUT_FILE: string = join(PROXY_OUT_DIR, "lsp-proxy.js");
const PROXY_OUT_MANIFEST: string = join(PROXY_OUT_DIR, "package.json");
const PROXY_ENTRY: string = join(SCRIPT_DIR, "src", "lsp-proxy-main.ts");

/**
 * Emitted beside the bundle so Node reads `ac.js` as ESM on every version.
 *
 * Without it, a `.js` file holding `import` statements is parsed as CommonJS and throws
 * "Cannot use import statement outside a module". Node only guesses the module type for us from
 * 20.19.0 and 22.7.0 onward, where syntax detection is unflagged by default; on 18.x it never
 * happens, and on 20.0 to 20.18 and 22.0 to 22.6 it does not either. The MCP server this bundle
 * serves therefore died on any older runtime while working on the author's machine, which is the
 * worst shape a bug can take.
 *
 * `type: module` is the explicit form and costs nothing. It also removes the dependency on a
 * heuristic that a future Node could change.
 */
const OUT_MANIFEST_BODY: string = `${JSON.stringify({ type: "module" }, null, 4)}\n`;

await rm(OUT_DIR, {
    recursive: true,
    force: true,
});

await mkdir(OUT_DIR, {
    recursive: true,
});

const result = await Bun.build({
    entrypoints: [
        ENTRY,
    ],
    outdir: OUT_DIR,
    naming: {
        entry: "ac.js",
    },
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
});

if (!result.success) {
    for (const log of result.logs) {
        console.error(log);
    }
    process.exit(1);
}

const bundled: string = await readFile(OUT_FILE, "utf8");

await writeFile(OUT_FILE, `${SHEBANG}${bundled}`);
await chmod(OUT_FILE, 0o755);
await writeFile(OUT_MANIFEST, OUT_MANIFEST_BODY);

console.log(`Built ${OUT_FILE}`);
console.log(`Wrote ${OUT_MANIFEST}`);

// The ac-lsp plugin ships its own copy of the LSP proxy: a plugin cannot reach into another plugin's
// directory at runtime, and the proxy needs nothing the ac bundle carries.
await rm(PROXY_OUT_DIR, {
    recursive: true,
    force: true,
});

await mkdir(PROXY_OUT_DIR, {
    recursive: true,
});

const proxyResult = await Bun.build({
    entrypoints: [
        PROXY_ENTRY,
    ],
    outdir: PROXY_OUT_DIR,
    naming: {
        entry: "lsp-proxy.js",
    },
    target: "node",
    format: "esm",
    minify: false,
});

if (!proxyResult.success) {
    for (const log of proxyResult.logs) {
        console.error(log);
    }
    process.exit(1);
}

const proxyBundled: string = await readFile(PROXY_OUT_FILE, "utf8");

await writeFile(PROXY_OUT_FILE, `${SHEBANG}${proxyBundled}`);
await chmod(PROXY_OUT_FILE, 0o755);
await writeFile(PROXY_OUT_MANIFEST, OUT_MANIFEST_BODY);

console.log(`Built ${PROXY_OUT_FILE}`);
console.log(`Wrote ${PROXY_OUT_MANIFEST}`);
