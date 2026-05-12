# Prompt Architecture

Structural rules for assembling a prompt. Read this when designing message structure, choosing XML tags, working with long-context inputs, or laying out examples.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Anthropic prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- Anthropic system prompts guide: https://docs.claude.com/en/docs/system-prompts.md
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md
- Anthropic extended thinking: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md
- Anthropic Structured Outputs: https://docs.claude.com/en/docs/build-with-claude/structured-outputs.md

## The 7-component message structure

Place components in this order. Skipping any is a choice, not a default.

| # | Component | Location | Why |
|---|---|---|---|
| 1 | Persona, role, tone | system | Frames the lens. Without it the model defaults to baseline assumptions and hallucinates. |
| 2 | Static rules, schema, invariants | system | Cacheable; never changes per request. Prompt cache amortizes the cost. |
| 3 | Few-shot examples | system | Format demonstrations the model needs before it sees dynamic input. |
| 4 | Dynamic content | user | Per-request data: documents, retrieved data, images. |
| 5 | Step-by-step instructions | user | The order in which to process the dynamic content. |
| 6 | End-of-prompt reminders | user (last lines) | Top 1 to 3 constraints, repeated immediately before generation. |
| 7 | Output format lock | user (last) or Structured Outputs | The shape of the response. |

Source: Anthropic prompt-engineering best practices > "Use XML tags", "Use examples effectively", "Long context prompting tips"; prompt-caching best practices (system cached before user content).

## Why this order

**System vs user.** Anything that does not change per request goes in system, so the prompt cache can amortize the tokens. Persona, schema, examples, invariants. Anything that changes per request goes in user. The document, the question, the file under review.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md > Best practices for prompt caching.

**Examples before dynamic content.** The model needs to see the format before seeing the input. If examples come after, the model reads the input first and may anchor on its content rather than the format.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Use examples effectively.

**Instructions before reminders.** Instructions describe how to process. Reminders re-state the most important constraints. Reminders sit at the end because recency matters: the last thing the model reads is what it weighs most before generating.

**Output format last.** Locking the shape at the end ensures the model commits to it during generation, not before.

## Reference architecture (JSON shape)

Use this as a blueprint when emitting a prompt for the Messages API.

```json
{
  "system": [
    { "type": "text", "text": "<role>You are an AI assistant helping a claims adjuster.</role>" },
    { "type": "text", "text": "<static_context>This form has 17 checkboxes. Vehicle A is left, Vehicle B is right.</static_context><examples>...</examples>", "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    {
      "role": "user",
      "content": "<input>...</input>\n<instructions>1. Examine form. 2. Examine sketch.</instructions>\n<reminders>Cite the specific checkbox for every claim.</reminders>\n<output_format>Output inside <final_verdict> tags.</output_format>"
    }
  ]
}
```

Splitting the system field into two blocks lets the second block carry the `cache_control` marker. Source: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md > Structuring your cached prompt.

## XML tags as delimiters

Claude is fine-tuned to parse XML. Tag boundaries are the only reliable way to separate instructions from data, especially when the data itself contains markdown, code, or other prompts.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Structure prompts with XML tags.

**Rules.**

1. Use descriptive, consistent names. `<accident_form>` and `<patient_records>`, not `<data>` and `<info>`.
2. Nest when content has natural hierarchy: `<documents>` containing `<document index="1">` containing `<source>` and `<document_content>`.
3. Use the same tag names across prompts in the same project. The model picks up the project-wide convention.
4. When asking for output in a tag, name the tag in the instruction: "Place your analysis in `<analysis>` tags."

**Naming conventions that work.**

| Block | Suggested tag |
|---|---|
| Persona | `<role>` |
| Domain rules | `<context>` or `<static_context>` |
| Schema or structure description | `<schema>`, `<form_structure>` |
| Examples wrapper | `<examples>` |
| Single example | `<example>` |
| Example input | `<input>` |
| Expected output | `<expected_output>` |
| Reasoning trace inside an example | `<reasoning>` or `<thinking>` |
| Per-request input | `<input>`, `<question>`, `<document>` |
| Step list | `<instructions>` or `<steps>` |
| Final reminders | `<reminders>` or `<guidelines>` |
| Output format lock | `<output_format>` |
| Final answer wrapper | `<final_verdict>`, `<answer>`, `<analysis>` |

**Reserved tag names inside Claude Code.** Claude Code's harness injects several XML-tagged wrappers into the conversation. Avoid colliding with them in your prompts; the harness loader treats them as system signals, not user content.

