# Snippets

Categorized copy-paste snippets, distilled from Anthropic's prompt-engineering guidance. Use as building blocks. Adapt to the specific case; do not paste verbatim without thinking.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- System prompts guide: https://docs.claude.com/en/docs/system-prompts.md
- Extended thinking: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md
- Prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching.md
- Context compaction: https://docs.claude.com/en/docs/build-with-claude/compaction.md
- Migration guide (4.7 behavior changes): https://docs.claude.com/en/docs/about-claude/models/migration-guide.md

## Verbosity and length

### Reduce verbosity

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

### Force a length cap

```text
Respond in under 150 words. If the answer would be longer, lead with a 3-sentence executive summary and put details in a `<details>` tag.
```

### Increase tool-use visibility

```text
After completing a task that involves tool use, provide a quick summary of the work you have done. One sentence per tool call.
```

## Effort and thinking

### Reduce thinking when system prompts are large

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality, typically for problems that require multi-step reasoning. When in doubt, respond directly.
```

### Force step-by-step reasoning at low effort

```text
This task involves multi-step reasoning. Think carefully through the problem before responding. Use a `<thinking>` tag to lay out your reasoning, then an `<answer>` tag for the final response.
```

### Self-check pattern

```text
Before you finish, verify your answer against the following criteria:
- [criterion 1, e.g., "the function compiles with TypeScript strict mode"]
- [criterion 2, e.g., "no test in tests/ is removed or skipped"]
- [criterion 3, e.g., "the public API in index.ts is unchanged"]

If verification fails, revise and verify again. Only return when all criteria pass.
```

### Commit to one approach

```text
When deciding how to approach a problem, choose an approach and commit to it. Avoid revisiting decisions unless you encounter new information that directly contradicts your reasoning. If you are weighing two approaches, pick one and see it through. You can always course-correct later if the chosen approach fails.
```

## Action defaults

### Default to action (proactive)

```text
<default_to_action>
By default, implement changes rather than only suggesting them. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing. Try to infer the user's intent about whether a tool call (e.g., file edit or read) is intended or not, and act accordingly.
</default_to_action>
```

### Default to caution (conservative)

```text
<do_not_act_before_instructions>
Do not jump into implementation or change files unless clearly instructed to make changes. When the user's intent is ambiguous, default to providing information, doing research, and providing recommendations rather than taking action. Only proceed with edits, modifications, or implementations when the user explicitly requests them.
</do_not_act_before_instructions>
```

### Reversibility gate (autonomous agents)

```text
Consider the reversibility and potential impact of your actions. You are encouraged to take local, reversible actions like editing files or running tests, but for actions that are hard to reverse, affect shared systems, or could be destructive, ask the user before proceeding.

Examples of actions that warrant confirmation:
- Destructive: deleting files or branches, dropping database tables, rm -rf
- Hard to reverse: git push --force, git reset --hard, amending published commits
- Visible to others: pushing code, commenting on PRs/issues, sending messages, modifying shared infrastructure

