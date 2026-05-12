# The Four Scopes (and One Memdir)

Where CLAUDE.md and rules live, who sees each, when each loads, and how to avoid the most common scope-leak mistakes.

## Contents

- Scope summary table
- Managed policy
- User global (`~/.claude/`)
- Project team (`./` and `./.claude/`)
- Project personal (`./CLAUDE.local.md`)
- Auto memory (`~/.claude/projects/<project>/memory/`)
- AGENTS.md interop
- Worktree handling
- Monorepo handling (`claudeMdExcludes`, `--add-dir`)
- `--bare` mode and the SDK
- Scope-leak audit checklist

## Scope summary table

| Scope | CLAUDE.md path | Rules path | Audience | Versioned? |
|-------|----------------|------------|----------|------------|
| Managed policy | platform-specific (see below) | `<managed>/.claude/rules/` | Every user on the machine; cannot be excluded by user settings | Org-deployed |
| User global | `~/.claude/CLAUDE.md` | `~/.claude/rules/` (NO nested `.claude/`) | Just you, every project on this machine | Personal dotfiles |
| Project team | `<dir>/CLAUDE.md` and `<dir>/.claude/CLAUDE.md` | `<dir>/.claude/rules/` (recursive) | Everyone on this repo | Yes, commit to git |
| Project personal | `<dir>/CLAUDE.local.md` | (no separate rules layer; share via `~/.claude/rules/` or inline in `CLAUDE.local.md`) | Just you, this project | No, add to `.gitignore` |
| Auto memory | n/a (machine-only) | n/a | Just you, per project. Written by Claude | No |

The runtime treats CLAUDE.md content identically regardless of scope. The scopes differ in WHO sees the file and WHEN each gets loaded relative to others.

## Managed policy

Platform paths:

- macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`
- Linux and WSL: `/etc/claude-code/CLAUDE.md`
- Windows: `C:\Program Files\ClaudeCode\CLAUDE.md`

Managed rules dir: `<managed-policy>/.claude/rules/`.

Properties:

- Loaded ALWAYS, regardless of user settings, regardless of `--bare`, regardless of `--setting-sources`.
- Cannot be filtered by `claudeMdExcludes` (those patterns are ignored for `Managed` type).
- Distributed via MDM, Group Policy, Ansible, or other config-management tools. The runtime does NOT install or update this file; the org does.
- Use for compliance and security: data-handling rules ("never log PII", "never paste tokens into prompts"), security policies, org-wide coding standards that must apply across every project, every user.

Anthropic's split between managed CLAUDE.md and managed settings:

| Concern | Configure in |
|---------|--------------|
| Block specific tools, commands, or file paths | Managed settings: `permissions.deny` |
| Enforce sandbox isolation | Managed settings: `sandbox.enabled` |
| Environment variables, API provider routing | Managed settings: `env` |
| Authentication method, organization lock | Managed settings: `forceLoginMethod`, `forceLoginOrgUUID` |
| Code style and quality guidelines | Managed CLAUDE.md |
| Data handling and compliance reminders | Managed CLAUDE.md |
| Behavioral instructions for Claude | Managed CLAUDE.md |

Settings rules are enforced by the client regardless of model decisions. CLAUDE.md shapes behavior; it is not a hard enforcement layer.

## User global

Paths:

- `~/.claude/CLAUDE.md`
- `~/.claude/rules/` (NOT `~/.claude/.claude/rules/` - the user rules dir is one level shallower than project rules)

Properties:

- Loaded ALWAYS unless `--setting-sources` omits `userSettings`.
- Personal across all projects on this machine. Your dotfiles.
- External `@imports` are always allowed from user memory (the `includeExternal` flag is hard-coded `true` for User memory).
- Use for: communication style ("be terse"), personal coding preferences ("always run tests after changes"), package-manager preference ("use `pnpm`, not `npm`"), default editor / shell, your role context if you want Claude to calibrate explanations.

Common scope leak: putting team-shared rules into `~/.claude/CLAUDE.md`. Teammates do not see it; you alone follow the rule; "consistency" breaks subtly. If teammates need it, it belongs in project-team scope.

## Project team

Paths (loaded per directory in the walk from filesystem root down to cwd):

- `<dir>/CLAUDE.md`
- `<dir>/.claude/CLAUDE.md`
- `<dir>/.claude/rules/` (recursive into subdirs)

Properties:

- Loaded ALWAYS unless `--setting-sources` omits `projectSettings`.
- Commit to git so the team shares the same context.
- Project-root CLAUDE.md survives compaction (re-read from disk). Subdirectory CLAUDE.md does not (it lazy-loads via attachments).
- Use for: stack, build/test commands, code conventions that differ from language defaults, off-limits paths, repo etiquette, architectural decisions, non-obvious gotchas.

The canonical preface (written by `/init` and used by convention):

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

This is a convention, not a runtime requirement. The `/init` command writes it, and it tells human readers what the file is at a glance.

Subdirectory CLAUDE.md is loaded on demand when Claude reads a file in that subdirectory. Useful in monorepos: keep root CLAUDE.md lean, put `packages/web/CLAUDE.md` with frontend-specific rules, and they activate only when Claude works there.

## Project personal

Path: `<dir>/CLAUDE.local.md` (per directory in the walk).

Properties:

- Loaded ALWAYS unless `--setting-sources` omits `localSettings`.
- Gitignored by convention. The `/init` command adds `CLAUDE.local.md` to `.gitignore` when generating the file.
- Loaded LAST per directory, so it overrides team-shared CLAUDE.md at the same level on conflicts.
- Use for: your sandbox URLs ("http://localhost:8080"), preferred test accounts, your branch ("I usually work in `feature/oauth`"), test-data overrides, communication preferences scoped to this project ("be terse for this repo - the team handles their own reviews").

The gotcha that bites everyone: `CLAUDE.local.md` is gitignored, so it only exists in the working tree where you created it. If you use multiple worktrees of the same repo (e.g., `~/repo` and `~/repo-feature/`), only the worktree where you created the file has it. To share personal content across worktrees, use an `@import` from `~/.claude/`:

```markdown
# ./CLAUDE.local.md in every worktree

