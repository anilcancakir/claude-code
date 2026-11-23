# Gemini Tuning

How to write a prompt a Gemini model understands best: Gemini 3.x text and agent models, and the Gemini image models behind the `ac` MCP `generate_image` tool. Every other file in this skill targets Claude; this one lists where Gemini differs and what Google's own prompts look like. For a text or agent prompt, the Core principles in SKILL.md still apply wherever this file is silent. An image prompt needs only this file.

Primary sources, all fetched 2026-11-16. The `ai.google.dev` pages redirect to a JavaScript shell; the raw markdown copies below carry the text:

- Prompt design strategies: https://aistudio.google.com/docs/prompting-strategies.md
- Long context: https://aistudio.google.com/docs/long-context.md
- What's new in Gemini 3.6: https://aistudio.google.com/docs/whats-new-gemini-3.6.md
- Image generation: https://aistudio.google.com/docs/image-generation.md
- Gemini 3 on Vertex AI: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/get-started-with-gemini-3
- Vertex prompt design strategies: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/prompt-design-strategies
- Vertex image generation best practices: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/gemini-image-generation-best-practices
- Google developers blog, prompting Gemini 2.5 Flash Image (Aug 2025): https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/
- Google blog, Nano Banana Pro prompting tips (Nov 2025): https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/
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

## Image prompts (`generate_image`)

The tool takes one `prompt` of up to 8000 characters and no size, ratio, seed or model parameter. When the remote declares it (it does since kodizm PR #296), the proxy adds one optional reference picture, `reference_image_path` (see "Editing with a reference picture" below). Measured through the kodizm MCP on 2026-11-16: the default output was 1408x768 (landscape); adding "Vertical 9:16" to the prompt gave 768x1376; a call takes about 13 to 15 seconds and draws on a shared quota, so write the prompt once and call once per wanted image. An empty prompt is refused at once. The model id reports as `gemini-image`; which generation it is has not been verified.

Rules from Google's image guide (`aistudio.google.com/docs/image-generation.md`, Best Practices and Limitations) and the Google pages named per bullet:

- **Describe the scene as prose, not a keyword list.** The developers blog says a "narrative, descriptive paragraph" beats disconnected words. Cover subject, action, setting, composition and style in one or two connected sentences. (A Google Cloud blog formula, subject plus action plus location plus composition plus style, is secondary and was not re-fetched.)
- **Open with a creation verb** such as "Generate an image of" or "Create an image of". Vertex's best practices say that without such a phrase the model "might respond with text instead of the image".
- **Be hyper-specific and give intent.** "Ornate elven plate armor, etched with silver leaf patterns" beats "fantasy armor"; "a logo for a high-end, minimalist skincare brand" beats "a logo".
- **Control the camera with photographic words.** The guide names `wide-angle shot`, `macro shot` and `low-angle perspective`; its photorealistic template adds the light and the lens: "A photorealistic [type of shot] of a [subject description] in a [setting description]. [Description of the light]. Shot from a [camera angle] with a [lens type]."
- **Put the aspect ratio in the prompt as plain words**, last: the guide's own samples end "Aspect ratio 16:9." Without it the tool returned landscape.
- **Phrase exclusions as a scene.** Not "no cars" but "an empty, deserted street with no signs of traffic".
- **Quote text to be rendered** and name the font style and position: `the headline "EMBER" in bold white sans-serif at the top`. The image guide says text works best when you first generate the wording and then ask for the image with it, and the Nano Banana Pro blog warns that "small text, fine details" and accurate spellings may not work perfectly. Keep rendered text to a few words.
- **Break a crowded scene into steps**: "First, create a background of ... Then, in the foreground, add ... Finally, place ..."
- **Write in English** where you can; it is the first language on the guide's best-performance list (Limitations).

Worked prompts (drafts, not tested for quality):

```
Generate an image of a small red origami boat floating on calm blue water at sunrise. The sky is soft
peach and violet, low hills sit on the horizon, and the sun leaves a faint reflection on the water.
Minimalist flat illustration built from flat colour shapes. Wide 16:9 composition with the boat just
below the centre.
```

```
Create a poster for a small coffee roastery. The headline "EMBER" in bold white sans-serif at the top,
a steaming cup of dark coffee centred below it, warm amber backlight, deep brown background with fine
film grain. Clean editorial layout with generous empty space around the cup. Vertical 9:16 poster.
```

```
Generate an image of a high-resolution, studio-lit product photograph of a matte black stainless steel
water bottle on a pale grey seamless backdrop. Soft three-point softbox lighting, shot from a slightly
low angle to show the cap, sharp focus on the cap texture. Aspect ratio 4:5.
```

## Editing with a reference picture

Without a reference the guide's editing and style-transfer templates cannot be used. With one they can. The facts, from `cli/ac/src/reference-image.ts` and the kodizm session that built the remote side (the multi-turn and model points are its report, not measured here):

- `reference_image_path`: the absolute path (or `~/...`) of one local PNG, JPEG or WebP of at most 740,000 bytes; the type is read off the bytes. A picture a previous call saved fits (the ones measured here were 60 to 150 KB). `reference_image_url` takes the signed `image_url` of a previous result instead, while its link is valid. Pass one of the two, never both.
- Only one reference per call. The guide's up-to-14-reference mixing is not reachable.
- Each call is independent: there is no conversation, so a follow-up edit passes the reference again and carries the full instruction. The guide's "follow up with ... make the lighting a bit warmer" advice does not apply; write a new, fuller prompt.
- The image path has no model, thinking, aspect ratio or seed choice; say any ratio in words, as for any image.
- A reference the proxy refuses (bad path, wrong type, too big) generates and counts nothing; fix it and call again.

Templates from the guide (Prompts for editing images), to fill in with the picture's own subject:

- Add, remove or modify: "Using the provided image of [subject], please [add/remove/modify] [element] to/from the scene. Ensure the change is [description of how the change should integrate]."
- Change one thing only: "Using the provided image, change only the [specific element] to [new element/description]. Keep everything else in the image exactly the same, preserving the original style, lighting, and composition."
- Style transfer: "Transform the provided photograph of [subject] into the artistic style of [artist/art style]. Preserve the original composition but render it with [description of stylistic elements]."
- To keep a face or logo, "describe them in great detail along with your edit request."

Worked edit prompt (draft, not tested for quality), sent with `reference_image_path` set to the saved origami-boat picture:

```
Using the provided image, change only the sky to a deep teal night with a thin crescent moon. Keep
everything else in the image exactly the same, preserving the original flat illustration style, the
boat, the hills and the composition.
```

## Checklist before sending a Gemini prompt

- [ ] One delimiter style throughout: tags or headings, not both.
- [ ] Role, constraints and output format at the top; data before the question; the question last.
- [ ] Plain goal sentences with no flattery or pressure; no "think step by step" scaffold unless the task proved it needs one.
- [ ] No `temperature`, `top_p` or `top_k` set; no prefilled model turn.
- [ ] For an image: a creation verb, a prose scene, the aspect ratio last and any quoted text written into the prompt; camera and light terms when the image is a photograph.
- [ ] For an edit: the reference passed on every call, one change named, and what must stay the same stated in the same prompt.
