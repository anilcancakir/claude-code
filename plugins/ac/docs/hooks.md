# Hooks

The `ac` plugin registers 21 hooks in `plugins/ac/hooks/hooks.json`, backed by 20 scripts under `plugins/ac/hooks/` (`session-lease-sweep.sh` is registered twice). Hooks run code on your machine, so this page lists each one: when it fires, what it does, whether it can stop something, and how to turn it off.

Two guarantees hold for every hook. Eight of the 21 registrations are gated to the situation they serve: they do nothing unless an `/ac:execute`, `/ac:auto` or `/ac:coordinate` run owned by the current session is active in the project, or the call comes from an `ac` subagent. The other 13 are registered for every session, among them the plan-mode block, the memory-file gate and the announce judge. Each also fails open: a missing tool (`jq`, `perl`, `rg`), an unreadable payload or marker, or any condition the script cannot evaluate lets the action through unchanged.

"Can block" means different things per event. A `PreToolUse` hook can deny the tool call. A `Stop` or `SubagentStop` hook can keep the turn going once. A `SessionStart` or `PostToolUse` hook cannot stop anything: the latter runs after the tool has finished and can only hand Claude an instruction.

Hook state lives under `${TMPDIR:-/tmp}` unless a row says otherwise. The run guards also write counters inside an `.ac/` directory that an `ac` run already created.

## SessionStart

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `session-start-plan-state.sh` | `startup\|resume\|compact` | A session starts, resumes or compacts | Adds context naming the open plan in `.ac/plans/` (steps checked and unchecked, next unchecked step, last five commits from `git log`) and, if this session owns a coordinator run, its slug and phase. On `compact` it also states that re-attached skill bodies keep only their first 5,000 tokens. Prints nothing when no plan or coordinator run is open | No | None |
| `session-start-working-rules.sh` | `startup\|resume\|clear\|compact` | A session starts, resumes, clears or compacts | Delivers the ac working rules (`references/working-rules.md`) as context, unless another copy already reaches the session. It always refreshes a stable copy of the rules at `~/.claude/ac/working-rules.md` first | No | `AC_WORKING_RULES=0` stops the context copy (the stable file is still refreshed); `AC_WORKING_RULES_APPENDED=1` marks a launch wrapper that appends the file itself; `AC_WORKING_RULES_DIR` moves the stable copy; `AC_GLOBAL_CLAUDE_MD` points at the global CLAUDE.md checked for an old layout |
| `session-lease-sweep.sh` | `startup` | A session starts fresh | If any lease file exists, runs `ac lease sweep --stale` detached: stops the recorded resources of sessions whose `claude` process is gone | No | None |

`session-start-working-rules.sh` decides whether another copy exists by reading the session transcript (on resume), and with `AC_WORKING_RULES_APPENDED=1` by reading the arguments of its parent `claude` process through `ps`.

## UserPromptSubmit

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `userpromptsubmit-session-title.sh` | none | You submit a prompt | Off unless `AC_SESSION_TITLE=1`. Then, on your first typed prompt and every tenth, starts a detached generator that asks a `claude -p` call on Haiku for a 2 to 4 word kebab-case name, and applies it as the session title on your next prompt. Stops for good in a session where you set a title yourself | No | `AC_SESSION_TITLE=1` turns it on; `AC_SESSION_TITLE_EVERY` (default 10), `AC_SESSION_TITLE_MODEL` (default `haiku`), `AC_SESSION_TITLE_PROMPT` (your own naming prompt file; else `~/.claude/ac/session-title.md` if present), `AC_SESSION_TITLE_PATTERN` (jq regex a title must match) |

## PreToolUse