When encountering obstacles, do not use destructive actions as a shortcut. For example, do not bypass safety checks (e.g. --no-verify) or discard unfamiliar files that may be in-progress work.
```

## Tool use

### Maximize parallel tool calls

```text
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>
```

### Reduce parallel execution (when stability matters)

```text
Execute operations sequentially with brief pauses between each step to ensure stability.
```

### Prefer dedicated tools over shell commands

```text
Prefer the dedicated file/search tools (Read, Edit, Write, Grep, Glob) over shell commands when one fits. Bash is for shell-only operations, not for reading files (use Read), searching content (use Grep), or finding files by name pattern (use Glob).
```

## Hallucination control

### Investigate before answering (coding)

```text
<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file, read the file before answering. Investigate and read relevant files BEFORE answering questions about the codebase. Never make claims about code before investigating unless you are certain of the correct answer; give grounded and hallucination-free answers.
</investigate_before_answering>
```

### Cite the source for every claim

```text
For every factual claim you make, cite the specific source: a `file_path:line_number` for code, a document tag for retrieved data, or "general knowledge" for things not in the input. Do not invent details.
```

### Quote-grounded long-document answer

```text
First, find quotes from the documents that are relevant to the question. Place these in `<quotes>` tags, one per quote, with the source document. Then, based on those quotes, answer the question. Place your answer in `<answer>` tags. Do not use information that is not in the quotes.
```

## Output format

### Lock output to JSON via Structured Outputs

Configure on the API side via Structured Outputs. In the prompt:

```text
Return your response as JSON conforming to the schema provided. Do not wrap the JSON in markdown code fences, do not add explanatory text, return only the JSON object.
```

### Lock output to XML tags

```text
Place your final answer inside `<final_answer>` tags. Do not include any text outside the tags.
```

### Eliminate preamble

```text
Respond directly without preamble. Do not start with phrases like "Here is...", "Based on...", "I'll...", "Let me...". Begin with the actual content.
```

### Minimize markdown

```text
<avoid_excessive_markdown_and_bullet_points>
When writing reports, documents, technical explanations, analyses, or any long-form content, write in clear, flowing prose using complete paragraphs and sentences. Use standard paragraph breaks for organization and reserve markdown primarily for `inline code`, code blocks, and simple headings (### only). Avoid using **bold** and *italics*.

Do not use ordered lists (1. ...) or unordered lists (*) unless: a) you are presenting truly discrete items where a list format is the best option, or b) the user explicitly requests a list or ranking.

Instead of listing items with bullets or numbers, incorporate them naturally into sentences. Avoid outputting a series of overly short bullet points. The goal is readable, flowing text that guides the reader naturally through ideas rather than fragmenting information into isolated points.
</avoid_excessive_markdown_and_bullet_points>
```

### Force plain text math (no LaTeX)

```text
Format your response in plain text only. Do not use LaTeX, MathJax, or any markup notation such as \( \), $, or \frac{}{}. Write all math expressions using standard text characters: "/" for division, "*" for multiplication, "^" for exponents.
```

## Subagent control

### Steer subagent spawning toward fan-out

```text
Use subagents when tasks can run in parallel, require isolated context, or involve independent workstreams that do not need to share state. Spawn multiple subagents in the same turn when fanning out across items or reading multiple files.

Do not spawn a subagent for work you can complete directly in a single response (e.g., refactoring a function you can already see, or running a single command).
```

### Reduce subagent overuse

```text
Work directly rather than delegating to subagents for: simple tasks, sequential operations, single-file edits, or tasks where you need to maintain context across steps. Reserve subagents for parallel fan-out or work that produces large output you do not want in your context.
```

## Code review

### Coverage-first

```text
Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage; a separate verification step will do that. Your goal here is coverage: it is better to surface a finding that later gets filtered out than to silently drop a real bug.

For each finding, include:
- `file_path:line_number`
- a one-sentence description of the issue
- your confidence level (low / medium / high)
- estimated severity (nit / minor / major / critical)
- the suggested fix
```

### Single-pass with explicit bar (when no separate filter step exists)

```text
Report any bugs that could cause incorrect behavior, a test failure, or a misleading result. Only omit nits like pure style or naming preferences.

For each finding, include `file_path:line_number` and a one-sentence fix.
```

## Long-horizon agents

### Context awareness (work indefinitely)

```text
Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely from where you left off. Do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress and state to memory before the context window refreshes. Always be as persistent and autonomous as possible and complete tasks fully, even if the end of your budget is approaching. Never artificially stop any task early regardless of the context remaining.
```

Source: https://docs.claude.com/en/docs/build-with-claude/compaction.md > Context awareness pattern.

### Multi-context-window state pattern

```text
For this multi-session task, maintain state in two files:
- `tests.json`: structured test status (id, name, status: passing | failing | not_started)
- `progress.txt`: freeform notes on what was done this session and what is next

It is unacceptable to remove or edit tests because this could lead to missing functionality. Add new tests rather than modifying existing ones.

