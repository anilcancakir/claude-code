# Skill Anti-Patterns

Common skill-writing mistakes, why they fail, and what to do instead. Read this when auditing an existing skill or debugging one that misbehaves.

## Contents

- Frontmatter failures
- Body failures
- Tooling and execution failures
- Architecture failures
- Plugin-distribution failures
- Iteration failures
- Quick audit checklist

## Frontmatter failures

### Vague description

**The mistake.** "Helps with documents", "processes data", "does stuff with files".

**Why it fails.** When the model has 100+ skills available, it picks based on the description alone. Vague descriptions do not earn the trigger. The skill stays cold while the model uses generic tools.

**The fix.** Specific, third-person, with both the function and the trigger contexts.

| Anti-pattern | Pattern |
|--------------|---------|
| "Helps with PDFs" | "Extracts text and tables from PDF files, fills forms, merges multi-page PDFs. Use when the user mentions PDFs, forms, or document extraction." |
| "Processes data" | "Cleans and reshapes CSV files using pandas (drop duplicates, normalize columns, type-coerce). Use when the user asks to clean a CSV, dedupe rows, or fix data types." |
| "Does git stuff" | "Generates Conventional Commits messages from staged changes by analyzing the diff. Use when the user asks for a commit message, says 'commit this', or wants to review staged changes." |

### First-person or second-person description

**The mistake.** "I can help you process Excel files", "You can use this to summarize PRs".

**Why it fails.** The description gets injected into the system prompt. Mixed POV confuses skill discovery, the model is reading "you" / "I" / "we" referring to itself, the user, and the skill all at once.

**The fix.** Third person, present tense, active voice. "Processes Excel files", "Summarizes pull requests".

### Reserved words in `name`

**The mistake.** `claude-helper`, `anthropic-tools`, `claude-pdf-skill`.

**Why it fails.** The Agent Skills spec rejects names containing `claude` or `anthropic`. The skill fails to load.

**The fix.** Pick a name describing the work, not the tool. `pdf-helper`, `dev-tools`, `pdf-processing`.

### `name` does not match the directory

**The mistake.** Directory `.claude/skills/foo/` with `name: bar` in frontmatter.

**Why it fails.** The runtime resolves the slash command from the directory name; the `name` field is the display name. Users typing `/bar` get nothing because the actual command is `/foo`. Inconsistency.

**The fix.** Either omit `name` (fall back to directory) or set it to match. Diverging on purpose is rare and almost never worth the confusion.

### Aggressive caps in instructions

**The mistake.** `description: CRITICAL: you MUST use this skill for ALL PDF requests.`

**Why it fails.** Modern Claude follows aggressive language too literally and overtriggers. Caps signal "this is unusual" and produce weird compliance behaviors. Worse, the description is the trigger surface, caps in it skew the trigger decision toward false positives.

**The fix.** Plain language. "Use when..." is enough. The description sells the skill on relevance, not on insistence.

### Over-budget description

**The mistake.** A 2,500-character description packed with every trigger phrase imaginable.

**Why it fails.** Claude Code truncates the combined `description` + `when_to_use` at 1,536 characters in the listing. Anything past that is invisible to the trigger decision, the trailing phrases never get seen.

**The fix.** Front-load the use case in the first 800 characters. Use `when_to_use` for synonyms and example phrasings. Keep combined length under 1,500 to leave headroom for listing budget pressure.

## Body failures

### Body too long

**The mistake.** SKILL.md hits 1,000+ lines because everything is "important".

**Why it fails.** The whole body enters the conversation when triggered and competes with everything else for context. After auto-compact, only the first 5,000 tokens of each invoked skill survive, past that gets cut. A 30,000-token body is at most a 30,000-token tax with the actually-load-bearing parts in the tail getting silently dropped.

**The fix.** Keep SKILL.md under 500 lines. Push detail into one-level-deep `references/` files with explicit drilldown pointers ("read this file when the user asks about X"). The model loads the references only on demand.

### Body explains things the model already knows

**The mistake.** "PDF (Portable Document Format) files are a common file format that contains text, images, and other content. To extract text from a PDF, you'll need a library. There are many libraries available..."

**Why it fails.** Every token explaining common knowledge displaces a token that could carry the user's project-specific signal. The model is already smart; it knows what PDFs are and that libraries exist.

**The fix.** Default to "Claude is already smart". Only add what the model would not already know, your conventions, your specific tools, your house rules. Challenge each paragraph: "does this justify its tokens?"

### Wrong degree of freedom

