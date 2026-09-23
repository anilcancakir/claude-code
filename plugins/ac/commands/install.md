---
description: "Set up ac for your user: my-coding and my-language skills, the global CLAUDE.md and settings.json, each write gated."
argument-hint: "[--dry-run] [--skip-skills] [--skip-settings] [--skip-claude-md]"
effort: medium
disable-model-invocation: true
---

# /ac:install

Tunes your user-scope environment so the ac workflow replaces the matching Claude Code built-ins. Safe defaults apply silently; anything that loosens a gate or touches a secret is opt-in.

Request: $ARGUMENTS

Precondition: the ac plugin is already installed and loaded. This command does not bootstrap the install and never calls `/plugin marketplace add` or `/plugin install`. It writes only under `~/.claude/`, and only the files each phase names.

## Phase 0: Identity, arguments, preflight, languages

You are the `/ac:install` orchestrator. You interview the operator, delegate skill authoring to `ac:skill-creator`, and write user-scope config behind explicit gates.

**CAN**: Use `Read`, `Write`, `Edit`, `Bash`, `AskUserQuestion`. Invoke `ac:skill-creator` through the `Skill` tool. Probe the ac MCP server with `mcp__plugin_ac_ac__resolve-library`. Write the `.proposed` sidecar and the two `.bak-ac-install` backups.

**CANNOT**: Hand-write `my-coding` or `my-language` SKILL.md content; that is `ac:skill-creator`'s job. Blind-overwrite `~/.claude/CLAUDE.md` or `~/.claude/settings.json`; both go through a backup plus a gate. Write settings keys from memory; the Phase 4 reference is the only source. Edit anything outside `~/.claude/`. Widen an allow rule past the literal server segment (`mcp__plugin_ac_ac__*`, never `mcp__*`).

**MUST**: Honour every flag from 0a for the whole run. Under `--dry-run`, render every planned change and call no `Write` or `Edit`. Back up each file before rewriting it. Leave an existing skill alone unless the operator picks Recreate. Read the Phase 3 template and the Phase 4 reference rather than reproducing either from this body: both have drifted from a restated copy before, and a stale copy fails silently.

### 0a. Parse arguments

Mirror the `commit.md` Phase 0 flag scan. Read `$ARGUMENTS` once:

1. `--dry-run` sets `DRY_RUN`. Every phase plans and prints, nothing is written.
2. `--skip-skills` sets `SKIP_SKILLS`. Skips Phases 1 and 2.
3. `--skip-claude-md` sets `SKIP_CLAUDE_MD`. Skips Phase 3.
4. `--skip-settings` sets `SKIP_SETTINGS`. Skips Phase 4.
5. Ignore any other token.

### 0b. Detect the environment

Record each result. A failed detection is noted and never blocks the run.

| Check | Records |
|---|---|
| `uname -ms` | OS |
| `test -d ~/.claude/skills/my-coding` | `MY_CODING_EXISTS` |
| `test -d ~/.claude/skills/my-language` | `MY_LANGUAGE_EXISTS` |
| `test -f ~/.claude/CLAUDE.md` | `CLAUDE_MD_EXISTS` |
| `test -f ~/.claude/settings.json` | `SETTINGS_EXISTS` |
| `test -d ~/.claude/skills/my-workflow` | `LEGACY_MY_WORKFLOW` |
| the conjunction below, run only when `SETTINGS_EXISTS` | `SCHEDULING_TRIMMED` |

```
jq -e '((.permissions.deny // []) | map(split("(")[0])) as $d
       | ($d | index("ScheduleWakeup")) and ($d | index("CronCreate"))
         and ((.skillOverrides.schedule // "") == "off")' ~/.claude/settings.json
```

A non-zero exit, a missing file, or a `jq` failure all mean false. `SCHEDULING_TRIMMED` decides one conditional section in Phase 3, and it is read here rather than asked because the answer is already on disk.

Three things about the predicate. It tests one key from each of the three claims the section makes, because the section asserts that cron is gone, that wakeup is gone, and that the scheduling skills are off; a single deny confirms none of the other two. It reads `~/.claude/settings.json` only, never project or local scope, because the file being written is the GLOBAL CLAUDE.md and a project-scope deny would make its claim false in every other project. And it fails closed: a false sentence in a file that loads everywhere costs more than a missing section.

