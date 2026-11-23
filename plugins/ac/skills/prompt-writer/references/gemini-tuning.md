# Gemini Tuning

How to write a prompt a Gemini model understands best: Gemini 3.x text and agent models. Every other file in this skill targets Claude; this one lists where Gemini differs and what Google's own prompts look like. The Core principles in SKILL.md still apply wherever this file is silent. A prompt for the `generate_image`, `generate_video` or `generate_music` tool belongs to `gemini-media-prompts.md` instead.

Primary sources, all fetched 2026-11-16. The `ai.google.dev` pages redirect to a JavaScript shell; the raw markdown copies below carry the text:

- Prompt design strategies: https://aistudio.google.com/docs/prompting-strategies.md
- Long context: https://aistudio.google.com/docs/long-context.md
- What's new in Gemini 3.6: https://aistudio.google.com/docs/whats-new-gemini-3.6.md
- Gemini 3 on Vertex AI: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/get-started-with-gemini-3
- Vertex prompt design strategies: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/prompt-design-strategies
- Gemini CLI system prompt (Google's repository): https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/prompts/snippets.ts
- Antigravity IDE prompt, an unofficial extraction Google has not confirmed: https://github.com/asgeirtj/system_prompts_leaks/blob/5102c93cb2e73fedfeaee0461a68926364fcd1dc/Google/antigravity/gemini-4-argon-antigravity-ide.md
- Antigravity "Fast" prompt, unofficial: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/162db92f54d717d8ebd12292e155aeef32bb4b3c/Google/Antigravity/Fast%20Prompt.txt
- Antigravity planning-mode prompt, unofficial: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/162db92f54d717d8ebd12292e155aeef32bb4b3c/Google/Antigravity/planning-mode.txt

Not verified: Gemini 4 prompting guidance (its developer guide is a JavaScript page), any benchmark ranking XML above Markdown, and whether capitals or emphasis change Gemini's compliance. For Gemini 4 Neon read `gemini-4-neon-tuning.md` as well; it records what Google has and has not published for Gemini 4.

## Delta table (text and agent models)

| Topic | Gemini guidance | Prompt author action |
|---|---|---|
| Sectioning | "Employ clear delimiters ... XML-style tags ... or Markdown headings are effective. Choose one format and use it consistently within a single prompt." Google does not rank one above the other. | Pick tags or headings for the whole prompt. Do not mix them. |
| Where things go | "Place essential behavioral constraints, role definitions (persona), and output format requirements in the System Instruction or at the very beginning of the user prompt." | Role, constraints and output format first. |
| Long context | "Put your query / question at the end of the prompt (after all the other context)." Bridge with a phrase such as "Based on the information above..." | Data first, task last, with the bridge phrase between them. |
| Tone | "State your goal clearly and concisely. Avoid unnecessary or overly persuasive language." The Gemini 3 page on Vertex adds: "It may over-analyze verbose or overly complex prompt engineering techniques used for older models." The Vertex strategies checklist says to remove emotional appeals, flattery and artificial pressure. | Short, direct, no flattery, no pressure, no pleading. |
| Reasoning | "It's generally not necessary to have the model outline, plan, or detail reasoning steps in the returned response itself." The Vertex strategies checklist says that when you use Thinking, you should try prompting without step-by-step instructions on how to reason. Gemini 3 controls reasoning depth with the `thinking_level` parameter. | Drop "think step by step" scaffolds; raise `thinking_level` if the task needs more. Google's own AI Studio user template still ends "Remember to think step-by-step before answering.", so this is guidance, not a hard rule. |
| Sampling | Gemini 3 to 3.5: keep `temperature` at its default of 1.0 ("strongly recommended", lower values risk looping). From 3.6: "`temperature`, `top_p`, and `top_k` are deprecated and ignored." | Leave sampling unset. For determinism, write explicit rules in the system instruction, as the 3.6 notes say. |
| Prefill | From 3.6: "Prefilling model turns is no longer supported." | Use a system instruction or structured output. |
| Few-shot | The AI Studio page: "always include few-shot examples", keep the format identical across them, and avoid too many (the model overfits). Vertex is conditional: examples when the task is complex or the format is specific. | Google's two pages disagree on how many examples a task needs. Give two to four where prose cannot pin down a format or tone; for a plain task treat them as optional. |
| Constraints | Vertex: objective, measurable constraints, not "relative qualifiers"; show the output structure in an example rather than leaving the model to guess it. For a complex JSON shape, use the API's structured output. | Numbers and named formats over adjectives. |
| Negations | No official statement prefers positive phrasing for text models. Google's own text prompts use dos and don'ts freely. | Either works; state the wanted behaviour first. |
| Agents | "For deep agentic workflows, specific instructions are often required to control how the model reasons, plans, and executes tasks." | Spell out the plan, act, verify loop, the stop condition and what to do on a failed tool call. |

## Skeleton for a Gemini text or agent prompt

A starting draft built from the sources above, not Google's verbatim template. Lowercase tags follow the AI Studio template.

```
System instruction:

<role>
You are <identity in one or two sentences>.
</role>

<instructions>
1. <step or rule with its reason>
2. <step or rule with its reason>
</instructions>

<constraints>
- <measurable limit, for example "at most 5 bullets">
- <what to do when the input is missing or ambiguous>
</constraints>

<output_format>
<exact shape, plus one short example of it>
</output_format>

User turn:

<context>
<the documents, logs or code, as long as needed>
</context>

<task>
Based on the information above, <the one thing to do>.
</task>
```

## How Google writes Gemini agent prompts

Gemini CLI is Google's own repository (`packages/core/src/prompts/snippets.ts`, commit `4ed06ed`). The Antigravity files are community extractions of a closed product; treat their details as corroborated, not confirmed. Gemini CLI is a Gemini 3 era harness (its own README says it is not tuned for Gemini 4), and the Antigravity extractions run up to Argon, not Neon.

| Trait | Gemini CLI (official) | Antigravity (unofficial) |
|---|---|---|
| Skeleton | Markdown headings: `# Core Mandates`, `# Primary Workflows`, `# Operational Guidelines` | Raw XML section tags: `<identity>`, `<guidelines>`, `<communication_style>`, `<user_information>`, with Markdown inside each |
| Where XML appears | Only around dynamic or untrusted blocks: `<loaded_context>`, `<available_skills>`, `<available_subagents>` | Everywhere, as the section frame |
| Rules | Bold-label bullets, `- **Minimal Output:** Aim for fewer than 3 lines of text output ... per response whenever practical.` | Bold or capitalised rules, GOOD and BAD example pairs, emoji markers in the older "Fast" prompt |
| Identity | One sentence: "You are Gemini CLI, an interactive CLI agent specializing in software engineering tasks." | "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." |
| Workflow | "Operate using a **Research -> Strategy -> Execution** lifecycle." | Named modes: PLANNING, EXECUTION, VERIFICATION (planning-mode prompt) |
| Hard rules | "You MUST NEVER return an empty response with no text and no tool calls." | "Do NOT use send_message to communicate with the user. Instead, output visible text to communicate with the user." |
| Effort | not in the prompt | A header line: "SPECIAL INSTRUCTION: think silently if needed. EFFORT LEVEL: 1.00." |
| Tools | Names interpolated from constants; schemas live elsewhere | Declared as YAML or TypeScript-style signatures with the description above each |

What to take from them: identity in one or two sentences, sections named by purpose, rules as labelled bullets with a number where a limit exists, the workflow stated as a short named sequence, and an explicit rule for the failure that hurts most (an empty reply, a wrong channel). What not to copy into a Claude prompt: the capitals, the emoji and "UNACCEPTABLE" style. They are Google's house style for Gemini, and the Claude baseline says plain rules with a reason beat shouting.

## Media prompts

The prompt for `generate_image`, `generate_video` and `generate_music` lives in `gemini-media-prompts.md`. Those prompts reach a Gemini chat model in the web app before the image, video or music model, which changes how they are written, so nothing in this file applies to them.

## Checklist before sending a Gemini prompt

- [ ] One delimiter style throughout: tags or headings, not both.
- [ ] Role, constraints and output format at the top; data before the question; the question last.
- [ ] Plain goal sentences with no flattery or pressure; no "think step by step" scaffold unless the task proved it needs one.
- [ ] No `temperature`, `top_p` or `top_k` set; no prefilled model turn.