**The mistake.** Verbose step-by-step on a code review (open field), or "use whatever PDF library you prefer" on a database migration (narrow bridge).

**Why it fails.** Over-constraining open-field tasks wastes tokens and produces stiff output that ignores context. Under-constraining narrow-bridge tasks lets the model improvise where consistency matters and breaks production.

**The fix.** Match the level to the task's fragility. Multiple valid approaches, high freedom (text instructions, principles). Preferred pattern with room to vary, medium freedom (parameterized scripts, templates). Fragile, sequence-dependent, irreversible, low freedom (specific commands, fixed scripts).

### Too many options

**The mistake.** "Use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or..."

**Why it fails.** The model reads a menu of equally-valid choices and either picks the first one (which may be wrong for the task) or asks the user (defeating the skill's purpose).

**The fix.** Provide a default with an escape hatch. "Use pdfplumber for text extraction. For scanned PDFs requiring OCR, use pdf2image with pytesseract." One main path, named exceptions.

### Standing rules disguised as one-time instructions

**The mistake.** "For this turn, use the bundled script. For this run, follow the conventions in references/."

**Why it fails.** The body stays in the conversation for the rest of the session, but turn-scoped phrasing decays. By turn three, "for this turn" is ambiguous; the model may stop applying the rule.

**The fix.** Phrase as standing instructions. "Always use the bundled script when generating reports." "Follow the conventions in references/ for every file you create."

### Negative-only instructions

**The mistake.** "Do not be verbose. Avoid jargon. Do not use markdown."

**Why it fails.** The model has to imagine the wrong behavior first, then suppress it. The imagined behavior leaks into the output.

**The fix.** Positive instructions or positive examples. "Provide concise, focused responses." "Use plain language and define technical terms on first use." "Respond in flowing prose paragraphs."

### "Based on your findings, do X" inside a forked skill

**The mistake.** A forked-skill body that ends with "Based on your research, fix the bug."

**Why it fails.** The forked subagent has less context than you. It does not know the user's goals, cannot ask the user, and has no view of the parent conversation. "Based on your findings" pushes synthesis the parent should have done onto an agent that cannot do it.

**The fix.** If you can specify the work, specify it. If you cannot, do not delegate. Forked skills with vague tasks return shallow generic work.

### Two-level-deep references

**The mistake.** SKILL.md links to `advanced.md`, which links to `details.md`, which has the actual content.

**Why it fails.** When following a chain of references, the model often previews intermediate files with `head -100` rather than reading them in full. Content past the preview window is missed silently.

**The fix.** Every reference file links from SKILL.md directly. If `details.md` is what the model needs to read for case X, link `details.md` from SKILL.md, not from `advanced.md`.

### Reference files over 100 lines without a TOC

**The mistake.** A 400-line `api-reference.md` with no contents block at the top.

**Why it fails.** Same partial-read pattern as nested references. The model may `head -100` the file and miss everything below the cutoff. Without a TOC, it has no way to know what is past the cutoff.

**The fix.** Every reference file over 100 lines starts with a `## Contents` block listing its sections. The model can then either read the full file or jump to a specific section, but it always knows what is in there.

### Standing rules in the tail of the body

**The mistake.** The first 4,000 tokens are scenic background; the load-bearing rule appears at line 800.

**Why it fails.** After auto-compact, only the first 5,000 tokens of each re-attached skill survive. A rule that lives in the tail can be cut silently, and the model continues without it.

**The fix.** Put standing instructions near the top. Put scenic background, edge cases, and reference pointers later. Write the body so the first 5,000 tokens are self-sufficient.

## Tooling and execution failures

### Pre-approving everything with bare `Bash`

**The mistake.** `allowed-tools: Bash`

**Why it fails.** Pre-approves every shell command for the duration of the skill. A skill that calls `gh pr view` now has authorization to run `rm -rf` without prompting. Defeats the permission system as a guardrail.

**The fix.** Narrow patterns. `Bash(gh pr view:*) Bash(git status:*)`. List the exact subcommands the body invokes.

### Assuming tools and packages are installed

**The mistake.** "Use the pdf library to process the file."

**Why it fails.** The skill silently breaks when a user has not installed the package. The model may try to use the tool, fail, and either improvise badly or stop.

**The fix.** State dependencies explicitly. "Install the required package: `pip install pypdf`. Then use it: ..." Or check before assuming: "Run `python -c 'import pypdf'` to verify; if it errors, install via `pip install pypdf`."

### Windows-style paths in scripts or instructions

**The mistake.** `scripts\helper.py` or `reference\guide.md`.

**Why it fails.** Backslashes are escape characters in many contexts and break on macOS and Linux. Forward slashes work everywhere.

**The fix.** Always forward slashes. `scripts/helper.py`, `reference/guide.md`.

### Scripts that punt to the model

**The mistake.** A script that fails with `FileNotFoundError` and lets the model figure out what to do.

**Why it fails.** The point of bundling a script is determinism. If the script just exposes raw exceptions, you get the worst of both, the script's rigidity plus the model's improvisation, with no shared design.

**The fix.** Handle expected failures inside the script. Print actionable messages. Exit non-zero only on truly fatal errors. Let the model orchestrate; let the script execute.

### Voodoo constants in bundled scripts

**The mistake.** `TIMEOUT = 47  # ?`, `MAX_RETRIES = 5  # ?`

**Why it fails.** A future maintainer (or the model itself, debugging) cannot tell whether 47 seconds is the result of careful tuning or a typo.

**The fix.** Document the choice with a one-line comment explaining the reasoning, even if the reasoning is "default seemed reasonable". `TIMEOUT = 30  # HTTP requests typically complete within 30s; longer accounts for slow connections.`

### MCP tool calls without server prefix

**The mistake.** "Use the `bigquery_schema` tool".

**Why it fails.** Multiple MCP servers may expose tools with similar names. Without `ServerName:tool_name`, the model may fail to locate the tool or pick the wrong one.

**The fix.** Always fully-qualify. "Use the `BigQuery:bigquery_schema` tool". "Use the `GitHub:create_issue` tool".

### Live shell injection in documentation examples

**The mistake.** Documenting `` !`gh pr view 123` `` literally as an example, even inside a 4-backtick wrapper.

**Why it fails.** Claude Code's preprocessor scans the body bytes; markdown fences do not protect the example. Every invocation runs the command for real.

**The fix.** Escape the bang as `\!` in documentation examples. CommonMark renders `\!` as `!`, but the byte before `!` becomes `\`, breaking the preprocessor's lookbehind. Use plain `!` only when you actually want execution.

## Architecture failures

### Wrong invocation control

| Misuse | Symptom | Fix |
|--------|---------|-----|
| `disable-model-invocation: true` on a reference skill | Model never auto-applies the conventions; user has to type `/conventions` every time | Remove the flag; let the model trigger automatically |
| Default invocation on a `/deploy` skill | Model decides the code looks ready and triggers deployment | Add `disable-model-invocation: true`; deployment is user-only |
| `user-invocable: false` on a meaningful command | User cannot find the skill in the slash menu | Remove the flag; only hide skills that are pure background context |

### `context: fork` on reference content

**The mistake.** A `coding-conventions` skill set to `context: fork`.

**Why it fails.** Fork makes the body a subagent task. Reference content with no actionable goal produces a subagent with guidelines and no instructions. It returns nothing useful.

**The fix.** Remove `context: fork`. Reference content runs inline. Use fork only when the body is an actionable task.

### Forked skill that depends on conversation context

**The mistake.** A forked skill body that says "based on what we just discussed".

**Why it fails.** The forked subagent has no access to the parent conversation. "What we just discussed" is meaningless to it.

**The fix.** Either include the necessary context inside the body or arguments, or do not fork, keep the skill inline.

### Skill where a CLAUDE.md fact would do

**The mistake.** A skill with a one-line description and a five-line body restating the same thing.

**Why it fails.** Every skill has overhead, discovery, listing tokens, the trigger decision. A single fact does not earn that overhead.

**The fix.** Put it in CLAUDE.md. Skills win when the body is too long to keep always-loaded but useful enough to bring back when relevant.

### Skill where a hook would do

**The mistake.** A skill body that says "Always check X before Y" but X-before-Y must be enforced absolutely.

**Why it fails.** Body instructions are negotiable, the model can decide context overrides them. If the rule must hold deterministically (no force-push, every tool call audited), the body cannot guarantee it.

**The fix.** Hook, not body. Use the `hooks:` frontmatter field for skill-scoped enforcement, or `.claude/settings.json` for project-wide. Reach for hooks when negotiation is not enough.

### Preloading a `disable-model-invocation` skill into a subagent

**The mistake.** A custom agent's `skills:` field lists a skill flagged `disable-model-invocation: true`.

**Why it fails.** The loader cannot preload skills with this flag into subagents; the agent runs without the expected context.

**The fix.** Drop the flag if you want the skill preloadable. Otherwise, list a different skill, or write a version of the skill content directly into the agent's body.

## Plugin-distribution failures

### Repo-relative paths in plugin skills

**The mistake.** `references/foo.md` or `../docs/notes.md` inside a plugin skill body.

**Why it fails.** Plugin install destination is unknown at author time. A path that works in the plugin's source repo breaks the moment a user installs the plugin somewhere else.

**The fix.** `${CLAUDE_SKILL_DIR}/...` for every bundled file reference. The substitution resolves to the skill's directory inside the user's installed plugin tree.

### Pointing at the plugin root

**The mistake.** `${CLAUDE_SKILL_DIR}/../docs/foo.md` to reach files outside the skill directory.

**Why it fails.** `${CLAUDE_SKILL_DIR}` resolves to the skill's subdirectory, not the plugin root. Walking up with `..` may work in the source repo but is fragile across versions. Worse, files outside the skill directory are not guaranteed to be packaged with the plugin.

**The fix.** Keep everything the skill needs inside `<plugin>/skills/<skill-name>/`. Duplicate small files if needed; that is cheaper than fragile cross-skill references.

### Pulling from an HTTPS URL the model cannot reach

**The mistake.** "Read https://internal.company.com/runbooks/deploy.md".

**Why it fails.** The model may not have network access to the URL (auth, VPN, sandbox restrictions). The reference fails silently or with a confusing error.

**The fix.** Bundle the content inside the skill. If freshness matters, point at a public URL with predictable availability (Anthropic docs, GitHub README), or have the body run a shell command that fetches with the user's credentials.

## Iteration failures

### Adding rules without removing them

**The mistake.** Each iteration appends a new "always do X" without revisiting whether old rules still apply.

**Why it fails.** The body grows, the principles get diluted, and the model has to reconcile contradictions. After enough iterations, the skill is more lawyer-speak than guidance.

**The fix.** When you add a rule, look for a rule it replaces. Delete what does not pull its weight. Lean is the goal.

### Overfitting to the test prompts

**The mistake.** Three test cases all involve PDFs, so the body grows special-cased PDF instructions.

**Why it fails.** Skills get used a million times across many requests. If yours works only for the test prompts, it is useless.

**The fix.** Generalize from the test cases. If the symptom is "the model forgets to validate", do not write "for PDF tasks, validate"; write "always validate before applying changes" and have the body reflect that as a standing rule.

### Strengthening the body when the description is the problem

**The mistake.** The skill does not trigger, so the user adds aggressive language to the body. The body never gets to run because the skill does not trigger.

**Why it fails.** Triggering happens before the body loads. The body cannot fix a description that is not selling the skill to the trigger decision.

**The fix.** Diagnose where the failure is.

- *Does not trigger*, strengthen the description (more specific, more trigger phrases, less vague).
- *Triggers but does not influence behavior*, strengthen the body (clearer goal, success criteria, lead with the rule).
- *Triggers when it should not*, tighten the description (remove broad keywords, narrow the use case).

## Quick audit checklist

When auditing an existing skill, walk through these:

- [ ] `description` is third-person, specific, names the trigger contexts.
- [ ] Combined `description` + `when_to_use` under 1,536 characters.
- [ ] `name` is lowercase + hyphens, no reserved words, matches directory.
- [ ] No aggressive caps anywhere in frontmatter or body.
- [ ] Invocation control matches who should trigger.
- [ ] `context: fork` only on actionable-task bodies.
- [ ] `allowed-tools` lists narrow patterns, not bare tool names.
- [ ] Body under 500 lines; detail in one-level-deep references.
- [ ] Reference files over 100 lines have a TOC.
- [ ] Standing instructions, not turn-scoped phrasing.
- [ ] Standing rules near the top so they survive compact.
- [ ] Positive instructions, not negative-only.
- [ ] No "based on your findings" in forked bodies.
- [ ] Right degree of freedom for the task.
- [ ] Default with escape hatch, not menu of options.
- [ ] Forward slashes in all paths.
- [ ] MCP tools fully qualified (`ServerName:tool_name`).
- [ ] Dependencies stated explicitly when assumed.
- [ ] For plugin skills: every bundled file reference uses `${CLAUDE_SKILL_DIR}/...`.
- [ ] For plugin skills: no `${CLAUDE_SKILL_DIR}/..` walks; everything lives inside the skill dir.
- [ ] No literal `` !`<cmd>` `` or ` ```! ` blocks in documentation; bangs escaped as `\!`.
- [ ] Rules pull their weight; iterations remove as much as they add.