It cannot come from the Phase 4 Group D gate, which runs after Phase 3 has written the file. On a fresh machine it is false, which is correct; Phase 4's last step closes the seam when Group D then turns the trim on in the same run.

Earlier versions scaffolded a `my-workflow` skill. The discipline now ships inside the Phase 3 CLAUDE.md, so a surviving copy duplicates it. Do not delete it; surface it in Phase 5 so the operator can.

### 0c. Probe ac MCP reachability

Call `mcp__plugin_ac_ac__resolve-library` with a trivial query such as `react`. Record `MCP_REACHABLE` true on a result, false on error, timeout, or tool-not-available. Phase 3 names the ac MCP fallback tools only when it is true, so the generated file never points at a tool the operator cannot reach.

If the tool path does not resolve, say that `/mcp` confirms the exact server name. The bundled server is keyed `ac` in `.mcp.json` and the host namespaces it as `plugin_ac_ac`, so the runtime tools are `mcp__plugin_ac_ac__*`.

### 0d. The language pair

Two answers, taken here rather than in Phase 3 because Phases 1 and 2 both need them and both run first. Skip this step entirely when `SKIP_SKILLS` and `SKIP_CLAUDE_MD` are both set, since nothing left to run consumes either value.

Ask as two questions in one `AskUserQuestion` call:

1. `CONVERSATION_LANGUAGE`, the language you and the operator talk in.
2. `ARTIFACT_LANGUAGE`, the language code, identifiers, comments, doc blocks, commit messages and documents are written in.

Default both to English and never infer the second from the first. They are independent by design, and Turkish conversation with English artifacts is the case the split exists for. When `CLAUDE_MD_EXISTS`, read the file first and offer what it already says as the pre-filled option rather than asking cold; a `Core principles` section written by a previous run answers both.

Both values are consumed three times: the Phase 1 brief, the Phase 2 brief, and the Phase 3 placeholders. Collect them once here and pass the same strings to all three, so a generated skill cannot disagree with the generated CLAUDE.md about what language the project writes in.

Run this even under `--dry-run`. Both briefs and the Phase 3 preview print these values, and a preview built without them does not match what a live run writes. This matches 3a rather than the Phase 4 gates: a question whose answer only feeds a preview still has to be asked, while a question whose only effect is a settings write does not.

## Phase 1: my-coding skill

Skip when `SKIP_SKILLS`.

### 1a. Skip-if-present gate

When `MY_CODING_EXISTS`, ask before touching it:

```
AskUserQuestion({
  header: "my-coding?",
  question: "A my-coding skill already exists at ~/.claude/skills/my-coding/. How should I handle it?",
  options: [
    {label: "Skip (Recommended)", description: "Leave the existing my-coding skill untouched and continue."},
    {label: "Recreate", description: "Run the style interview and regenerate my-coding from scratch."}
  ]
})
```

On Skip, go to Phase 2. Otherwise run 1b and 1c, which is also the path when the skill is absent.

### 1b. Style interview

Through `AskUserQuestion`, one decision per question:

1. Primary stack and the language versions in play.
2. Non-negotiable rules (multiSelect: type everything, identifiers and comments in `ARTIFACT_LANGUAGE` only, TDD, zero linter suppressions, minimal diff, plus a free-text option). Render the language option with the 0d answer substituted, so the operator is confirming a concrete rule rather than an abstract one.
3. Architecture philosophy: how business logic is organised.
4. Formatting: line width, indentation, trailing commas, import order.
5. Testing discipline: test-first, test-alongside, or post-implementation.
6. Pet peeves and anything the rounds above missed.

Compile a brief: stack and versions, each rule with a one-line reason, the architecture stance, the formatting table, the testing stance, the pet peeves.

### 1c. Delegate to ac:skill-creator

Under `--dry-run`, print the brief and the target path and skip the invocation. Otherwise `Skill({skill: "ac:skill-creator"})`, handing it the brief plus these instructions:

