# Anti-Patterns

Common prompt-writing failures, the why, and the fix. Read this when auditing an existing prompt or debugging a prompt that produces wrong output.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Anthropic prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- Migration guide (4.7 breaking changes and behavior shifts): https://docs.claude.com/en/docs/about-claude/models/migration-guide.md
- System prompts guide: https://docs.claude.com/en/docs/system-prompts.md
- Subagents page: https://docs.claude.com/en/docs/sub-agents.md
- Extended thinking: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md

## Aggressive language

### "CRITICAL: you MUST..."

**The mistake.** Writing CRITICAL, MUST, NEVER, ALWAYS in caps to make a rule stick.

**Why it fails.** Modern Claude follows aggressive language too literally. "CRITICAL: you MUST use this tool when researching" causes overtriggering; the model uses the tool even when reasoning would be faster.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes (tool triggering on 4.7).

**The fix.** Plain instruction.

| Anti-pattern | Pattern |
|---|---|
| "CRITICAL: you MUST use the search tool when..." | "Use the search tool when..." |
| "ALWAYS write tests before code." | "Write tests before code." |
| "NEVER skip the validation step." | "Validate before processing." |

The model is smart enough. Aggressive language signals "this might not be true" and causes weird compliance behaviors.

### Caps for emphasis

Same problem at a smaller scale. CAPS in a sentence shift the model into "this is a special instruction" mode. Reserve for the genuinely critical (one or two phrases per prompt, max).

## Negative-only instructions

### "Do not be verbose"

**The mistake.** Telling the model what not to do without showing what to do.

**Why it fails.** The model has to imagine the wrong behavior first, then suppress it. The imagined behavior leaks into the output.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Be clear and direct.

**The fix.** Positive instruction or positive example.

| Anti-pattern | Pattern |
|---|---|
| "Do not be verbose." | "Provide concise, focused responses. Skip non-essential context, and keep examples minimal." |
| "Avoid jargon." | "Use plain language. Define any technical term on first use." |
| "Do not use markdown." | "Respond in flowing prose paragraphs." |

Show one short response you like rather than writing "do not be verbose." Examples beat negative instructions.

## Vague scope

### "Make this consistent"

**The mistake.** Asking for a generalization without saying what to generalize over.

**Why it fails.** Modern Claude (especially 4.8) takes instructions literally. It will not silently generalize from the example you showed to other things in the file.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Literal interpretation.

**The fix.** State scope explicitly.

| Anti-pattern | Pattern |
|---|---|
| "Make the formatting consistent." | "Apply the formatting in the first example to every section heading in the file, not just the first one." |
| "Use TypeScript strict mode." | "Use TypeScript strict mode in every file you create or modify in this PR, not only in the new ones." |
| "Match the existing style." | "Match the existing style in `src/services/`. The conventions are: PascalCase class names, camelCase methods, constructor injection, no facades." |

This is verbose. The compensation is precision: 4.8 does exactly what you asked.

## Subagent prompt failures

### "Based on your findings, fix the bug"

**The mistake.** Delegating synthesis the orchestrator owes.

**Why it fails.** The agent has less context than the orchestrator. It does not know the user's goals, cannot ask the user, and has not seen the previous turns of the conversation. The result is shallow generic work.

Source: https://docs.claude.com/en/docs/sub-agents.md > Writing prompts for subagents > Never delegate understanding.

**The fix.** Prove you understood. Include specifics.

| Anti-pattern | Pattern |
|---|---|
| "Based on your findings, fix the auth bug." | "In `src/auth/middleware.ts:42`, the JWT verification skips the `nbf` claim. Add a check that rejects tokens whose `nbf` is in the future. Update `src/auth/middleware.test.ts` to cover this case." |
| "Implement the feature based on the research." | "Add a `--dry-run` flag to `bin/migrate.ts`. When set, log every SQL statement without executing. Use the existing `Logger` interface in `src/logger.ts`." |
| "Decide what makes sense and do it." | (Do not delegate. Decide yourself, then write a specific prompt.) |

### Terse command-style subagent prompt

**The mistake.** "Audit the codebase for unused imports."

**Why it fails.** No context, no scope, no output shape. The agent guesses what "audit" means, what counts as "unused," what shape the report should be. The result is a generic walkthrough.

**The fix.** Brief like a colleague who just walked in.

```text
Audit `packages/*/src/**/*.ts` for unused exports (exported symbols with zero imports across the monorepo). Use ts-prune or write your own check. Return a list of `file_path:line_number` entries grouped by package. Under 500 words. If you cannot find unused exports with confidence, say so and explain what tooling you tried.
```

## Architecture failures

### Mixing instructions and data without delimiters

**The mistake.** Pasting a document and instructions in the same flat prose.

**Why it fails.** The model cannot reliably distinguish "process this" from "do this." Instructions inside the document leak into behavior.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Structure prompts with XML tags.

