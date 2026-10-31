# Project settings that pay for themselves

A CLAUDE.md line asking for behavior is a request; a settings key holds. This is the menu `/ac:init-project` draws from, and the test for "should this rule be a setting?" when writing files by hand. Checked against Claude Code 2.1.314 on 2026-10-30 (settings reference, permissions, hooks, large-codebases, permission-modes, changelog). Settings files reload on save, including a project `.claude/` folder created mid-session (settings docs, "When edits take effect"), and `claude doctor` lists any entry Claude Code rejected.

## Contents

- Which file
- The menu
- Allow-rule forms
- Never from a setup command
- Hook limits
- Unverified

## Which file

| File | Put there | Why |
|---|---|---|
| `.claude/settings.json` (shared, committed) | `deny` and `ask` rules | They apply at once for every teammate, with no trust step. |
| `.claude/settings.local.json` (personal, gitignored) | `allow` rules, the hook, the language server, `claudeMdExcludes`, worktree keys | Its `allow` rules skip the trust step while the file stays untracked. A hook there runs only on your machine. Each developer needs their own server binary. |

In the shared file, `allow` rules, hooks and most `env` values wait until each teammate accepts the workspace trust dialog (an interactive session holds hooks back from every settings file until then; a `-p` run treats the folder as trusted for hooks but never uses the shared file's `allow` rules). Claude Code adds `settings.local.json` to your global git excludes only when it writes the file itself, so add the `.gitignore` line when you create it by hand.

## The menu

On every project:

- `permissions.deny` `Read` rules for secret-shaped files (shared). Zero cost. They stop the file tools and `cat`-style reads, not `grep -r` or a script; only the sandbox seals.
- `permissions.allow` for the manifest's own non-destructive scripts (local), in the forms below.

When a named signal is found:

| Key | File | Signal | Note |
|---|---|---|---|
| `permissions.deny` `Read` on generated or vendored trees | shared | Tracked `vendor/`, `dist/`, `*.generated.*` | Keeps bulk out of context. See large-codebases, "block reads of generated and vendored code". |
| `permissions.deny` `Edit` on off-limits paths | shared | The interview's off-limits answer | The file tools refuse, which a CLAUDE.md line cannot do. It also blocks creating files there; `NotebookEdit` is not covered. |
| `permissions.ask` `Bash(git push *)` | shared | A stated push or PR rule | `git -C . push` is not matched. |
| `hooks.PostToolUse` | local | Formatter or linter installed on disk | `${CLAUDE_SKILL_DIR}/references/hook-wiring.md`. Shared only when CI, husky or lint-staged already runs the same tool. |
| `enabledPlugins` language server | local, or shared when the team wants it | Extension plus a server binary on PATH | `${CLAUDE_SKILL_DIR}/references/lsp-wiring.md`. No servers start in cloud sessions. Cuts file reads. |
| `worktree.symlinkDirectories` | local | Several `git worktree list` rows and a `node_modules` | Saves disk, not tokens. Branches then share dependencies. |
| `claudeMdExcludes` | local | A monorepo with several unrelated nested CLAUDE.md files and a user who names their area | Hides rules from that session. |

## Allow-rule forms

Write the space form with `*` after the subcommand, `Bash(pnpm test *)`. Never a bare program (`Bash(npm *)`), which also covers install and publish, and never a runner wildcard (`npm run *`, `pnpm run *`, `python *`, `npx *`, `bash *`): auto mode drops those runner forms (permission-modes docs; the matcher list was read in the 2.1.314 binary). A specific script such as `Bash(pnpm run lint *)` survives. Nothing that deploys, migrates, pushes or deletes.

## Never from a setup command

- A person's choice: `model`, `modelSettings`, `effortLevel`, `fallbackModel`, `fastMode`, `advisorModel` (a project value overrides each person's `/model` and `/effort`); `env`; `sandbox.*`; `permissions.defaultMode` (`auto` and `bypassPermissions` are ignored in project and local files since 2.1.257); `attribution`; `autoMemoryEnabled`, `autoCompactWindow`, `cleanupPeriodDays` and the other cost trade-offs; UI keys such as `statusLine` and `outputStyle`.
- Runs repository-supplied code or widens the supply chain: `extraKnownMarketplaces`, `apiKeyHelper` and the other auth helpers, `disableAllHooks`, `disableSkillShellExecution`, `autoMemoryDirectory` from a project file.
- Ignored in a repository file: `modelPicker`, `autoMode`, `skipAutoPermissionPrompt`, `useAutoModeDuringPlan`, `pluginConfigs`, managed-only keys. Each entry's Scope line in the settings reference says so.
- No gain: `alwaysThinkingEnabled` (no effect on Opus 5.5 or Sonnet 5.5), `includeGitInstructions` (the saving is unmeasured), the skill-listing budget keys.
- MCP server configuration is out of scope for a setup command.

## Hook limits

- `PostToolUse` cannot block: exit 2 shows stderr to Claude after the write landed. Report a lint failure through `additionalContext` on exit 0.
- It cannot gate `git commit`. A `PreToolUse` hook filtering `Bash(git commit *)` can exit 2, but the filter is best-effort and `git -C . commit` or `sh -c` slips past. The hard gate is git's own pre-commit hook.
- Hooks run synchronously and the default timeout is 600 seconds, so register 30 to 60. `async: true` cannot block and `-p` kills it at teardown.
- A `Bash` write is not seen by an `Edit|Write` matcher.

## Unverified

Whether a shared-file `enabledPlugins` entry waits for the trust dialog (the plugin docs disagree), whether `onFailure: "block"` works on `PostToolUse` (2.1.295), whether `if: "Edit(*.ts)"` also matches `Write`, the race between an async formatter and the next edit, and whether a gitignored hook script exists in a fresh worktree. The live-fire and `hover` proofs in the two wiring references settle the first and last for a given project.
