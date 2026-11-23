# Gemini 4 Neon Tuning

What changes when the model that will run the prompt is `gemini-4-neon` (released 2026-11-18, between Gemini 4 Hydrogen and Carbon). It builds on `gemini-tuning.md`: the delimiter, placement, tone, reasoning and few-shot rows there still hold, and this file wins where the two differ. Google documents one Gemini 4 API design for Neon, Hydrogen, Carbon and Argon, so the API rows below (sampling, tools, pre-tool text, turn state, caching) hold for all four; the thinking levels, output hop and tool-loop advice differ for Carbon and Argon (see `gemini-model-cards.md`), and the failure modes, the picking guidance and the Orchestrator defaults are Neon's. The evidence is thinner than for the Claude files, so each claim carries a label: **Doc** (a Google page written for Gemini 4), **Carried** (Google guidance written for Gemini 3 and not restated for 4), **Reported** (a third-party firsthand report) and **Inference** (this skill's reading). Say which labels a prompt rests on when you report it.

Primary sources, all fetched 2026-11-23 (the `ai.google.dev` pages redirect to `aistudio.google.com`, whose `.md` copies carry the text):

- What's new in Gemini 4 Neon: https://ai.google.dev/gemini-api/docs/whats-new-gemini-4-neon
- Thinking: https://aistudio.google.com/docs/thinking.md
- Function calling, section "Workarounds for pre-tool text requirements": https://aistudio.google.com/docs/function-calling.md
- Prompt design strategies: https://aistudio.google.com/docs/prompting-strategies.md
- Cloud developer guide for Neon: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon
- Antigravity: https://antigravity.google/docs/models, https://antigravity.google/docs/rules, https://antigravity.google/docs/skills, and the launch post https://antigravity.google/blog/gemini-4-neon-in-google-antigravity/
- `gemini-api-dev` skill: https://github.com/google-gemini/gemini-skills/blob/c4d0c62c1240e08a90546186bf320600ab6a039a/skills/gemini-api-dev/SKILL.md
- Gemini CLI at commit `eecccfc`: `README.md#L15-L16`, `packages/core/src/prompts/promptProvider.ts#L81-L82`, `packages/core/src/config/models.ts#L646-L649` (https://github.com/google-gemini/gemini-cli/tree/eecccfcd5aff25de5e78135ca20f7abe3f566955)
- Firsthand reports: https://github.com/anomalyco/opencode/issues/65277, https://github.com/anomalyco/opencode/issues/65444 and https://flaviocopes.com/gemini-4-neon/

Not verified: any Neon-specific prompting guide (Google published none: `llms.txt` lists no Gemini 4 prompting page, and the Carbon developer guide at `aistudio.google.com/learn/gemini-4-carbon-developer-guide` returned "Page not found" on 2026-11-23), the Orchestrator planner and executor prompts (not public), and Neon's default verbosity.

## What Google has not published

- **No Gemini 4 prompting guide.** The prompt design page has one Gemini 4 line (sampling is ignored); its model advice is headed Gemini 3. **Doc**
- **No Neon system prompt.** The Antigravity extractions on GitHub are unofficial and run up to Argon, not Neon. The Orchestrator prompts are not public.
- **Gemini CLI is not a Neon source.** Its README says it is not tuned for Gemini 4, and its code picks the modern prompt only for `gemini-3*` ids and non-Gemini ids, so a `gemini-4-neon` id falls to the legacy prompt (Inference, read from the code and not run). The "How Google writes Gemini agent prompts" table in `gemini-tuning.md` describes a Gemini 3 era CLI and Argon-era extractions: borrow its traits as style, not as Neon's contract.

## Picking Neon (Doc)

Google's split: Neon for complex software engineering, knowledge work and science; Hydrogen as the default for everyday coding and agent work; Carbon for the hardest architecture, debugging, science and security problems. Neon and Hydrogen share `xhigh`; Carbon caps at `high`. In Antigravity, Orchestrator pairs a planner with an executor (last section).

## Delta table

| Topic | Gemini 4 API design | Prompt author action |
|---|---|---|
| Thinking level (Doc; Neon and Hydrogen) | `thinking_level`: `low`, `medium`, `high` (API default), `xhigh`; `minimal` is rejected. Google: "Run your evaluations at all four levels with a high `max_output_tokens` ... then pick the lowest `thinking_level` that meets your quality bar." `xhigh` "can cause overthinking or exhaust `max_output_tokens` on simpler prompts". Antigravity's app defaults to `Medium`. | Set depth with the parameter: Google names `thinking_level` as the control for reasoning depth, so skip prose such as "think harder" or "answer directly". Pick the level per task class. |
| Sampling (Doc), prefill (Carried) | `temperature`, `top_p`, `top_k`: in-range values are ignored on all four Gemini 4 models; the Neon and Hydrogen pages add that out-of-range values return a 400. Prefill is unsupported from Gemini 3.6 (`gemini-tuning.md`). | Shape the output with an `<output_format>` section or structured output. For determinism, write explicit rules. |
| Tool declarations (Doc) | Declare tools natively. A system instruction that asks for raw-text JSON tool calls with no declared tools can return `MALFORMED_FUNCTION_CALL`. | Put tool contracts in the function declarations; the prompt refers to tools by name. |
| Text before a tool call (Doc) | Asking for structured text (XML, YAML, JSON) right before a tool call "may occasionally fail with `Malformed_Function_Call`". The function-calling page lists three fixes: pre-tool notes inside a dedicated `update()` function call (marked preferred), Markdown headers such as `# UPDATE`, or no text before tool calls. The Cloud guide says to separate inline instructions with `\n\n`, avoid unstructured text before tool calls and log intermediate state through a dedicated function declaration. | Do not copy "before every action, output a `<status>` block" from a Claude prompt. Use `update()`, else Markdown headers, else no pre-tool text. |
| Turn state (Doc) | `system_instruction`, `tools` and `generation_config` are "interaction-scoped, re-specify them each turn"; `previous_interaction_id` does not carry them. On a long-decode continuation segment, changing `model`, `system_instruction` or `tools` returns an HTTP 400 (Cloud guide). In client-managed `generateContent` histories, prior model turns and thought signatures go back unchanged. | A multi-turn prompt ships its whole system instruction on every turn. A late rule goes into the next turn's instruction, never into a continuation segment of the same turn. |
| Cache and order (Doc) | Implicit caching starts at a 4,096-token shared prefix and discounts cached input 95%. | Static rules first, then data, then the question (as in `gemini-tuning.md`). |
| Length (Doc) | Cloud guide, long-decode table: "The model doesn't follow length targets." `max_output_tokens` caps thinking plus output together; synchronous output stops at 65,536. Google: keep or raise it to 65,536, and "To use fewer tokens, lower the thinking level instead." | Bound length by structure (number of sections or items), keep the default cap, and lower `thinking_level` to spend less. |
| Verbosity (Carried) | Gemini 3 "provide[s] direct and efficient answers"; detail has to be asked for. Neon's default is not verified. | State the wanted verbosity in one constraint line. |
| Context (Doc) | One 1,048,576-token window shared by input, thinking and output. Antigravity lists "up to 512K tokens" for Neon. | Do not size a prompt for 1M when it runs inside Antigravity. |

## Agent prompts: failure modes to write against

Google says Neon "minimizes fabricated claims and task shortcuts" (whats-new page) and reports "our lowest fabrication rate yet" in its own Antigravity testing (launch post). Those are vendor claims, so add no anti-fabrication boilerplate by default. Three reports justify a specific line each; test a line on the real harness before keeping it.

1. **Invented completions (Reported).** opencode issues 65277 and 65444 (the second closed as a duplicate of the first): with `gemini-4-neon` as the parent model, waiting on background subagents or shell tasks, Neon writes a literal `user` turn and then a fabricated `<subagent ... state="completed">` or `<shell ... state="completed">` block inside its own text, with invented commit hashes and test output, and can loop until `MAX_TOKENS` (65,420 output tokens in the worst case). Two independent reporters on opencode 2.3.2, through the Zen gateway and through Vertex, both at `high`: 20 of 310 Neon messages in one, 35 of 194 and 20 of 126 in two sessions of the other. In the second reporter's sessions Claude and GPT models continued the same history and never wrote a fake block. One harness and one model version; Google's pages do not mention it. The real notice is a separate synthetic record, so a harness can tell the two apart without reading the text. In a harness that injects completion notices, say once who writes them and what to do while waiting (a draft, not tested on Neon; fill the channel in):

   ```text
   Completion notices for background shell tasks and subagents are written by the harness and arrive as <the channel your harness uses>. Do not write one yourself, do not write a turn labelled "user", and do not report background work as finished until its notice has arrived. While you wait, end the turn and let the notice arrive.
   ```

   The reporters also propose harness-side guards (Reported, untested): a stop sequence or output filter on `\nuser\n`, `<subagent` and `<shell`, or a delivery channel that is not XML the model can imitate.

2. **Overthinking short tasks (Reported, Doc).** Flavio Copes, with every model at `high` effort, measured 5,495 reasoning tokens for Neon against 694 for Opus 5.5 on a short CSV-parser task, 49.3 seconds against 12.4. At `low` Neon still passed 27/27 at under half the cost of `high`, and he starts there for small, well-specified functions. Google's thinking page warns that `xhigh` overthinks simple prompts. Lower the level for short or mechanical work; a "do not overthink" sentence is not the control (Inference).

3. **Stopping early on loose briefs (Reported).** One Hacker News comment (item 50557486) calls Neon "a good model for delegating work to, but not deciding the detailed scope", stopping earlier than Anthropic models on under-specified tasks. Name the scope, the files and the done condition in the brief (Inference). No source reports the opposite failure for Neon, an agent that asks instead of acting; Google's agentic template steers it with a read and write risk split and a retry rule (Carried, "Agentic workflows"). A draft after that template, not Google's wording and not tested on Neon:

   ```text
   For exploratory reads, call the tool with the information you have instead of asking the user. For a write or a state change, ask first unless this prompt already grants it. Retry a transient error up to <N> times; on any other error, change the arguments or the approach instead of repeating the call.
   ```

Verification: Google published no Neon verify-before-done text. Its Gemini 3 template has a step "Validate: Review your output against the user's task" (Carried). Name the real check (the command to run, the file to re-read) and the done condition in the prompt rather than "verify your work" (Inference).

## Writing for Antigravity

- **Orchestrator (Doc).** A planner plans and reviews, an executor edits and tests. The docs: each message starts "with a read-only planning phase in which the planner explores the codebase, resolves ambiguities, and writes a concrete implementation plan, including the conditions that should trigger re-planning". The executor hands control back when "a verification step ... fails twice, an interface ... behaves differently than expected, or a design choice the plan didn't settle". Neon is the default planner (Carbon, Argon and Claude Opus 5.5 are selectable) and Hydrogen the default executor (Claude Sonnet 5.5 is selectable). In Gemini Enterprise only Carbon plus Hydrogen runs. In the CLI, `/effort` does not apply to Orchestrator. Action (Inference): a task brief for Orchestrator gives the planner the facts that settle its re-plan triggers, and a prompt must not assume Neon is the model executing it.
- **Rules (Doc).** `AGENTS.md` and `GEMINI.md` take no frontmatter and stay always on. Limits: 24 KB per file and a 20,000-token aggregate budget, with the largest files demoted to pointers; a rule with an invalid `trigger` is silently discarded. Google's split: a rule for "constraints and invariants", a skill for multi-step workflows. Keep standing text short and move procedures into skills.
- **Skills (Doc).** The agent sees every skill's name and description on each turn and reads the body when it looks relevant. Google: "Write your description in third person and include keywords that help the agent recognize when the skill is relevant."

## Checklist for a Neon prompt

- [ ] One delimiter style, static rules first, the question last (`gemini-tuning.md`).
- [ ] Depth set by `thinking_level`, chosen by an eval at the levels that matter; no "think step by step", no "answer directly".
- [ ] No sampling parameters, no prefill; output shape in a section or structured output.
- [ ] Tools declared natively; no structured text requested right before a tool call (`update()` or Markdown headers instead).
- [ ] Multi-turn: the full system instruction and tools re-sent every turn and unchanged inside one long-decode turn; thought signatures returned unchanged.
- [ ] No length target for very long output; the default `max_output_tokens` kept, `thinking_level` lowered to spend less.
- [ ] Agent brief names scope, files, done condition and the concrete check.
- [ ] A harness that injects notices says who writes them and names its channel; the line was tested on the real harness.
- [ ] For Antigravity: planner facts given, rule files under 24 KB, skill descriptions in third person with keywords.
- [ ] The report says which claims were Doc and which were Carried, Reported or Inference.
