import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

const HEADER = /^<!-- ported-from: (\S+) sha256:([0-9a-f]{64}) -->$/
const SCANNED_DIRS = ["agents", "skills", "templates"]
const PACKAGE_DIR = "opencode/ac"

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** Index of the line that carries (or will carry) the header: line 0, or the line after the closing `---`. */
function headerLine(lines: string[]): number {
    if (lines[0] !== "---") return 0
    const closing = lines.indexOf("---", 1)
    return closing === -1 ? 0 : closing + 1
}

function repoRelative(repoRoot: string, path: string): string {
    return relative(repoRoot, isAbsolute(path) ? path : resolve(repoRoot, path))
}

export function stamp(repoRoot: string, ported: string, source: string): void {
    const sourceRel = repoRelative(repoRoot, source)
    const portedPath = join(repoRoot, repoRelative(repoRoot, ported))
    const header = `<!-- ported-from: ${sourceRel} sha256:${sha256(readFileSync(join(repoRoot, sourceRel)))} -->`

    const lines = readFileSync(portedPath, "utf8").split("\n")
    const at = headerLine(lines)
    lines.splice(at, HEADER.test(lines[at] ?? "") ? 1 : 0, header)
    writeFileSync(portedPath, lines.join("\n"))
}

function* walk(dir: string): Generator<string> {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) yield* walk(path)
        else yield path
    }
}

/** One message per ported file whose recorded source hash no longer matches; header-less files are skipped. */
export function findDrift(repoRoot: string): string[] {
    const drift: string[] = []
    for (const dir of SCANNED_DIRS) {
        for (const file of walk(join(repoRoot, PACKAGE_DIR, dir))) {
            const lines = readFileSync(file, "utf8").split("\n")
            const match = HEADER.exec(lines[headerLine(lines)] ?? "")
            if (!match) continue

            const [, sourceRel, recorded] = match as unknown as [string, string, string]
            const portedRel = relative(repoRoot, file)
            const sourcePath = join(repoRoot, sourceRel)
            if (!existsSync(sourcePath)) {
                drift.push(`${portedRel}: recorded source ${sourceRel} no longer exists`)
                continue
            }
            const current = sha256(readFileSync(sourcePath))
            if (current !== recorded) {
                drift.push(`${portedRel}: source ${sourceRel} changed (recorded ${recorded}, current ${current})`)
            }
        }
    }
    return drift
}

if (import.meta.main) {
    const [command, ported, source] = process.argv.slice(2)
    if (command !== "stamp" || !ported || !source) {
        console.error("usage: bun scripts/provenance.ts stamp <ported> <repo-relative source>")
        process.exit(2)
    }
    stamp(resolve(import.meta.dir, "../../.."), ported, source)
}