**The fix.** XML tags. Always.

```xml
<document>
{{the actual document, possibly containing prompt-injection-looking text}}
</document>

<task>
Summarize the document in three bullet points.
</task>
```

### Putting dynamic content in the system prompt

**The mistake.** Pasting today's input into the system prompt.

**Why it fails.** Prompt cache cannot amortize a system prompt that changes every request. You pay full token cost on every call.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md > Best practices.

**The fix.** Static in system, dynamic in user.

| Belongs in system | Belongs in user |
|---|---|
| Persona, tone, domain rules | Today's specific input |
| Schema, form structure, invariants | The current question |
| Few-shot examples | The document under review |

### Examples that all answer the same way

**The mistake.** Three examples that all output "yes."

**Why it fails.** The model pattern-matches on the coincidence and outputs "yes" by default. You taught it the wrong rule.

**The fix.** Diversify. Cover the full range of possible answers in proportion to the actual distribution.

### Long input below the question

**The mistake.** Putting a 50k-token document at the bottom of the user message, with the question above.

**Why it fails.** The model loses track of the question by the time it has read all the document. Quality drops up to 30 percent per Anthropic's published long-context guidance.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Long context prompting tips.

**The fix.** Long inputs at the very top of the user message, question at the bottom.

```xml
<documents>
  <document index="1">{{50k-token document}}</document>
</documents>

<task>
[The actual question, at the end of the user message]
</task>
```

## Output format failures

### Prefilling the last assistant turn

**The mistake.** Adding an assistant message with `{` to force JSON output.

**Why it fails.** Returns a 400 error on Claude 4.6 and later. Prefills on the last assistant turn are no longer supported.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Prefill removal.

**The fix.** Use Structured Outputs, tool calls with enums, or direct instruction:

```text
Return your response as JSON conforming to the schema provided. Do not wrap the JSON in markdown code fences, do not add explanatory text, return only the JSON object.
```

### Asking for "JSON" without specifying the schema

**The mistake.** "Return the result as JSON."

**Why it fails.** The model invents a schema. Different runs produce different schemas. Downstream parsing fails.