| Tag | Purpose (from CC harness) |
|---|---|
| `<system-reminder>` | Harness-injected reminders. Treat as system signal; do not respond as if the user said it. |
| `<command-name>`, `<command-message>`, `<command-args>` | Slash command metadata wrapper. |
| `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` | Terminal output wrappers, NOT user prompts. |
| `<local-command-stdout>`, `<local-command-stderr>`, `<local-command-caveat>` | Local command execution wrappers. |
| `<task-notification>`, `<task-id>`, `<task-type>` | Background task completion notifications. |
| `<fork-boilerplate>`, `<teammate-message>`, `<channel-message>`, `<cross-session-message>` | Multi-agent and cross-session communication. |

For the harness-level details (how these tags are emitted and consumed), see Anthropic's hooks and subagents documentation: https://docs.claude.com/en/docs/hooks.md and https://docs.claude.com/en/docs/sub-agents.md.

## Few-shot examples

Examples are the highest-leverage tool for any task with judgment. Three to five labeled examples beat any abstract instruction.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Use examples effectively.

**Make them.**

- **Relevant.** Mirror the actual use case closely. Off-distribution examples teach off-distribution behavior.
- **Diverse.** Cover edge cases. Vary structure enough that the model cannot pattern-match on a coincidence (e.g., do not have all examples answer "yes" if the real distribution is balanced).
- **Structured.** Wrap each example in `<example>` tags inside an `<examples>` parent. Let the model distinguish examples from instructions.

**Format.**

```xml
<examples>
  <example>
    <input>
      Patient reports headache, light sensitivity, nausea for 2 days.
    </input>
    <reasoning>
      Headache plus photophobia plus nausea is classic migraine. No fever rules out viral. Duration matches typical migraine episode.
    </reasoning>
    <expected_output>
      Likely migraine. Recommend symptom diary, hydration, OTC analgesic. Refer if symptoms persist over 3 days or new neurological signs.
    </expected_output>
  </example>
  <example>
    <input>
      Patient reports sudden severe headache, "worst of my life," with neck stiffness.
    </input>
    <reasoning>
      "Thunderclap" headache plus meningismus is a red flag for subarachnoid hemorrhage. Cannot be triaged remotely.
    </reasoning>
    <expected_output>
      Refer to ED immediately. Do not delay for further history.
    </expected_output>
  </example>
  <!-- 1 to 3 more, including a "negative" case where the right answer is "do nothing" -->
</examples>
```

**Reasoning traces inside examples.** Including `<reasoning>` shows the chain of thought you want. With adaptive thinking enabled, the model will generalize that style to its own thinking blocks.

Source: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md > Best practices > Multishot examples with thinking.

## Long-context (above 20k tokens)

When the input is long, the layout inside the user turn changes.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Long context prompting tips.

**Rules for long-context.**

1. **Long documents at the very top of the user turn.** Above the query, instructions, and examples in the user message. Quality improves up to 30 percent on multi-document tasks per Anthropic's published guidance.
2. **Wrap each document in metadata tags.** Use `<document>` containing `<source>` and `<document_content>`.
3. **Ground responses in quotes.** Ask the model to extract relevant quotes first, then answer based on those quotes. This cuts through noise.

**Multi-document structure.**

```xml
<documents>
  <document index="1">
    <source>annual_report_2023.pdf</source>
    <document_content>
      {{ANNUAL_REPORT}}
    </document_content>
  </document>
  <document index="2">
    <source>competitor_analysis_q2.xlsx</source>
    <document_content>
      {{COMPETITOR_ANALYSIS}}
    </document_content>
  </document>
</documents>

<task>
Analyze the annual report and competitor analysis. Identify strategic advantages and recommend Q3 focus areas.
</task>
```

**Quote-grounded answer pattern.**

```xml
<documents>
  <document index="1"><source>patient_records.txt</source><document_content>{{RECORDS}}</document_content></document>
</documents>

<task>
Find quotes from the patient records that are relevant to diagnosing the patient's reported symptoms. Place these in <quotes> tags. Then, based on these quotes, list all information that would help the doctor diagnose the patient's symptoms. Place your diagnostic information in <info> tags.
</task>
```

The two-step output (quotes first, conclusion second) reduces hallucination because the model anchors on actual document content. Source: Anthropic prompt-engineering best practices > Reduce hallucinations.

## Output formatting

Lock the output shape. Four tools available, in order of strength:

1. **Structured Outputs.** Define a JSON schema; the model conforms. Use for classification, extraction, any structured data. Replaces prefill on Claude 4.6+. Source: https://docs.claude.com/en/docs/build-with-claude/structured-outputs.md.
2. **Tool call with enum.** For classification, define a tool whose only param is an enum of valid labels. The model has to pick one.
3. **XML tag wrapping.** Tell the model to put the answer in `<answer>` tags. Easy to parse.
4. **Direct instruction.** "Respond in plain text only, no markdown." Works most of the time, easiest to specify.

**Tell the model what to do, not what to avoid.**

| Less effective | More effective |
|---|---|
| "Do not use markdown in your response." | "Your response should be smoothly flowing prose paragraphs." |
| "Avoid bullet points." | "Write the response in `<smoothly_flowing_prose_paragraphs>` tags." |

