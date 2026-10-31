import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the cost shape of the skills in plugins/ac/skills. The listing entry (description plus
// when_to_use) is paid in every session, and after a compaction only the first ~5,000 tokens of an
// invoked skill survive, so the standing rules must close inside that window. A pointer into a
// bundled file that no longer exists sends the model to a path that is not there.
const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac", "skills");

const LISTING_MAX_CHARS = 320;
const COMPACTION_WINDOW_BYTES = 20_000;

interface Skill {
    name: string;
    dir: string;
    text: string;
    description: string;
    whenToUse: string;
}

function field(frontmatter: string, key: string): string {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return match?.[1]?.replace(/^"|"$/g, "") ?? "";
}

function loadSkills(): Skill[] {
    return readdirSync(SKILLS)
        .filter((name) => existsSync(join(SKILLS, name, "SKILL.md")))
        .map((name) => {
            const dir = join(SKILLS, name);
            const text = readFileSync(join(dir, "SKILL.md"), "utf8");
            const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
            return {
                name,
                dir,
                text,
                description: field(frontmatter, "description"),
                whenToUse: field(frontmatter, "when_to_use"),
            };
        });
}

const ALL = loadSkills();

test("every skill has a description and a short listing entry", () => {
    expect(ALL.length).toBeGreaterThan(0);
    for (const skill of ALL) {
        expect(skill.description, `${skill.name} has no description`).not.toBe("");
        const listing = skill.description.length + skill.whenToUse.length;
        expect(listing, `${skill.name} listing entry is ${listing} characters`).toBeLessThanOrEqual(LISTING_MAX_CHARS);
    }
});

test("every bundled-file pointer in a SKILL.md resolves", () => {
    for (const skill of ALL) {
        const pointers = [...skill.text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([A-Za-z0-9_./-]+)/g)].map((m) =>
            (m[1] ?? "").replace(/[.,]+$/, ""),
        );
        for (const pointer of pointers) {
            expect(existsSync(join(skill.dir, pointer)), `${skill.name}: ${pointer} does not exist`).toBe(true);
        }
    }
});

test("a Standing rules block closes inside the compaction window", () => {
    for (const skill of ALL) {
        const start = skill.text.indexOf("\n## Standing rules");
        if (start === -1) continue;
        const next = skill.text.indexOf("\n## ", start + 1);
        const end = next === -1 ? skill.text.length : next;
        const bytes = Buffer.byteLength(skill.text.slice(0, end));
        expect(bytes, `${skill.name}: Standing rules end at byte ${bytes}`).toBeLessThanOrEqual(COMPACTION_WINDOW_BYTES);
    }
});

test("no skill body carries an em-dash or an en-dash", () => {
    for (const skill of ALL) {
        expect(/[—–]/.test(skill.text), `${skill.name} contains a dash`).toBe(false);
    }
});