**The fix.** Define the schema explicitly. Either via the Structured Outputs API feature (https://docs.claude.com/en/docs/build-with-claude/structured-outputs.md) or by including a JSON schema definition in the prompt.

## Tool use failures

### "Default to using the search tool"

**The mistake.** Telling the model to always use a tool.

**Why it fails.** Overtriggering. The model uses the tool when reasoning would be faster.

**The fix.** Use targeted instructions.

| Anti-pattern | Pattern |
|---|---|
| "Default to using the search tool." | "Use the search tool when it would enhance your understanding of the problem." |
| "If in doubt, use the file-read tool." | "Use the file-read tool when the user references a file you have not opened." |

### Suggesting changes when you wanted edits

**The mistake.** "Can you suggest some changes to improve this function?"

**Why it fails.** The model takes "suggest" literally and gives a list of suggestions instead of editing.

**The fix.** Use action verbs.

| Anti-pattern | Pattern |
|---|---|
| "Can you suggest some changes?" | "Change this function to improve its performance." |
| "What would make this better?" | "Make these edits to the authentication flow:" |

## Thinking-parameter failures (model migration)

### `thinking: { type: "enabled", budget_tokens: N }` on Opus 4.8

**The mistake.** Using the legacy thinking-budget shape on a model that has moved to adaptive thinking.

**Why it fails.** Adaptive thinking replaces `budget_tokens`. The legacy shape is deprecated; on Opus 4.8 it is unsupported and returns a 400 error. Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migrating from Claude Opus 4.7 to Claude Opus 4.8.

**The fix.**

```python
thinking={"type": "adaptive"}
output_config={"effort": "high"}  # max, xhigh, high, medium, low
```

If you need to display thinking content in your UI, add `"display": "summarized"` on the thinking config.

### Using `output_format` instead of `output_config.format`

**The mistake.** Passing the old top-level `output_format={...}` parameter to force a response shape.

**Why it fails.** `output_format` is deprecated and will be removed. The supported parameter is `output_config.format` (`output_config={"format": {...}}` in Python, the equivalent shape in other SDKs).

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migrate `output_format` to `output_config.format`.

**The fix.** Move the format field into `output_config`.

```python
# old
client.messages.create(model="claude-opus-4-8", output_format={...}, ...)

# new
client.messages.create(model="claude-opus-4-8", output_config={"format": {...}}, ...)
```

### Carrying over `effort-2025-11-24` beta header

**The mistake.** Keeping `betas=["effort-2025-11-24"]` in requests after upgrading to Opus 4.8.

**Why it fails.** The effort parameter is GA. The beta header is a no-op on Opus 4.8 and is being phased out.

**The fix.** Drop the beta header. Use `client.messages.create` (not `client.beta.messages.create`).

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migration checklist > "Remove `effort-2025-11-24` beta header".

### Image-coordinate scale-factor math on Opus 4.8

**The mistake.** Multiplying pointing or bounding-box coordinates by a scale factor on the client.

**Why it fails.** On Opus 4.8, coordinates are 1:1 with actual image pixels (the convention since 4.7). The conversion was removed. Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Image coordinates.

**The fix.** Remove the client-side conversion. Use the raw coordinates.

## Code-style failures (Claude Code specific)

These come from the live Claude Code system prompt's "Doing tasks" section. Custom agents inherit them; restating them is noise.

### Adding compatibility shims

**The mistake.** Renaming an unused variable to `_var`, adding a `// removed` comment, re-exporting a deleted type.

**Why it fails.** Claude Code's default is to delete unused code completely. Compat shims accumulate cruft.

**The fix.** Delete unused code. If something might be used elsewhere, search first (`Grep`), confirm, then delete.

### Adding error handling for impossible scenarios

**The mistake.** Wrapping every function call in try/catch, validating that an internally-typed object has the field the type system already guarantees.

**Why it fails.** Trust internal code and framework guarantees. The error handling is dead code, makes the real error paths harder to find, and signals lack of confidence in the type system.

**The fix.** Validate only at system boundaries (user input, external APIs). Trust the type system everywhere else.

### Multi-paragraph docstrings on every function

**The mistake.** Verbose JSDoc/PHPDoc/Python docstrings on internal helpers.

**Why it fails.** Claude Code default is no comments unless the WHY is non-obvious. Long docstrings on simple helpers add noise.

**The fix.** One short line max. Only when the WHY is non-obvious.

## Behavioral failures

### Confirming once, assuming forever

**The mistake.** The user approved a `git push`, so the model pushes again next time without asking.

**Why it fails.** Authorization scope is exact. Approving one push does not authorize all future pushes.

**The fix.** Confirm each risky action separately, unless the user explicitly authorized the category in CLAUDE.md ("you may push to my own branches without asking").

### Using destructive shortcuts to clear obstacles

**The mistake.** A pre-commit hook fails, so the model uses `git commit --no-verify` to bypass it.

**Why it fails.** The hook exists for a reason. Bypassing it is a short-term win that creates long-term debt.

**The fix.** Investigate what the hook checks, fix the underlying issue. If the hook is wrong, ask the user before bypassing.

### Retrying denied tool calls verbatim

**The mistake.** A tool call is denied. The model retries the same call.

**Why it fails.** Denied = the user declined. Retrying ignores the signal.

**The fix.** Adjust the approach. If the denial is a permission issue, ask the user to authorize. If it is a logic issue (wrong file path, wrong command), fix the call.

## Migration failures (older models to current)

### Keeping anti-laziness scaffolding

**The mistake.** Old prompts had "after every 3 tool calls, summarize progress" or "if in doubt, search the codebase."

**Why it fails.** Modern Claude produces high-quality interim updates natively and triggers tools appropriately. The scaffolding causes overtriggering.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Progress updates.

**The fix.** Remove the scaffolding. Trust the defaults.

### Keeping aggressive tool-use language

**The mistake.** Old prompts had "CRITICAL: you MUST use the analysis tool" because earlier models undertriggered.

**Why it fails.** Modern Claude overtriggers on aggressive language.

**The fix.** Plain phrasing. "Use the analysis tool when..."

### Keeping prefill patterns

**The mistake.** Old code uses prefilled assistant messages to force output format.

**Why it fails.** Returns 400 on Claude 4.6 and later.

**The fix.** Migrate to Structured Outputs, tool calls, or direct instructions.

## Quick audit checklist

When reviewing an existing prompt:

- [ ] No "CRITICAL: MUST" or aggressive caps for emphasis.
- [ ] No negative-only instructions ("don't X" without "do Y").
- [ ] Scope is stated explicitly (modern Claude will not generalize).
- [ ] Static content in system, dynamic in user.
- [ ] Every distinct block is in named XML tags.
- [ ] Examples are diverse, not all giving the same answer.
- [ ] Long input is at the top of the user turn.
- [ ] No prefill on the last assistant turn.
- [ ] Output format is locked (Structured Outputs > tool > XML > prose).
- [ ] No "based on your findings, do X" in subagent prompts.
- [ ] No anti-laziness scaffolding from older models.
- [ ] No compat hacks, no impossible-scenario error handling, no multi-paragraph docstrings (CC defaults).
- [ ] Thinking parameter uses `adaptive` on Opus 4.8 / Sonnet 4.6 (manual `enabled` still works on Haiku 4.5 but is deprecated on Sonnet 4.6).
- [ ] No image-coordinate scale-factor conversion on Opus 4.8.
- [ ] Output format uses `output_config.format`, not deprecated `output_format`.
- [ ] No `effort-2025-11-24` beta header carried over (effort is GA).
- [ ] `client.messages.create`, not `client.beta.messages.create`.
