# /ac:install Phase 5 report

The final report template, the notes to print when they apply, and the next steps. "The reference" below means `${CLAUDE_PLUGIN_ROOT}/references/install-settings.md`.

```
## /ac:install Complete

Upgrade:      <PRIOR_VERSION -> PLUGIN_VERSION | pre-record -> PLUGIN_VERSION | not an upgrade>
Asked new:    <comma-list of option ids asked for the first time | none>
Record:       <~/.claude/ac-install.json written | not written (dry-run)>

my-coding:    <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-language:  <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-workflow:  <not created (discipline ships as working-rules.md) | LEGACY COPY FOUND at ~/.claude/skills/my-workflow, now redundant>
CLAUDE.md:    <written | merged + applied | whole file replaced | unchanged (upgrade, identical) | proposed (awaiting review) | skipped (--skip-claude-md) | skipped (fence markers inconsistent) | dry-run>
Heading clash: <none | comma-list of headings both the block or working-rules.md and the operator's own content carry>
Layout:       <new (working rules via wrapper) | new (working rules via SessionStart hook) | old (CLAUDE.md still carries <moved headings>; hook silent)>
Rules copy:   <~/.claude/ac/working-rules.md written | empty (markers not found) | dry-run>
Wrapper:      <added at <rc file>:<line>, backup <rc file>.bak-ac-install (new sessions; a resumed older session gets the hook copy) | already wired | declined | none found | not offered (<old layout | other append file>) | dry-run>
AFK timeout:  <added to the wrapper at <rc file>:<line> | added to settings.json env | already wired | declined | not offered (<hook missing | no wrapper and --skip-settings>) | dry-run>
CLAUDE.md backup: <~/.claude/CLAUDE.md.bak-ac-install | kept (pre-existing) | none (file absent, unchanged, or dry-run)>
settings:     <merged | unchanged | skipped (--skip-settings) | dry-run>
Group A:      <N tuning keys set | all already present>
Group B:      <opt-ins written this run: comma-list | none selected | already set (key present, possibly another value): comma-list | all answered (upgrade) | skipped (dry-run)>
Group D:      <trims applied: comma-list | none selected | all answered (upgrade) | skipped (dry-run)>
Output style: <set to ac:concise | left off | already set to <existing value>, untouched | skipped (dry-run)>
Group F:      <auto-update on for: comma-list | left off (false written) | no candidates | none left (already set in /plugin) | skipped (updates disabled by <var>) | skipped (dry-run)>
Session titles: <on (env.AC_SESSION_TITLE=1) | left off | already set | not offered (hook missing) | skipped (dry-run)>
Report only:  <none | comma-list of findings, each with its settings key path or its rc file and line>
MCP token:    <set | unchanged | skipped>
MCP URL:      <set | unchanged>
settings backup: <~/.claude/settings.json.bak-ac-install | kept (pre-existing) | none (settings absent or dry-run)>
MCP probe:    <reachable | unreachable (working-rules.md still names the ac fetch tools)>
```

The token line shows only `<set>`, `<unchanged>` or `<skipped>`, never a value.

Print these when they apply:

- The layout. The global CLAUDE.md block carries what every context needs, subagents included: role, identity, the two languages, the dash rule, the answer-shape floor, the anti-patterns with the security line, the one-line Delegation grant (the routing itself is in the working rules), the operator's `My workflow` fragments, and Skills. The workflow sections ship as working-rules.md and reach the main thread only; say which path delivers them on this machine (the wrapper's `--append-system-prompt-file`, or the SessionStart hook) and, when a wrapper was found and declined, that the hook covers it. The same split puts the short unconditional rules (identity, the two languages, the scoped dash rule, the answer-shape floor, the suppression ban) in CLAUDE.md and the depth behind them in `my-coding` and `my-language`: name the rule once where it always arrives, explain it once where it arrives on trigger.
- The `ac:concise` output style is the third layer and the only one that reaches the system prompt itself. It carries the six answering rules in full; CLAUDE.md keeps a one-line floor because the style can be switched off or replaced at any time. Say which of the two the operator now has, so nobody reads the floor as the whole feature.
- When `LEGACY_MY_WORKFLOW` was found, say `rm -rf ~/.claude/skills/my-workflow` removes the now-duplicated copy.
- Restate the tradeoff of any Group B opt-in that was applied, or that the Group C migration made take effect by moving `skipDangerousModePermissionPrompt` to the top level. `skipWebFetchPreflight` drops the Anthropic domain-safety blocklist preflight, a known hang source tracked as anthropics/claude-code#34565. `skipDangerousModePermissionPrompt` and `acceptEdits` reduce confirmation friction by removing a confirmation.
- When `W.afk` was applied, say that a question asked during an ac:auto run now continues after 3 minutes away and is recorded as not user-approved, that every other session still waits, that the keys reach a new session started from a new shell only, and that a background session never times out, since Claude Code does not arm the timer there. For the settings.json branch, repeat that disabling ac means removing both keys.
- When Group G was turned on, say that titles change from the next new session, on the first prompt and every tenth after, that `/rename` stops it for that session, and that `AC_SESSION_TITLE_PROMPT`, `~/.claude/ac/session-title.md` and `AC_SESSION_TITLE_PATTERN` replace the naming rule (the reference's Group G table).
- `statusLine` needs `bun` or `npx` on PATH to render.
- When `CLAUDE_CODE_RETRY_WATCHDOG` is set, say that every session, headless `claude -p` runs included, now waits through 429 and 529 errors without limit and up to a usage limit's reset time; an unattended job that must end needs an external timeout.
- Removed env keys stay set in any Claude Code session that is already running; say that every open session needs a restart for the new settings to apply. The same holds for the working rules: a session already running when CLAUDE.md lost the workflow sections gets neither the append file nor the hook copy until it restarts, and resuming it with `-c` gives it the hook copy, not the system-prompt one.
- For each report-only finding, give the exact line to remove or change and what it costs or duplicates. For an `ENABLE_TOOL_SEARCH` hit in a shell rc file, say the change reaches only a session started from a new shell.
- When step 10 fired, say so: Group D denied the cron and wakeup tools in this run, so the Watching sentence was added to `My workflow` after Phase 3 had already written it. Name the sentence and the fact that the trim takes effect from the next session on, so nobody reads the new sentence as describing the session they are in.
- Report the skill-listing cost, and write no setting for it. Claude Code loads every skill's `description` plus `when_to_use` on every main-thread turn under a budget of 1% of the model's context window, and an overflowing listing is trimmed starting with the skills the operator invokes least, silently. Say roughly what the operator's listing now costs, point at `/doctor` for the real figure and the biggest contributors, and name `skillListingBudgetFraction` as their lever if their own skills push them over. Raising that cap is a context tradeoff the operator owns, and the plugin cannot honestly widen a budget it is itself spending; Group D already refuses to make a context-cost change silently, and this is that decision inverted.

Next steps:

- Restart Claude Code so the settings.json changes take effect. The working rules arrive from the next session too: a new hook registration and the rewritten CLAUDE.md load only at session start, and the session that ran this command still holds the old block.
- When this run edited a shell rc file (the wrapper line or the question-timeout keys): the change reaches only a `claude` started from a shell that has read it. Open a new terminal tab, or run `source ~/.zshrc`, then start a new session with plain `claude`. Restarting from inside Claude Code, `-c`, `--resume` or `claude attach` keeps the old environment. A background session (`/background`, `claude --bg`, `claude agents`) runs under the Claude Code daemon: `/exit` only detaches it, and the daemon keeps the environment it started with, so stop it once from the new shell with `command claude daemon stop`. Check with `! printenv AC_AFK_TIMER` in the new session; it prints 1. The question timeout does nothing in a background session whatever the keys say: Claude Code never arms the timer there.
- On a later plugin release, run `claude plugin marketplace update ac` and `claude plugin update ac@ac`, restart, then `/ac:install --upgrade`; it asks only what this run did not.
- Run `/mcp` to verify the ac MCP tools are reachable.
- When the output style was set, open `/config` after the restart and confirm the active style reads `ac:concise`. A value that does not resolve produces no warning, so the written key is not evidence that the style is live.
- Try entering native plan mode and confirm it is blocked with the `/ac:plan` steer.
- The two skills load in every session with no restart.