A `PreToolUse` hook that denies prints a reason that Claude reads, then rewrites or stops; none raises a permission prompt. Only `pretooluse-plan-mode-block.sh` uses exit code 2; the others deny through a JSON decision.

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `pretooluse-file-scope.sh` | `Edit\|Write\|MultiEdit` | A subagent edits a file during an `/ac:execute` run this session owns (marker under 24 hours old, live pid) | Denies an edit to a path outside the active wave's declared files. Paths under `.ac/`, the main thread and `ac:lane` are exempt; an empty file set allows | Yes | None |
| `pretooluse-plan-mode-block.sh` | `EnterPlanMode\|ExitPlanMode` | Claude calls either plan-mode tool, in any session with the plugin | Denies it unconditionally with a message pointing at the `ac:flow` skill (or `/ac:plan` for a written plan) | Yes | None |
| `pretooluse-bash-guard.sh` | `Bash\|AskUserQuestion` | While this session owns the `/ac:auto` away marker `.ac/state/active-auto.json` | Denies `AskUserQuestion` (marker under 24 hours old, 72 hours over a coordinator run) so the run takes the recommended option and logs it. Denies Bash that is irreversible (force push, push that deletes refs, `git reset --hard`, `git clean` without a dry run, whole-tree `git checkout .` or `git restore .`, `rm -rf`, `sed -i`, `perl -i`). Denies `git push`, `gh pr create`, `gh pr merge` and `gh release create\|delete\|edit\|upload` unless the marker's `allowed_outward` names them. The main thread is not exempt | Yes | None; delete the marker to end an away run |
| `pretooluse-explore-budget.sh` | `Read\|Bash\|Grep\|Glob\|LSP` | Inside an `ac:explore` subagent | Denies reading a secret-shaped file (`.env`, `*.pem`, `*.key`, `id_rsa`, `credentials*.json` and similar; templates such as `.env.example` pass), denies Bash that writes (formatters in write mode, installs, file changes, git changes), and denies every call after the 60th. Counter in `${TMPDIR:-/tmp}/ac-agent-budget/`, one file per spawn | Yes | `AC_EXPLORE_MAX_CALLS` (default 60); no switch for the read-only checks |
| `pretooluse-subagent-bash-guard.sh` | `Bash` | Inside any `ac` subagent; the shell-replace rule also on the main thread and in `general-purpose` | Denies `find`, recursive `grep`, `rg` or `fd` rooted at `/` or your home directory (unless limited to two levels), a recursive search over `~/.claude/projects`, `strings` or text-mode `grep` on a file over 100 MiB, and recursive `grep` from a repository root. Each denial names a bounded alternative. For the four plan workers, `general-purpose` and the main thread it also denies a small shell replace (`sed`, `gsed`, `perl`, python) (`sed -i` or `perl -i` on one file, or an inline python script that calls `.replace(` and writes up to three times) and points at the Edit tool, once per command: the identical command sent again in the same session runs, and a command that starts with `find`, `xargs` or a loop, or walks a directory, marks a rewrite across many files and passes. Markers in `${TMPDIR:-/tmp}/ac-bash-edit-guard/` | Yes | `AC_BASH_EDIT_GUARD=0` turns off the shell replace rule only; the search denials have no switch |
| `pretooluse-shell-syntax-guard.sh` | `Bash` | Every session, every Bash call | Denies zsh-only expansions that Claude Code's bash parser cannot read (`${(flags)name}`, subscript flags, nested `${${...}}`, a subshell closed directly against `$(...)`), because they raise a safety prompt that bypass mode does not skip. Names the bash rewrite | Yes | None |
| `pretooluse-memory-file-gate.sh` | `Write\|Edit\|MultiEdit` | Every session and subagent, on a write to `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/rules/*.md`, `PROJECT.md` or `DESIGN.md` | Denies the write until the transcript shows the matching writer skill (`ac:claude-md-rules-creator`, `ac:project-md-writer` or `ac:design-md-writer`) was loaded, and names the skill. Auto-memory, `node_modules`, `vendor`, `references/`, installed plugins and the plugin's own skill templates pass | Yes | `AC_MEMORY_FILE_GATE=0` |

`pretooluse-bash-guard.sh` reads commands lexically (split at separators, quotes dropped, verb matched at the command position). A verb reached through `eval`, an alias or a variable is not seen.

## PostToolUse