- Create `my-coding` at `~/.claude/skills/my-coding/`.
- Fill `${CLAUDE_PLUGIN_ROOT}/references/coding-style-template.md` from the brief. Its `<artifact language>` placeholder takes the 0d answer; state the value in the brief rather than leaving the creator to infer it from the stack. Rewrite both halves of that rule's example in the artifact language too: the shipped WRONG case is a Turkish identifier, so it silently becomes the CORRECT case for an operator whose artifact language is Turkish.
- Author one `references/<language>.md` per primary stack. Keep the SKILL.md body lean and push language detail into those files.
- Author `references/anti-patterns.md` carrying the template's required seed entries, whatever the interview surfaced. State this in the brief rather than trusting the creator to find it in the template: one run produced a thirteen-row table and landed none of the seeds.

Do not write the SKILL.md yourself. The creator owns file content; this command supplies the brief and the template path.

## Phase 2: my-language skill

Skip when `SKIP_SKILLS`. Same shape as Phase 1.

### 2a. Skip-if-present gate

When `MY_LANGUAGE_EXISTS`:

```
AskUserQuestion({
  header: "my-language?",
  question: "A my-language skill already exists at ~/.claude/skills/my-language/. How should I handle it?",
  options: [
    {label: "Skip (Recommended)", description: "Leave the existing my-language skill untouched and continue."},
    {label: "Recreate", description: "Run the voice interview and regenerate my-language from scratch."}
  ]
})
```

On Skip, go to Phase 3. Otherwise run 2b and 2c, which is also the path when the skill is absent.

### 2b. Voice interview

1. Which modes matter: documentation, article, commit message, code comment, PR description.
2. How formality shifts across those modes.
3. The traits that make their writing recognisable.
4. Signature phrases, or none.
5. Whether they supply writing samples; if so, collect the excerpts or a path.

Compile a brief: active modes with opening and closing patterns, the tone spectrum, the voice traits, the signature phrases, any samples.

### 2c. Delegate to ac:skill-creator

Same gating as 1c. Instructions:

- Create `my-language` at `~/.claude/skills/my-language/`.
- Fill `${CLAUDE_PLUGIN_ROOT}/references/language-style-template.md` from the brief. Its first two Writing Rules are fixed content, the scoped dash rule and the content-sets-length rule; keep both verbatim and fill only the numbered placeholders after them. Delete any numbered placeholder the interview did not fill rather than inventing a rule to fill it: 2b collects modes, formality, traits, phrases and samples, and no rules at all, so an unfilled slot is the normal case. Prose the operator writes for people is in `ARTIFACT_LANGUAGE`, which the brief states.
- Write any supplied samples to `references/examples.md` and point the SKILL.md at it.

## Phase 3: global CLAUDE.md

Skip when `SKIP_CLAUDE_MD`.

### 3a. Fill the placeholders

Read `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md` and the operator's current `~/.claude/CLAUDE.md`, in that order, before asking anything.

On an upgrade the current file is the answer sheet. Identity, conversation language, trigger words, test tools and stack are all recorded in the copy this phase is about to replace, and asking again breaks the rule the generated file itself carries against asking what a readable file already answers. Measured on one real upgrade, every placeholder was answerable and a full interview would have asked nothing new. Pre-fill what you can, then fall back to the rounds below only for what the current file leaves open, or when there is no current file. Fill `Identity` and `Role` from one string whichever branch you are on: take the full `name <email>` once and derive `Role`'s given name from that same value, never from a second line of the source.

Pre-filling replaces the rounds; it does not replace the confirmation. Render the filled values as a list inside the `question` text of one `AskUserQuestion`, with options `Correct` / `Fix identity` / `Fix working style`, and let the operator answer before you build anything, however obvious the values look.

Language is deliberately not on that list. 0d already asked, and Phases 1 and 2 have been briefed with the answer and have written it into two skills, so a change accepted here would leave those skills disagreeing with the file this phase is about to write. If the operator raises it anyway, do not silently take the new value: name the skills that were built on the old one and offer a Recreate pass over Phases 1 and 2 alongside the corrected CLAUDE.md. Skipping this is not a shortcut, it is the failure: on the run that produced this rule the name was pre-filled from two different lines of the same source file and shipped as `Anilcan` in `Role` and `Anılcan` in `Identity`, an inconsistency a single confirmation round would have caught and which nothing downstream checks. A source file that disagrees with itself is the normal case, not the exception, because the sections were written months apart.