When starting a fresh context window, first read `progress.txt` and `tests.json` and the recent git logs before doing any new work.
```

### Use git as state tracker

```text
Use git as your primary state tracking mechanism. Commit early and often with descriptive messages. Each commit is a checkpoint that can be restored. When recovering from a fresh context window, run `git log --oneline -20` first to understand recent state.
```

## Frontend

### Escape default house style

```text
<frontend_aesthetics>
Pick a font family that is not Inter, Roboto, Arial, or a system default. Pick a color scheme that is not a purple gradient on white or dark. Pick a layout that has at least one signature element (an unusual grid, an asymmetric hero, a custom motion treatment). Use micro-interaction animations on hover and focus states. Build around one specific brand prior (a single reference site, a stated mood word, or three palette anchors) rather than a generic minimalist baseline.
</frontend_aesthetics>
```

### Propose-then-pick (forces variety)

```text
Before building, propose 4 distinct visual directions tailored to this brief. For each, give:
- background hex
- accent hex
- typeface name
- one-line rationale

Ask the user to pick one, then implement only that direction.
```

### Detailed design brief (concrete spec)

```text
Color palette: [#hex1, #hex2, #hex3, #hex4, #hex5]
Typography: [exact typeface name and weight], [letter spacing], [headline size]
Layout: [sections in order], [max-width container], [corner radius], [margin scale]
Motion: [transition duration], [easing], [which elements animate]
```

## Research and information gathering

### Structured research approach

```text
Search for this information in a structured way. As you gather data, develop several competing hypotheses. Track your confidence levels in your progress notes to improve calibration. Regularly self-critique your approach and plan. Update a hypothesis tree or research notes file to persist information and provide transparency. Break down this complex research task systematically.
```

## Identity

### Specify model identity

```text
The assistant is Claude, created by Anthropic. The current model is Claude Opus 4.8. The exact model string is `claude-opus-4-8`. When asked, identify yourself as Claude Opus 4.8.
```

### Specify model string for downstream calls

```text
When an LLM is needed for a downstream call, default to Claude Opus 4.8 unless the user requests otherwise. The exact model string for Claude Opus 4.8 is `claude-opus-4-8`. Sonnet companion: `claude-sonnet-4-6`. Haiku companion: `claude-haiku-4-5-20251001`.
```

Source: https://docs.claude.com/en/docs/models-overview.md (latest-models comparison table for IDs).

## Tone

### Warm tone

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering. Avoid clipped or curt phrasing. Be encouraging without being sycophantic.
```

### Direct tone

```text
Use a direct, efficient tone. Skip pleasantries, lead with the answer. Acknowledge edge cases briefly, do not hedge.
```

## Engineering scope

### Minimize over-engineering

```text
Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused:

- Scope: do not add features, refactor code, or make "improvements" beyond what was asked. A bug fix does not need surrounding code cleaned up. A simple feature does not need extra configurability.
- Documentation: do not add docstrings, comments, or type annotations to code you did not change. Only add comments where the logic is not self-evident.
- Defensive coding: do not add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
- Abstractions: do not create helpers, utilities, or abstractions for one-time operations. Do not design for hypothetical future requirements. The right amount of complexity is the minimum needed for the current task.
```

### General-purpose over test-passing

```text
Write a high-quality, general-purpose solution using the standard tools available. Do not create helper scripts or workarounds to accomplish the task more efficiently. Implement a solution that works correctly for all valid inputs, not just the test cases. Do not hard-code values or create solutions that only work for specific test inputs. Implement the actual logic that solves the problem generally.

Tests are there to verify correctness, not to define the solution. If the task is unreasonable or infeasible, or if any of the tests are incorrect, please inform me rather than working around them.
```

### Clean up temporary files

```text
If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task.
```

## Compose patterns

Snippets compose. The most useful prompts combine 2 to 4 of the above. Examples:

**A coding agent with low hallucination, parallel tools, action-by-default:**

```text
[role]
[investigate-before-answering snippet]
[parallel-tool-calls snippet]
[default-to-action snippet]
[reversibility gate snippet]
[over-engineering snippet]
```

**A code reviewer:**

```text
[role: senior reviewer]
[coverage-first snippet]
[output format: list of findings with file_path:line_number]
[minimize markdown snippet]
```

**A research agent:**

```text
[role: research analyst]
[structured research approach snippet]
[quote-grounded long-document answer snippet]
[length cap]
```

Mix them to fit the task. Each snippet is a building block, not a finished prompt.