All four fire after the write or answer has happened, so none can undo it.

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `posttooluse-memory-index-budget.sh` | `Write\|Edit\|MultiEdit` | A write leaves an auto-memory index (`.../projects/<project>/memory/MEMORY.md`) over budget, or grows a topic note (`.../projects/<project>/memory/<name>.md`) past its ceiling | Tells Claude to consolidate the index into shorter pointers and themed sub-indexes, or to condense the note to one durable fact and move logs and reference material into the repository. Never edits the file. Defaults: index 80 lines, 10240 bytes, 150 bytes per line; note 40 lines, 3072 bytes. An Edit or MultiEdit that does not lengthen a note passes, and a sub-index (`_index-<theme>.md`) is exempt. A memory directory moved by `autoMemoryDirectory` is not covered | No (feedback only) | `AC_MEMORY_INDEX_MAX_LINES`, `AC_MEMORY_INDEX_MAX_BYTES`, `AC_MEMORY_INDEX_MAX_LINE_BYTES`, `AC_MEMORY_NOTE_MAX_LINES`, `AC_MEMORY_NOTE_MAX_BYTES`; `0` turns one check off |
| `posttooluse-cli-diagnostics.sh` | `Write\|Edit\|MultiEdit` | A `.dart` or `.php` file is written or edited, including by subagents | Runs the command-line analyzer on that one file and returns the result as context, as ground truth against stale LSP diagnostics: `dart analyze --fatal-infos` for Dart; `php -l` for PHP, plus the project's own `vendor/bin/phpstan` when its `composer.json` directory has one. Registered with a 60 second timeout | No (informs only) | `AC_CLI_DIAGNOSTICS=0`; `AC_CLI_DIAGNOSTICS_TIMEOUT` (seconds per tool, default 20) |
| `posttooluse-memory-file-budget.sh` | `Write\|Edit\|MultiEdit` | A write leaves a memory file over budget | Tells Claude to consolidate it, following the writer skill. Defaults: `CLAUDE.md`, `AGENTS.md` and `.claude/rules/*.md` 120 lines and 12288 bytes; `CLAUDE.local.md` 60 lines and 6144 bytes; `PROJECT.md` 150 lines; `DESIGN.md` 300 lines. Silent when an edit did not grow the file, on `.ac/init/proposed/` drafts, and during `/ac:init-project` | No (feedback only) | `AC_MEMORY_FILE_BUDGET=0` turns it off; `AC_CLAUDE_MD_MAX_LINES`, `AC_CLAUDE_MD_MAX_BYTES`, `AC_CLAUDE_LOCAL_MD_MAX_LINES`, `AC_CLAUDE_LOCAL_MD_MAX_BYTES`, `AC_RULE_MAX_LINES`, `AC_RULE_MAX_BYTES`, `AC_PROJECT_MD_MAX_LINES`, `AC_DESIGN_MD_MAX_LINES`; `0` turns one check off |
| `posttooluse-question-timeout.sh` | `AskUserQuestion` | An `AskUserQuestion` call timed out with you away (the payload carries `afkTimeoutMs`) | Tells Claude to wait and end the turn with one line naming the question, and arms a latch that lets the `Stop` guards allow that ending. Only when this session owns a live `/ac:auto` or `/ac:coordinate` run and the question is not a blocker does it say to continue with the recommended option and record it as not user-approved. An answered question retires the latch | No (feedback only) | `AC_QUESTION_TIMEOUT=0`; `AC_QUESTION_TIMEOUT_SHAPE=block` sends the text as a block reason instead of context (default `context`) |

## Stop

None of the four has a matcher. They fire when the main thread tries to end its turn; a subagent's end goes to `SubagentStop`. Blocking here keeps the turn going and hands Claude a reason.