Interview against the placeholders the template actually carries, not against the count below; a restated roster is exactly what 3b warns about. Three things about them:

- Several placeholders occur more than once, and several others are whole conditional lines that either render or vanish. Do not work from a count, in this body or in your head: an earlier count went stale the moment a placeholder was added. Count them in the template you just read, replace every occurrence, and treat a conditional line as handled only once you have decided which way it goes. Substituting the first occurrence of a repeated placeholder and stopping ships a raw placeholder into a live CLAUDE.md.
- Not every angle bracket is one. `/ac:plan <topic>` and `.ac/plans/<slug>/plan.md` are literal text describing a command and a path. A placeholder reads as a description of what to substitute, not as an argument.
- When the operator already has an optional section or bullet, carry theirs forward rather than regenerating it; an earlier install's `## Blocked pages` section moves into the `Web research` list as one bullet with its facts kept. The shape guidance for the blocked-pages bullet exists to give a new user a well-shaped line, not to compress one that already earned its length: on the run that produced this rule, three interview answers would have discarded two measured timings and a failure mode.

The rounds, for a fresh install or an unanswered placeholder:

1. Identity: one answer, used twice. `Identity` takes the full `name <email>` string, and `Role` takes the given name out of that same string, never a value sourced separately. Offer `git config --get user.name` and `--get user.email` as the pre-filled option and let the operator correct it: a transliterated git identity is common, and this file is where the accented form belongs.
2. Language. Both answers were taken in 0d, before Phase 1 needed them; do not ask again. Three things follow from the pair. Append the organisation-override sentence to the conversation-language bullet only when that answer is not English; it is the whole rule for someone whose employer mandates English and noise for everyone else. Emit the language-split bullet only when the two answers differ, because on a matching pair it explains a distinction that does not exist. And keep both values consistent with what Phases 1 and 2 were briefed with, since the generated skills state the artifact language too.
3. Working style, in one multi-question call: the end-to-end trigger words meaning "verify through actual use, do not stop at a green build" (defaults "ship it", "make it work"); the real-world-test tools (multiSelect, defaults SSH, browser automation, HTTP client, REPL, plus free text); and the primary stack for the optional stack-specific verification line, or "skip" to drop it.
4. The optional sections. First, any skill beyond `my-coding` and `my-language` whose trigger has to hold even when its own listing entry is dropped, each becoming one line in `Skills`. Ask it as "which of your other skills would you not want to lose", list the ones on disk at `~/.claude/skills/` as options, and take none as a valid answer. The reason is mechanical: a skill's description is loaded every turn under a budget of 1% of the context window, and an overflowing listing is trimmed starting with the least-invoked skill, so the skill most likely to lose its description is the one the operator forgot they had. This file is not subject to that budget. Then any coding anti-patterns beyond the ones the template ships, appended as bullets in the same voice or omitted. Then whether a third fetch path exists for pages a WAF blocks, after the built-in and the ac MCP fallback both fail; if so collect the tool, the conditions that hand off to it, and the one thing that is easy to get wrong, and write one bullet in `Web research` from those three. If not, drop the placeholder line.

Run this even under `--dry-run`: the answers feed the preview, and a preview built without them does not match what a live run writes.

### 3b. Build the proposed file

The generated file is everything between the `<!-- ac:delegation:start -->` and `<!-- ac:delegation:end -->` markers. Reproduce every heading it carries, `#` and `##` alike, in the order it carries them; the first is a level-one `# Role`, so a scan written for `##` drops it.

The template is the only roster. Do not restate the section names or a line count here: an enumeration that once sat in this command named eleven sections against the template's twelve, and went unnoticed for over a month.

The template's HTML-comment header argues what is in the file and what is deliberately left out, and carries the keep test plus the grep recipe for re-auditing either against a shipped binary. Read it before changing a section. Do not re-derive its reasoning in this command, where the two copies would drift apart.

Two of its conclusions change what this phase writes. Its notes are HTML comments rather than `[//]: # (...)` link-reference definitions because the memory loader strips block-level HTML comments before injection, so that form costs nothing while the other ships as visible text. And it carries no "verify your work" instruction, because explicit verification instructions cause over-verification on the current Opus generation at no quality gain; if an answer tempts you to add one, put the requirement in the success check instead.

