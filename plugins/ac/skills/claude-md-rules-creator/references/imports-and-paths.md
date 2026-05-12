# `@path` Imports, `claudeMdExcludes`, and HTML Comments

Three orthogonal mechanisms that shape what reaches the model: the `@path` import syntax for splitting content across files, the `claudeMdExcludes` setting for filtering unwanted ancestor files, and HTML comments for human-only maintainer notes. All described in this file with the runtime behavior verified against the loader.

## Contents

- `@path` import syntax
- Path resolution
- Depth limit and circular detection
- Extension allowlist
- External-import approval
- `@` inside fenced code, codespan, and comments
- Fragment identifiers (`#heading`) are stripped
- The "pitch instead of import" anti-pattern
- AGENTS.md interop via `@AGENTS.md`
- Cross-worktree pattern via `@~/.claude/<project>-instructions.md`
- `claudeMdExcludes` for monorepos
- Symlink resolution in excludes
- HTML comments: what survives, what is stripped

## `@path` import syntax

The loader scans memory files for `@path` references and recursively expands them. The regex is:

```
/(?:^|\s)@((?:[^\s\\]|\\ )+)/g
```

That is: an `@` preceded by start-of-line or whitespace, followed by a path that can include escaped spaces (`\ `). The match captures the path token.

Four accepted forms:

| Form | Example | Resolves relative to |
|------|---------|----------------------|
| `@./relative/path` | `@./docs/architecture.md` | Directory containing the importing file |
| `@~/home/path` | `@~/.claude/personal.md` | Home directory (`$HOME`) |
| `@/absolute/path` | `@/etc/shared/standards.md` | Filesystem root |
| `@path` (bare) | `@AGENTS.md` | Same as `@./path`: directory containing the importing file |

The loader rejects forms that look like email addresses (`@example.com`), special-character chains (`@#%^`), or paths starting with non-alphanumeric characters that are not one of `./`, `~/`, `/`.

## Path resolution

Path resolution uses `dirname(basePath)` where `basePath` is the importing file. So:

- `<project>/CLAUDE.md` with `@./docs/api.md` resolves to `<project>/docs/api.md`.
- `<project>/.claude/CLAUDE.md` with `@./docs/api.md` resolves to `<project>/.claude/docs/api.md`. Relative imports are relative to the IMPORTING file, not the project root. Easy to get wrong; double-check.
- `@~/.claude/foo.md` always resolves to `<home>/.claude/foo.md` regardless of which file imported it.
- `@/etc/foo.md` always resolves to `/etc/foo.md`.

When an imported file imports another, the same rules apply: `<file>'s @paths resolve relative to <file>'s directory`.

## Depth limit and circular detection

`MAX_INCLUDE_DEPTH = 5`. Imports recurse up to 5 hops deep. Files at depth 6 are silently skipped.

The loader tracks already-processed files in a Set. If a circular import is detected, the cycle is broken; the loader does not infinite-loop. Symlinks are also tracked via `resolvedPath` so that `<A> -> symlink -> <B> -> @<A>` is caught.

Practical implication: keep import graphs shallow. A two-level structure (CLAUDE.md imports topic file, topic file does NOT import further) is the sweet spot. Five-level chains are technically supported but a maintenance smell.

## Extension allowlist

Per `TEXT_FILE_EXTENSIONS`, only ~70 text extensions are allowed for imports:

- Markdown and text: `.md`, `.txt`, `.text`
- Data: `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`
- Web: `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`
- JavaScript/TypeScript: `.js`, `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`
- Python: `.py`, `.pyi`, `.pyw`
- Ruby: `.rb`, `.erb`, `.rake`
- Go: `.go`. Rust: `.rs`. Java/Kotlin/Scala: `.java`, `.kt`, `.kts`, `.scala`. C/C++: `.c`, `.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`, `.hxx`. C#: `.cs`. Swift: `.swift`.
- Shell: `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat`, `.cmd`
- Config: `.env`, `.ini`, `.cfg`, `.conf`, `.config`, `.properties`
- Database: `.sql`, `.graphql`, `.gql`
- Frontend frameworks: `.vue`, `.svelte`, `.astro`
- Many more (see source)

Binary files (`.png`, `.jpg`, `.pdf`, `.zip`, etc.) are silently skipped. The intent: prevent accidentally loading image bytes into the model's context.