All four allow the stop without spending any budget when background work that will wake the session is running (a subagent, a workflow, an MCP or cloud task, or a shell), because its notification starts the next turn. The three run guards count a shell only when it runs under `timeout N` (N up to 3600 seconds) or is a recognised finite job such as a test, build, analyze or install, with no `until` or `while` loop; a dev server never counts. The announce guard counts any shell that is not long-lived, and any cron. All four also allow the stop while a timed-out question is waiting for your answer (the latch `posttooluse-question-timeout.sh` arms).

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `stop-guard.sh` | none | A turn ends while this session owns an `/ac:execute` run (`.ac/state/active-execution.json`, under 24 hours old) | While the plan has unchecked steps, blocks and names the next one. Gives up after 10 blocks, or after a forced continuation in which the unchecked count did not move and no tool ran. Counter in `.ac/state/stop-guard.json` | Yes | `AC_STOP_GUARD_MAX_BLOCKS` (default 10; `0` stops it blocking) |
| `stop-guard-auto.sh` | none | A turn ends while this session owns an `/ac:auto` run (`.ac/state/active-auto.json`, under 24 hours old, 72 over a coordinator run) | Blocks until the run's `verdict.md` exists; once it exists, blocks once more (`closing` phase) for the outward actions, the marker's deletion and the report. While a coordinator marker this session owns is live, `stop-guard-coordinate.sh` owns the stop instead. Budget is per phase, counted in `.ac/auto/<slug>/` | Yes | `AC_AUTO_MAX_BLOCKS` (default 3 per phase; the closing phase always gets 1 whatever the value; `0` stops it blocking in every earlier phase) |
| `stop-guard-coordinate.sh` | none | A turn ends while this session owns an `/ac:coordinate` run (`.ac/state/active-coordinate.json`, under 72 hours old) | Blocks until the run's `verdict.md` exists, naming the open bundles. Separately, once per prompt, blocks a turn that lacks the three status lines (`progress:`, `lanes:`, `owner:`) the skill requires. Budget is per phase, counted in `.ac/coord/<slug>/` | Yes | `AC_COORDINATE_MAX_BLOCKS` (default 3 per phase; `0` stops the sequencing block but not the status-line check) |
| `stop-guard-announce.sh` | none | A turn ends in any interactive main-thread session, in any project, with no `/ac:execute` or `/ac:auto` marker of this session | Reads only the last paragraph of the reply (fenced and inline code removed). If it ends on an announced next step, an offer to continue, or a question asked in prose, a regex hit goes to a judge (see below); only a judge verdict of "keep working" continues the turn. At most 1 continuation per stall and 3 per prompt. Skips headless and SDK runs, subagent stops, and the judge's own session. Registered with a 25 second timeout | Yes | `AC_ANNOUNCE_GUARD_MAX_BLOCKS=0` turns it off (default 1); `AC_ANNOUNCE_GUARD_MAX_TOTAL` (default 3); `AC_ANNOUNCE_JUDGE_MODEL` (default `sonnet`); `AC_ANNOUNCE_JUDGE_TIMEOUT` (seconds, default 20) |