@~/.claude/<project-name>-instructions.md
```

Put the actual content in `~/.claude/<project-name>-instructions.md`. Each worktree's `CLAUDE.local.md` is a one-line stub that imports it. Anthropic deprecated stand-alone `CLAUDE.local.md` in favor of this pattern for cross-worktree work.

## Auto memory

Path: `~/.claude/projects/<project>/memory/`. `<project>` is derived from the git repository (so worktrees and subdirectories share one auto memory dir).

Files:

- `MEMORY.md` - first 200 lines / 25KB loaded at session start
- topic files (`debugging.md`, `patterns.md`, `api-conventions.md`) - NOT loaded at start; Claude reads them on demand

Properties:

- Written by Claude, not by you. Toggled via `/memory` or `autoMemoryEnabled` setting. Disable globally with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Machine-local. NOT shared via git. Each machine accumulates its own memory.
- Distinct from CLAUDE.md: CLAUDE.md is for the TEAM; auto memory is for YOU. When you tell Claude "remember X" or "always do Y", it usually writes to auto memory unless you say "add to CLAUDE.md".

Configure `autoMemoryDirectory` (policy / local / user settings, NOT project settings - to prevent a shared project from redirecting memory writes elsewhere).

## AGENTS.md interop

Claude Code does NOT read `AGENTS.md` natively. Two integration patterns:

**Import (Windows-friendly)**:

```markdown
# CLAUDE.md
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

The `@AGENTS.md` import loads `AGENTS.md` content into context at session start. Claude-specific additions go below. This keeps one source of truth for shared instructions and adds Claude-specific overlay where needed.

**Symlink (Linux/macOS, when AGENTS.md is sufficient)**:

```bash
ln -s AGENTS.md CLAUDE.md
```

The symlink is followed by the loader. Loops are detected (`processedPaths` Set). Use this when no Claude-specific content is needed.

## Worktree handling

Two patterns to know about, both:

**Nested worktree** (inside main checkout, e.g., `.claude/worktrees/<name>/` from `claude -w`):

When the runtime walks from cwd up to filesystem root, it passes through the worktree root AND the main repo root. Project files from the main repo (the part of the tree NOT inside the worktree) are skipped to avoid double-loading. `CLAUDE.local.md` is not skipped (it is gitignored and only exists in the main repo).

**Sibling worktree** (separate checkout, e.g., `~/repo-feature/`):

The walk runs only inside the sibling worktree. The main repo's tree is not touched. `CLAUDE.local.md` only exists in the worktree where you created it; to share personal content across siblings, use the `@~/.claude/<project>-instructions.md` import pattern described in "Project personal" above.