If you import a file without a recognized extension (e.g., `@./LICENSE`), the loader skips it. To import a license, rename the import target to `LICENSE.md` or `LICENSE.txt`.

## External-import approval

For external paths (outside the project's cwd), imports are treated specially:

- For User memory (`~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`), external imports are ALWAYS allowed.
- For Project, Local, and Managed memory, external imports require an approval flag to be true in the project config. The first time the runtime sees an external import in a project, it shows an approval dialog. If the user approves, the flag flips and external imports flow. If the user declines, the dialog never appears again for that project, and external imports stay blocked.

Practical implication: `./CLAUDE.md` with `@~/.claude/personal.md` triggers the approval dialog on first encounter. Each developer on the team approves their own. If you want zero-friction sharing, keep imports within the project tree.

## `@` inside fenced code, codespan, and comments

The `@path` regex runs against pre-lexed Markdown tokens. Tokens of type `code` or `codespan` are SKIPPED:

````markdown
For details, see the link below.

```python
# This @./not-an-import is in a code block, no expansion
@./also-not-an-import
```

Use `@./docs/foo.md` (inline code: NOT expanded).

Plain text: see @./docs/foo.md (IS expanded).
````

HTML comment tokens (block-level) are also skipped, but the loader runs the regex on the residue AFTER stripping the comment span. So:

```markdown
<!-- note: see @./private-notes.md --> @./public-docs.md
```

The first `@` is inside the comment (skipped). The second `@` is in the residue after the comment closes (expanded).

This token-aware parsing means you can safely document `@path` syntax inside code fences without accidentally triggering imports.

## Fragment identifiers are stripped

The import path has any `#fragment` stripped before resolution:

```markdown
See @./docs/api.md#authentication
```

Resolves to `./docs/api.md` (the entire file). Fragment identifiers do not select a section; they are stripped silently. To load only a section, split the source file into smaller files and import the relevant one.

## The "pitch instead of import" anti-pattern

Imports load the entire imported file into context at session start. A 500-line imported via `@docs/architecture.md` costs 500 lines of context EVERY session, whether Claude needs it or not.

For docs Claude needs only sometimes, a "pitch" is dramatically cheaper. Tell Claude WHEN to read it:

```markdown
## References

- For auth flows or Stripe errors, read `docs/stripe-guide.md`.
- For database migrations, read `docs/migration-guide.md`.
- For deployment, read `docs/deploy.md`.
```

Claude uses the Read tool on demand. Cost: ~5 lines in CLAUDE.md plus the one-time read when the topic comes up. Compared to `@docs/stripe-guide.md` which loads the entire file at every session start, the savings are huge across many sessions.

Use imports when:
- The imported content applies to EVERY session (e.g., `@AGENTS.md` to share with other AI tools; `@README.md` to give Claude the project overview).
- The content changes faster than CLAUDE.md and you want the source-of-truth file inlined.
- The imported file is short (10 to 30 lines) and high-value.

Use pitches when:
- The imported content is long (over 100 lines).
- The content is only sometimes relevant (deployment guide, debugging playbook, specific API guide).
- Claude can find it on demand via the file system.

HumanLayer's "Writing a Good CLAUDE.md" makes this distinction the central point. Anthropic's docs allow both but recommend imports for content "needed every session".

## AGENTS.md interop via `@AGENTS.md`

the canonical pattern for sharing instructions with other AI tools:

```markdown
# CLAUDE.md
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

`AGENTS.md` is read by Cursor, Windsurf, Cline, and others. Adding `@AGENTS.md` to CLAUDE.md gives Claude Code the same context. The "## Claude Code" section below the import adds Claude-specific overlay without forking the shared content.

Alternative (Linux/macOS only, when no Claude-specific overlay is needed):

```bash
ln -s AGENTS.md CLAUDE.md
```

The symlink is followed by the loader. Use the import pattern when you need Claude-specific additions; use the symlink when AGENTS.md is sufficient.

## Cross-worktree pattern via `@~/.claude/<project>-instructions.md`

`CLAUDE.local.md` is gitignored, so it only exists in the worktree where you created it. If you have multiple worktrees of the same repo (e.g., `~/repo`, `~/repo-feature-A/`, `~/repo-feature-B/`), each needs its own copy.

The portable pattern:

```markdown
#./CLAUDE.local.md (one-line stub in every worktree)

@~/.claude/<project-name>-instructions.md
```

Put the actual content in `~/.claude/<project-name>-instructions.md`. Each worktree's `CLAUDE.local.md` is a one-line stub that imports the home-directory file. Updates to the home file propagate across all worktrees immediately.

This is also useful for dotfiles sync: each machine you log into picks up your `~/.claude/` files via your dotfiles repo, and the worktree stubs work everywhere.

## `claudeMdExcludes` for monorepos

When walking from cwd up to filesystem root, the loader picks up CLAUDE.md from every ancestor. In a monorepo, an unrelated team's CLAUDE.md may load and pollute your context.

The `claudeMdExcludes` setting filters User / Project / Local files. :

```json
{
 "claudeMdExcludes": [
 "**/monorepo/CLAUDE.md",
 "/home/user/monorepo/other-team/.claude/rules/**"
 ]
}
```

- Glob patterns. Matched against absolute file paths.
- Apply to User / Project / Local types ONLY. Managed CLAUDE.md cannot be excluded. AutoMem and TeamMem are separate path; not excluded by this setting.
- Configurable at any settings layer (user / project / local / managed). Arrays merge across layers.
- Add to `.claude/settings.local.json` to keep the exclusion local to your machine.

## Symlink resolution in excludes

the loader resolves symlinks in absolute path prefixes. This matters on macOS where `/tmp` is a symlink to `/private/tmp`:

- A pattern like `/tmp/foo/CLAUDE.md` is expanded to BOTH `/tmp/foo/CLAUDE.md` and `/private/tmp/foo/CLAUDE.md`.
- A glob like `/tmp/*/CLAUDE.md` is expanded similarly (the static prefix before `*` is resolved).

This ensures both the user-written pattern AND the realpath-resolved system path match. Without this, the user writes `/tmp/.` in the exclude, but the runtime sees the file at `/private/tmp/.` and the pattern misses.

Relative patterns (no leading `/`, like `**/*.md`) do not have a filesystem prefix to resolve and are used as-is.

## HTML comments: what survives, what is stripped

The loader strips block-level `<!-- ... -->` from content before injection. Rules:

**Block-level (stripped):**

```markdown
<!-- Maintainer note: keep this section under 30 lines. -->

## Testing

- Run `pnpm test` before committing.
```

The comment is on its own line(s), parsed as a CommonMark type-2 HTML block. Stripped before injection. Use for: maintainer notes, "TODO: revisit this rule next quarter", "@author: alice 2026-03-01".

**Inside fenced code blocks (preserved):**

````markdown
```typescript
// This <!-- comment --> is INSIDE a code block, preserved as literal code.
```
````

The lexer recognizes the fence; the comment is part of code content.

**Inline inside a paragraph (preserved):**

```markdown
Use `pnpm` <!-- not npm --> when installing.
```

The comment is inline HTML within paragraph text, not a block. Preserved.

**Unclosed `<!--` (preserved):**

A `<!--` with no matching `-->` is left intact rather than swallowing the rest of the file. This is a deliberate safety: a typo cannot silently delete content.

**Residue after the comment closes (preserved):**

```markdown
<!-- note --> Use `pnpm`, not npm.
```

Per CommonMark, an HTML block ends at the line containing `-->`. The runtime strips the comment span but keeps any non-empty residue on the same line. So `Use \`pnpm\`, not npm.` survives.

When you open a CLAUDE.md with the Read tool, comments remain visible. They are stripped only when the runtime injects the content. The file-state cache marks the entry `contentDiffersFromDisk` to track this.

Use cases for HTML comments in CLAUDE.md and rules:

- Maintainer notes that should not consume model attention: `<!-- Last reviewed 2026-04: rules still apply -->`
- TODOs for future maintainers: `<!-- TODO: split this section once the api/v2 work lands -->`
- Disabled rules temporarily: `<!-- Temporarily disabled: was causing false positives on TypeScript inference -->`
- Citation or attribution: `<!-- Based on the HumanLayer CLAUDE.md, MIT licensed -->`

Avoid `<!--` for active documentation; if a future maintainer needs to see it, comments are not the right place (use the file's git history).
