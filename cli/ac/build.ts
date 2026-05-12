import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR: string = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT: string = join(SCRIPT_DIR, "..", "..");
const OUT_DIR: string = join(REPO_ROOT, "plugins", "ac", "cli");
const OUT_FILE: string = join(OUT_DIR, "ac.js");
const ENTRY: string = join(SCRIPT_DIR, "src", "index.ts");
const SHEBANG: string = "#!/usr/bin/env node\n";

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

console.log(`Built ${OUT_FILE}`);
