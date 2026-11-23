# Anti-Patterns

Common prompt-writing failures, the why, and the fix. Read this when auditing an existing prompt or debugging a prompt that produces wrong output.

Primary sources (raw markdown via the `.md` suffix on `platform.claude.com` for API docs and `code.claude.com` for Claude Code docs):

- Anthropic prompt engineering best practices: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- Per-model prompting pages: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5.md (and the `sonnet-5-5` and `haiku-5-5` siblings); effort: https://platform.claude.com/docs/en/build-with-claude/effort.md; structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md
- System prompts guide: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md#give-claude-a-role
- Subagents page: https://code.claude.com/docs/en/sub-agents.md
- Extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md

## Aggressive language

### "CRITICAL: you MUST..."

**The mistake.** Writing CRITICAL, MUST, NEVER, ALWAYS in caps to make a rule stick.

**Why it fails.** Modern Claude follows aggressive language too literally. "CRITICAL: you MUST use this tool when researching" causes overtriggering; the model uses the tool even when reasoning would be faster.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Tool usage, and Migration considerations item 6 (tune anti-laziness prompting: the newer models "might overtrigger on instructions that were needed for previous models").

**The fix.** Plain instruction.

| Anti-pattern | Pattern |
|---|---|
| "CRITICAL: you MUST use the search tool when..." | "Use the search tool when..." |
| "ALWAYS write tests before code." | "Write tests before code." |
| "NEVER skip the validation step." | "Validate before processing." |

The model is smart enough. Aggressive language signals "this might not be true" and causes weird compliance behaviors. Caps inside an ordinary sentence do the same at a smaller scale, so reserve them for the genuinely critical (one or two phrases per prompt, max).

### Anti-laziness scaffolding written for older models

**The mistake.** Prompts carry "after every 3 tool calls, summarize progress" or "if in doubt, search the codebase."

**Why it fails.** Current models are proactive: they write good interim updates natively and trigger tools appropriately. Blanket "always use the tool" lines overtrigger.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5.md > User-facing progress updates ("remove older instructions such as 'hold all findings for the final response'"), and the best-practices Migration considerations item 6.

**The fix.** Remove the scaffolding. Trust the defaults.

## Negative-only instructions

### "Do not be verbose"

**The mistake.** Telling the model what not to do without showing what to do.

**Why it fails.** The model has to imagine the wrong behavior first, then suppress it. The imagined behavior leaks into the output.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Be clear and direct.

**The fix.** Positive instruction or positive example.

| Anti-pattern | Pattern |
|---|---|
| "Do not be verbose." | "Provide concise, focused responses. Skip non-essential context, and keep examples minimal." |

Copy-paste forms: `snippets.md`, Verbosity and length.

## Vague scope

### "Make this consistent"

**The mistake.** Asking for a generalization without saying what to generalize over.

**Why it fails.** Claude does better with clear, explicit instructions and does not reliably infer more than the task strictly requires, so it may not generalize from the example you showed to other things in the file.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Be clear and direct.

**The fix.** State scope explicitly.

| Anti-pattern | Pattern |
|---|---|
| "Make the formatting consistent." | "Apply the formatting in the first example to every section heading in the file, not just the first one." |
| "Use TypeScript strict mode." | "Use TypeScript strict mode in every file you create or modify in this PR, not only in the new ones." |
| "Match the existing style." | "Match the existing style in `src/services/`. The conventions are: PascalCase class names, camelCase methods, constructor injection, no facades." |

This is verbose. The compensation is precision: the model does exactly what you asked.

The mirror-image failure is leaving the scope's upper bound unstated. Some 5.5 models add work nobody asked for (the Sonnet 5.5 card documents it), so state the upper bound: "Change only the files listed. If you find an adjacent problem, report it in one line; do not fix it here."

## Subagent prompt failures

### "Based on your findings, fix the bug"

**The mistake.** Delegating synthesis the orchestrator owes. The agent has less context, cannot ask the user, and returns shallow generic work.

**The fix.** Prove you understood. Replace "Based on your findings, fix the auth bug." with "In `src/auth/middleware.ts:42`, JWT verification skips the `nbf` claim. Reject tokens whose `nbf` is in the future and cover it in `src/auth/middleware.test.ts`."

Source: https://code.claude.com/docs/en/sub-agents.md > Writing prompts for subagents > Never delegate understanding.

### Terse command-style subagent prompt

**The mistake.** "Audit the codebase for unused imports." No context, no scope, no output shape, so the agent guesses and returns a generic walkthrough.

**The fix.** Brief like a colleague who just walked in: "Audit `packages/*/src/**/*.ts` for unused exports (zero imports across the monorepo). Return `file_path:line_number` entries grouped by package, under 500 words. If you cannot find them with confidence, say what tooling you tried."

Full treatment and worked briefs: `subagent-prompts.md`.