The announce judge is an isolated `claude -p` call: no user settings or plugins (so none of these hooks load inside it), no MCP servers, no tools, no saved session, run from `$TMPDIR` under a perl `alarm`. It receives your last request (shortened to 1,500 characters) and the last 4,000 characters of the reply, and answers a yes or no. The turn ends normally on any timeout, error, unparsable answer, missing `claude` or `perl`, or when `ANTHROPIC_BASE_URL` is set (the `sonnet` alias would resolve to another provider's model, which was never measured). The guard also stays out of the way when the reply names something only you can supply (a credential, a login, a physical action).

## SubagentStop

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `subagentstop-background-guard.sh` | none | An `ac` subagent (`ac:<name>` or one of the bare names) other than `ac:lane` gives its final report | If a background shell or monitor that this subagent started is still running (matched by task ids in its own transcript), blocks once per agent and tells it to `TaskStop` each one and repeat its full report. A subagent that ignores this is let through on its next stop. Marker files in `${TMPDIR:-/tmp}/ac-subagent-stop/`, swept after a day | Yes, once | None |

## SessionEnd

| Hook script | Matcher | Fires when | What it does | Can block | Switch or knob |
|---|---|---|---|---|---|
| `session-lease-sweep.sh` | none | A session ends, except when the reason is `resume` | If this session recorded leases with `ac lease add`, runs `ac lease sweep` detached (it outlives the 1.5 second SessionEnd budget) to stop them. A lease is one of four kinds: a pid, an Android emulator, an iOS simulator or a Playwright session. Exits at once when jq, node, the bundle `cli/ac.js` or a lease file is missing | No | None |

## Network and processes

No hook script contains a `curl`, `wget` or HTTP client call. The hits for `gh` and `http` in `plugins/ac/hooks` are patterns the guards match against commands (`pretooluse-bash-guard.sh`, `lib/wake-count.jq`) and URLs in comments.

Two hooks start another `claude` process. Each runs `claude -p` with `--setting-sources ''`, `--strict-mcp-config`, `--tools ''` and `--no-session-persistence`, from `$TMPDIR`, under a perl `alarm`, so it uses whatever login and endpoint the `claude` on your `PATH` already uses, and no plugin or hook loads inside it.

| Hook | When | Sends | Model | Time limit |
|---|---|---|---|---|
| `stop-guard-announce.sh` | Only after the regexes flag the reply's last paragraph | Your last request (up to 1,500 characters) and the last 4,000 characters of the reply | `sonnet` by default (`AC_ANNOUNCE_JUDGE_MODEL`); skipped when `ANTHROPIC_BASE_URL` is set | 20 seconds (`AC_ANNOUNCE_JUDGE_TIMEOUT`) |
| `userpromptsubmit-session-title.sh` | Only with `AC_SESSION_TITLE=1`, on the first prompt and every tenth, in a detached process | An excerpt: the latest compaction summary or first prompt, the last 50 entries after it (user prompts cut to 400 characters, assistant text to 300, one line per tool call that changes something), and the triggering prompt (up to 2,000 characters) | `haiku` by default (`AC_SESSION_TITLE_MODEL`); not skipped under `ANTHROPIC_BASE_URL` | 45 seconds |

Other hooks run local programs and make no connection themselves:

- `session-lease-sweep.sh` starts `node` on the bundled CLI, which signals recorded pids and runs `adb`, `xcrun simctl` and `playwright-cli` for the leases a session recorded. `cli/ac/src/lease.ts` imports no network module.
- `posttooluse-cli-diagnostics.sh` runs `dart analyze`, `php -l` and the project's own `vendor/bin/phpstan` on the edited file. Those tools run your project's configuration and code; whether any of them touches the network is not verified.
- `session-start-plan-state.sh` runs `git log`; `session-start-working-rules.sh` runs `ps` (only with `AC_WORKING_RULES_APPENDED=1`) and writes `~/.claude/ac/working-rules.md`.
- The `Bash` guards and budget hooks run `jq`, `awk`, `perl` and `rg` on the command text; none executes the command.

## Turning hooks off

Set variables in `settings.json` under `env`; they reach hooks. `0` is the off value for the hooks below, except where stated.

| To turn off | Set |
|---|---|
| Announce guard | `AC_ANNOUNCE_GUARD_MAX_BLOCKS=0` |
| Session title (off by default) | leave `AC_SESSION_TITLE` unset, or not `1` |
| Memory file gate | `AC_MEMORY_FILE_GATE=0` |
| Memory file budget | `AC_MEMORY_FILE_BUDGET=0` |
| Memory index and note budget | `AC_MEMORY_INDEX_MAX_LINES=0`, `AC_MEMORY_INDEX_MAX_BYTES=0`, `AC_MEMORY_INDEX_MAX_LINE_BYTES=0`, `AC_MEMORY_NOTE_MAX_LINES=0` and `AC_MEMORY_NOTE_MAX_BYTES=0` |
| CLI diagnostics | `AC_CLI_DIAGNOSTICS=0` |
| Subagent Bash guard, shell replace rule (search denials stay on) | `AC_BASH_EDIT_GUARD=0` |
| Question timeout answer | `AC_QUESTION_TIMEOUT=0` |
| Working rules context | `AC_WORKING_RULES=0` |
| Execute, auto and coordinate guards | `AC_STOP_GUARD_MAX_BLOCKS=0`, `AC_AUTO_MAX_BLOCKS=0`, `AC_COORDINATE_MAX_BLOCKS=0` (see the Stop table for what each leaves) |

The explore call budget has only a limit (`AC_EXPLORE_MAX_CALLS`; `0` denies every call), not a switch. The other hooks have no per-hook switch: the plan-mode block, shell syntax guard, away guard, file-scope guard, subagent Bash guard search denials, explore read-only checks, subagent stop guard, plan state and lease sweep. Claude Code has no way to disable a single hook either; `"disableAllHooks": true` in settings turns off every hook, yours included, and disabling the plugin removes these.