Keep every static section verbatim and substitute only the placeholders. Drop the stack-specific verification line when the operator answered "skip", the blocked-pages bullet when they reported no third fetch path, the `Watching something over time` section when `SCHEDULING_TRIMMED` is false, and, when `MCP_REACHABLE` is false, the `mcp__plugin_ac_ac__web-fetch` bullet in `Web research`, the `web-code-search` step in `Research and review`, and the `mcp__plugin_ac_ac__web-fetch` mention in the blocked-pages bullet: those name tools as static text with no placeholder, so nothing else in this phase would remove them. Light tuning of the Skills wording from the Phase 1 and 2 answers is fine. Do not add sections.

This content lives in CLAUDE.md rather than a skill because CLAUDE.md reaches every main-thread turn unconditionally while a skill body loads only when the model elects to. Do not reintroduce a pointer-to-a-skill shape.

### 3c. Merge on the fence markers

The markers are the only anchor. Never fuzzy-match on headings.

When `CLAUDE_MD_EXISTS` is false, write the block straight to `~/.claude/CLAUDE.md`, or print it under `--dry-run`.

Otherwise read the current file and take one of three paths:

1. **Both markers, in order.** Replace everything between them inclusive, and preserve every byte outside verbatim.
2. **Neither marker.** Append the block after the operator's content.
3. **One marker, or the two out of order.** Stop. Do not append and do not guess the boundary. Appending is what builds the trap: the stray marker stays, so the next run sees a start before an end and a case-1 replace swallows whatever sits between them. Report which marker was found and at which line, name the two fixes (delete the stray marker, or add its partner around the block it was meant to fence), leave the file untouched, and go to Phase 4.

**The collision check, in cases 1 and 2.** Scan the bytes outside the fenced region for headings matching `^#{1,2} ` and list every one the block also carries. Case 1 needs this most and is the upgrade path, so it is every existing ac user: the block generates `Role`, `Core principles`, `Identity` and `Anti-patterns`, exactly the sections an operator has already hand-written, and on an upgrade those copies sit outside the fence where a case-1 replace never reaches them. The result says everything twice in two voices, and two rules that conflict are worse than either alone, because the model may then pick one arbitrarily.

Name the collisions and let the operator resolve them. You cannot tell which copy they meant.

**The exception.** When every out-of-fence heading is one the block now generates, nothing out there is losable; all of it is superseded. Offer replacing the whole file as the first gate option, naming the superseded headings and the backup path. Do not offer it on a partial collision, where a surviving heading means content the block does not carry.

**Before the gate**, confirm the substitution completed: grep the result for `<` followed by a lowercase letter and check every hit is an HTML comment, the literal `<topic>` or `<slug>`, or an email in angle brackets. A raw `<conversation language>` reaching a live file is this phase's likeliest failure and its cheapest to catch. Then confirm the result stays under 200 lines, and if it does not, report the count rather than cutting anything.

**Then gate the write.** Under `--dry-run`, print the result and stop. Otherwise back the file up with `cp -n ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak-ac-install`, the same non-clobbering form Phase 4 uses, so a re-run cannot overwrite the pristine first backup. This is the only phase that rewrites a file the operator has been hand-editing for months. Write the result to `~/.claude/CLAUDE.md.proposed` and ask:

```
AskUserQuestion({
  header: "Apply?",
  question: "Your global CLAUDE.md already exists. The proposed merge is at ~/.claude/CLAUDE.md.proposed. How should I handle it?",
  options: [
    {label: "Replace the whole file (Recommended)", description: "Only offered when every out-of-fence heading is superseded. Name them here, and name the backup path."},
    {label: "Apply the merge", description: "Replace the fenced region only and keep your out-of-fence sections. Name the collisions you would be left to reconcile."},
    {label: "Skip", description: "Leave the original in place; keep the .proposed file for manual review."},
    {label: "Edit", description: "Leave the .proposed file for you to edit; re-run after editing to apply."}
  ]
})
```

Drop the first option when the collision is partial or absent and recommend `Apply the merge` instead. A four-option list whose first option is wrong for the situation is worse than a three-option list.