## Architecture failures

### Mixing instructions and data without delimiters

**The mistake.** A document and the instructions pasted in the same flat prose; instructions inside the document leak into behavior.

**The fix.** Wrap each block in named XML tags (`<document>`, `<task>`). Details: `architecture.md`.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Structure prompts with XML tags.

### Putting dynamic content in the system prompt

**The mistake.** Pasting today's input into the system prompt. The prompt cache cannot amortize a system prompt that changes every request.

**The fix.** Static in system (persona, rules, schema, few-shot examples), dynamic in user (today's input, the current question, the document under review). Details: `architecture.md`.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md > Best practices.

### Examples that all answer the same way

**The mistake.** Three examples that all output "yes"; the model pattern-matches on the coincidence and answers "yes" by default.

**The fix.** Diversify the examples across the full range of answers, in proportion to the actual distribution. Details: `architecture.md`.

### Long input below the question

**The mistake.** A long document placed after the question or instructions in the user message.

**The fix.** Long input at the very top of the user message, the query at the end. Anthropic reports that queries at the end can improve response quality by up to 30 percent in tests, especially on multi-document inputs. Details: `architecture.md`.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Long context prompting.

## Output format failures

### Prefilling the last assistant turn

**The mistake.** Adding an assistant message with `{` to force JSON output.

**Why it fails.** Returns a 400 error on Claude 4.6 and later. Prefills on the last assistant turn are no longer supported.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Migrating away from prefilled responses.

**The fix.** Use Structured Outputs, tool calls with enums, or direct instruction:

```text
Return your response as JSON conforming to the schema provided. Do not wrap the JSON in markdown code fences, do not add explanatory text, return only the JSON object.
```

### Asking for "JSON" without specifying the schema

**The mistake.** "Return the result as JSON."

**Why it fails.** The model invents a schema. Different runs produce different schemas. Downstream parsing fails.

**The fix.** Define the schema explicitly. Either via the Structured Outputs API feature (https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md) or by including a JSON schema definition in the prompt.

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

## Thinking and effort failures

### Legacy thinking shape, reasoning in the reply, copied effort labels

**The mistake.** Sending `thinking: {type: "enabled", budget_tokens: N}`, asking the model to write its reasoning into the reply, or copying an effort label from one model to another.

**Why it fails.** Adaptive thinking replaced `budget_tokens`, and each model reacts to effort differently.

**The fix.** Omit `thinking` or send `adaptive`; set effort by measurement; do not ask for reasoning in the reply. Per-model shapes: `claude-models.md` and the three cards.

### Using `output_format` instead of `output_config.format`

**The mistake.** Passing the old top-level `output_format={...}` parameter to force a response shape.

**Why it fails.** `output_format` is deprecated and will be removed. The supported parameter is `output_config.format` (`output_config={"format": {...}}` in Python, the equivalent shape in other SDKs).

Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md ("The request carries the schema in `output_config.format` with `type: "json_schema"`").

**The fix.** Move the format field into `output_config`.

```python
# old
client.messages.create(model="claude-opus-5-5", output_format={...}, ...)

# new
client.messages.create(model="claude-opus-5-5", output_config={"format": {...}}, ...)
```

### Carrying over `effort-2025-11-24` beta header

**The mistake.** Keeping `betas=["effort-2025-11-24"]` in requests after upgrading to a current model.

**Why it fails.** The current effort page documents `output_config.effort` with no beta header, so the header does nothing useful and ties the request to the beta client.

**The fix.** Drop the beta header. Use `client.messages.create` (not `client.beta.messages.create`) unless you use another beta feature.

Source: https://platform.claude.com/docs/en/build-with-claude/effort.md > Set the effort level.

## Claude Code host-rule failures

These come from the CLASSIC Claude Code system prompt and from Anthropic's coding-agent guidance. The 5.5 models (LEAN shape) and every custom subagent do not receive the CLASSIC text, so state the ones a prompt needs.

- Compatibility shims (`_var` renames, `// removed` markers, re-exports): delete unused code after a search.
- Error handling for impossible scenarios: validate only at system boundaries.
- Multi-paragraph docstrings on internal helpers: one short line, only when the why is non-obvious.
- Confirming once, assuming forever: confirm each risky action unless CLAUDE.md authorizes the category.
- Destructive shortcuts to clear obstacles (`--no-verify`): fix the cause, ask before bypassing.
- Retrying a denied tool call verbatim: change the approach or ask for authorization.

Verbatim host text and rules: `claude-code-conventions.md`.

## Checklists

- The canonical pre-flight checklist is in `SKILL.md`, one directory up.
- The per-model checklists are at the end of `claude-models.md` and at the end of each card.
- The subagent and Claude Code checklists sit at the end of `subagent-prompts.md` and `claude-code-conventions.md`.