Source: Anthropic prompt-engineering best practices > Be clear and direct.

**Match prompt style to desired output.** If you want plain text out, write the prompt in plain text. Removing markdown from your prompt reduces markdown in the output.

**LaTeX in math output.** Some Claude versions default to LaTeX for math. To force plain text:

```text
Format your response in plain text only. Do not use LaTeX, MathJax, or any markup notation such as \( \), $, or \frac{}{}. Write all math expressions using standard text characters (e.g., "/" for division, "*" for multiplication, and "^" for exponents).
```

## Sequential instructions

For multi-step tasks, use numbered lists when the order or completeness matters. The model executes in the order written.

Source: https://docs.claude.com/en/docs/system-prompts.md > Use numbered lists or bullet points to define sequential steps.

**Pattern: structured first, ambiguous second.**

```text
1. FIRST, read the structured form and note the checked boxes (e.g., Vehicle A is box 1, Vehicle B is box 12).
2. THEN, use that factual baseline to interpret the messy hand-drawn sketch.
3. FINALLY, write your verdict citing both the form (by box number) and the sketch (by region).
```

Without ordering, the model may anchor on the ambiguous input first, propagating errors into the structured analysis.

## Role prompting

A role focuses behavior and tone. Even one sentence makes a difference.

Source: https://docs.claude.com/en/docs/system-prompts.md > Give Claude a role.

**Less effective:**

```text
Answer the user's question.
```

**More effective:**

```text
You are a helpful coding assistant specializing in Python. You write clean, idiomatic code with type hints. When asked a question, you start with a one-line answer, then expand only if needed.
```

Specificity beats length.

## Adding context to instructions

Explaining why a rule exists helps the model generalize correctly to edge cases.

**Less effective:**

```text
NEVER use ellipses.
```

**More effective:**

```text
Your response will be read aloud by a text-to-speech engine, so never use ellipses since the text-to-speech engine will not know how to pronounce them.
```

Source: Anthropic prompt-engineering best practices > Be clear and direct > Provide context. The model is smart enough to generalize from the explanation; it will also avoid related markup (em dashes, asides) once it understands the underlying constraint.

## Self-check pattern

For coding and math, ask the model to verify its own answer before finishing:

```text
Before you finish, verify your answer against [test criteria]. If verification fails, revise the answer and verify again. Only return when verification passes.
```

This catches errors reliably. The verification clause must be specific (test cases, invariants, expected output shape), not "double-check it." Source: Anthropic prompt-engineering best practices > Ask Claude to self-check.

## Prompt chaining

With adaptive thinking and subagent orchestration, most multi-step reasoning happens internally. Explicit chaining (multiple API calls) is still useful when:

- You need to inspect intermediate output before the next step.
- You need to enforce a specific pipeline structure.
- You need to log, evaluate, or branch at a specific decision point.

**Self-correction chain.** Generate a draft, review it against criteria, refine. Three API calls:

1. Generate the draft.
2. Review the draft against explicit criteria, output a list of issues.
3. Take the draft and the issues, produce the final version.

This pattern is more reliable than asking for "draft and self-review in one response." Source: Anthropic prompt-engineering best practices > Chain complex prompts.

## Caching boundaries inside the architecture

Prompt caching turns the architecture into a money-and-latency lever. Cacheable boundaries:

| Boundary | Up to N markers | Typical content |
|---|---|---|
| System prompt block 1 | 1 | Persona, top-level rules (short, always cached) |
| System prompt block 2 | 1 | Schema, examples, long static context |
| User turn before per-request data | 1 | Repeated tool definitions or scaffolding |
| Conversation history through last assistant turn | 1 | Long multi-turn agentic loops |

The API supports up to 4 ephemeral cache breakpoints. A cache hit requires the prefix to be byte-identical across requests; any change before the marker invalidates the cache. Thinking parameters are part of the cache key.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md > Cache breakpoints and invalidation.

## Quick checklist for architecture

- [ ] Persona, domain, tone in system prompt.
- [ ] Static rules and examples in system, dynamic input in user.
- [ ] Every block wrapped in named XML tags.
- [ ] 3 to 5 examples covering edge cases, inside `<examples>` parent.
- [ ] Long input (above 20k tokens) at the top of the user turn.
- [ ] Step-by-step instructions force structured-first ordering.
- [ ] Top constraints repeated as `<reminders>` at the end.
- [ ] Output format locked (Structured Outputs > tool call > XML tag > prose).
- [ ] Positive instructions ("do this") not negative ("do not do that").
- [ ] Scope stated explicitly (Claude 4.7 will not generalize).
- [ ] No tag-name collisions with the CC reserved tags listed above.
- [ ] Cache breakpoints placed at stable boundaries (system block, conversation history).