On either apply path, write the file and delete the sidecar. On Skip, leave both. On Edit, leave the sidecar and say the operator can edit it and copy it over. Name the backup path in Phase 5 either way.

## Phase 4: settings.json

Skip when `SKIP_SETTINGS`.

Read `${CLAUDE_PLUGIN_ROOT}/references/install-settings.md`. It is the only source for every key below; this command deliberately carries none of them, and writing one from memory is how a wrong key ships. It also states the ADD-only rule that governs the whole phase.

1. **Read and back up.** Read `~/.claude/settings.json`, starting from `{}` when absent. Back it up with `cp -n ~/.claude/settings.json ~/.claude/settings.json.bak-ac-install` before any write, only when it exists. Skip the backup under `--dry-run`, where nothing is written.
2. **Group A**, safe-silent tuning. Apply silently, each key only when absent.
3. **Group C**, core ac parity. Apply without a prompt, including the migration strip for keys a prior install wrote. Surface every strip and every env rewrite in the gate diff, since neither the deny entry nor an exact-matched env value can be told apart from an operator's own choice.
4. **Groups B and D**, opt-in and default off. Present each through the `AskUserQuestion` block the reference defines, with every option unchecked, and write only what the operator checks. Skip both prompts under `--dry-run` and say no key would be set.
5. **Group E**, the output style, opt-in and default off. Ask through the reference's block and write the literal value it names, never a value you assembled yourself: a plugin style that does not resolve fails silently and reads exactly like the key being absent. Skip the question when `outputStyle` already holds any value other than `default`, which the reference explains is the no-style value rather than an answer, and skip it under `--dry-run`.
6. **The MCP token.** Follow the reference exactly. The value is never echoed, logged, or rendered.
7. **Show the diff and write.** Render newly-added against already-present, grouped A / C / B / D / E / token, with the token masked. Under `--dry-run`, stop here. Otherwise write the merged object back and report the same breakdown.
8. **Close the scheduling seam.** When Group D's scheduling trim was applied in this run and `SCHEDULING_TRIMMED` was false at 0b, set it true, re-evaluate the 3b conditional, and re-merge the block through 3c. The markers are still there and 3c is idempotent, so this is the same replace it always does. Skip when `SKIP_CLAUDE_MD` or `DRY_RUN` is set; under `--dry-run` Group D is never asked, so no seam exists. Report the re-merge in Phase 5 rather than asking the operator to run the command again.

## Phase 5: Summary

```
## /ac:install Complete

my-coding:    <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-language:  <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-workflow:  <not created (discipline lives in CLAUDE.md) | LEGACY COPY FOUND at ~/.claude/skills/my-workflow, now redundant>
CLAUDE.md:    <written | merged + applied | whole file replaced | proposed (awaiting review) | skipped (--skip-claude-md) | skipped (fence markers inconsistent) | dry-run>
Heading clash: <none | comma-list of headings both the block and the operator's own content carry>
CLAUDE.md backup: <~/.claude/CLAUDE.md.bak-ac-install | kept (pre-existing) | none (file absent or dry-run)>
settings:     <merged | skipped (--skip-settings) | dry-run>
Group A:      <N tuning keys set | all already present>
Group B:      <opt-ins applied: comma-list | none selected | skipped (dry-run)>
Group D:      <trims applied: comma-list | none selected | skipped (dry-run)>
Output style: <set to ac:concise | left off | already set to <existing value>, untouched | skipped (dry-run)>
MCP token:    <set | unchanged | skipped>
MCP URL:      <set | unchanged>
settings backup: <~/.claude/settings.json.bak-ac-install | kept (pre-existing) | none (settings absent or dry-run)>
MCP probe:    <reachable | unreachable (CLAUDE.md fallback steering omitted)>
```

The token line shows only `<set>`, `<unchanged>` or `<skipped>`, never a value.

Print these when they apply:

- Standing discipline lives in the global CLAUDE.md, not in a skill, because CLAUDE.md arrives on every main-thread turn and a skill body arrives only when the model elects to load it. The same split puts the short unconditional rules (identity, the two languages, the scoped dash rule, the answer-shape floor, the suppression ban) in CLAUDE.md and the depth behind them in `my-coding` and `my-language`: name the rule once where it always arrives, explain it once where it arrives on trigger.
- The `ac:concise` output style is the third layer and the only one that reaches the system prompt itself. It carries the six answering rules in full; CLAUDE.md keeps a one-line floor because the style can be switched off or replaced at any time. Say which of the two the operator now has, so nobody reads the floor as the whole feature.
- When `LEGACY_MY_WORKFLOW` was found, say `rm -rf ~/.claude/skills/my-workflow` removes the now-duplicated copy.
- Restate the tradeoff of any Group B opt-in that was applied. `skipWebFetchPreflight` drops the Anthropic domain-safety blocklist preflight, a known hang source tracked as anthropics/claude-code#34565. `skipDangerousModePermissionPrompt` and `acceptEdits` reduce confirmation friction by removing a confirmation.
- `statusLine` needs `bun` or `npx` on PATH to render.
- When `CLAUDE_CODE_RETRY_WATCHDOG` is set, say that every session, headless `claude -p` runs included, now waits through 429 and 529 errors without limit and up to a usage limit's reset time; an unattended job that must end needs an external timeout.
- Removed env keys stay set in any Claude Code session that is already running; say that every open session needs a restart for the new settings to apply.
- When step 8 fired, say so: Group D denied the cron and wakeup tools in this run, so `Watching something over time` was added to the CLAUDE.md after Phase 3 had already written it. Name the section and the fact that the trim takes effect from the next session on, so nobody reads the new section as describing the session they are in.
- Report the skill-listing cost, and write no setting for it. Claude Code loads every skill's `description` plus `when_to_use` on every main-thread turn under a budget of 1% of the model's context window, and an overflowing listing is trimmed starting with the skills the operator invokes least, silently. Say roughly what the operator's listing now costs, point at `/doctor` for the real figure and the biggest contributors, and name `skillListingBudgetFraction` as their lever if their own skills push them over. Raising that cap is a context tradeoff the operator owns, and the plugin cannot honestly widen a budget it is itself spending; Group D already refuses to make a context-cost change silently, and this is that decision inverted.

Next steps:

- Restart Claude Code so the settings.json changes take effect.
- Run `/mcp` to verify the ac MCP tools are reachable.
- When the output style was set, open `/config` after the restart and confirm the active style reads `ac:concise`. A value that does not resolve produces no warning, so the written key is not evidence that the style is live.
- Try entering native plan mode and confirm it is blocked with the `/ac:plan` steer.
- The two skills load in every session with no restart.

## References

Named without line numbers on purpose: an earlier set drifted the moment those files were edited. Each entry names the section it means.

- `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md`, the Phase 3 generated file inside its fence markers. Its HTML-comment header carries the keep test, what the built-in prompt reaches, and the grep recipe for re-auditing either against a shipped binary. The placeholder roster lives there, not here.
- `${CLAUDE_PLUGIN_ROOT}/references/install-settings.md`, every Phase 4 key, all three opt-in gates including the Group E output style, and the ADD-only rule.
- `${CLAUDE_PLUGIN_ROOT}/output-styles/concise.md`, the style Group E offers. Phase 4 writes its key and never its content; read it only to describe what the operator is turning on.
- `${CLAUDE_PLUGIN_ROOT}/references/monitoring.md`, the depth behind the `Watching something over time` section: why cron is not the answer for a trimmed operator, and two worked `Monitor` shapes. It deliberately restates nothing the `Monitor` tool's own description already carries.
- `${CLAUDE_PLUGIN_ROOT}/references/coding-style-template.md`, the Phase 1 seed including the required anti-pattern entries.
- `${CLAUDE_PLUGIN_ROOT}/references/language-style-template.md`, the Phase 2 seed.
- `${CLAUDE_PLUGIN_ROOT}/commands/init-project.md`, its CAN / CANNOT / MUST block for the orchestrator shape and its `.proposed` sidecar gate.
- `${CLAUDE_PLUGIN_ROOT}/commands/commit.md`, its Phase 0 for the `$ARGUMENTS` flag scan.
- `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`, which ships every ac hook, so Phase 4 writes none.
- `ac:skill-creator`, which owns the content of both generated skills.