## Monorepo handling

**`claudeMdExcludes` setting**:

```json
{
 "claudeMdExcludes": [
 "**/monorepo/CLAUDE.md",
 "/home/user/monorepo/other-team/.claude/rules/**"
 ]
}
```

Glob-match patterns. Matches User / Project / Local. Does NOT match Managed (cannot be excluded) or AutoMem / TeamMem (separate path).

Symlinks are resolved when matching: if `/tmp` is a symlink to `/private/tmp` (macOS), the pattern `/tmp/foo/CLAUDE.md` ALSO matches the resolved `/private/tmp/foo/CLAUDE.md` because the loader walks the static prefix through `realpathSync`.

Arrays merge across settings layers (user / project / local / managed).

**`--add-dir` extra directories**:

By default, `--add-dir` adds extra directories to the working set (Claude can read files there) but does NOT load CLAUDE.md from them. Set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` to ALSO load `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, and `CLAUDE.local.md` from extra dirs. `CLAUDE.local.md` is skipped if `--setting-sources` omits `local`.

**Subdirectory CLAUDE.md scaling pattern**:

Root CLAUDE.md has universal rules. `<package>/CLAUDE.md` has package-specific rules that load only when Claude works in that package. Keep the root file lean; push domain-specific content into subdirectory files. Example layout:

```
monorepo/
├── CLAUDE.md always loaded - shared rules
├── packages/
│ ├── web/
│ │ └── CLAUDE.md loads when Claude works under packages/web/
│ ├── api/
│ │ └── CLAUDE.md loads when Claude works under packages/api/
│ └── db/
│ └──.claude/
│ └── rules/
│ └── migrations.md loads when Claude reads files matching paths:
```

Subdir CLAUDE.md does NOT survive compact (it lazy-loads). Only root CLAUDE.md and root `.claude/rules/*.md` (unconditional) survive.

## `--bare` mode and the SDK

`--bare`:

- Skips the cwd walk entirely.
- Does NOT skip Managed.
- HONORS explicit `--add-dir` only if `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is also set; otherwise no project CLAUDE.md loads.
- Useful for short scripted invocations where the default discovery is overhead.

`--setting-sources` (SDK):

- Disables a settings source entirely (e.g., `--setting-sources project,local` to drop user).
- Cascades into CLAUDE.md: disabling `userSettings` skips `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`. Disabling `projectSettings` skips all project memory. Disabling `localSettings` skips `CLAUDE.local.md`.

`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`:

- Hard off. Nothing loads, regardless of any flag or setting.
- Used by automation that needs a deterministic prompt with no project context.

## Scope-leak audit checklist

Common scope-misplacement mistakes and how to spot them:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Teammates do not follow a rule you wrote | Rule is in `~/.claude/CLAUDE.md` (user-global), should be in `./CLAUDE.md` (team) | Move it. Commit. |
| Personal sandbox URL appears in a PR diff | Personal config in `./CLAUDE.md` (team file), should be in `./CLAUDE.local.md` | Move it. Add `CLAUDE.local.md` to `.gitignore` if not already. |
| Org-wide compliance rule keeps getting removed | Compliance rule in `./CLAUDE.md` is editable per-project; should be in managed CLAUDE.md | Coordinate with admin to deploy via MDM / Group Policy. |
| Sibling worktree forgot your personal preferences | `CLAUDE.local.md` only exists in the original worktree | Move content to `~/.claude/<project>-instructions.md`; import via `@~/.claude/<project>-instructions.md` from each worktree's `CLAUDE.local.md`. |
| Monorepo loads another team's CLAUDE.md | Ancestor directory has CLAUDE.md from a different team | Add a `claudeMdExcludes` pattern in `.claude/settings.local.json`. |
| `--bare` script loads project files anyway | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set AND `--add-dir` points at the project | Unset the env var, or remove `--add-dir`. |
| User-rules dir is empty but you put files there | Wrong path: `~/.claude/.claude/rules/` instead of `~/.claude/rules/` | Move. User rules are one level shallower than project rules. |

Run `/memory` to see the truth: every file the runtime actually loaded, plus its scope label. If a file you expected is not in the list, the scope is wrong, a `--setting-sources` flag dropped it, `claudeMdExcludes` filtered it, or the path on disk does not match. Fast, definitive, and the most common debug step skipped.
