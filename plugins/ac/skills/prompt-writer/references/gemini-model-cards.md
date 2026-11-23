# Gemini Model Cards

Which Gemini model will run the prompt decides a few concrete choices: the thinking level and its default, the output budget, the shape of tool turns, how much scope the brief must pin down, and what a failure looks like. This file is the per-model layer under `gemini-tuning.md` (the generic Gemini 3.x text rules; media prompts are in `gemini-media-prompts.md`). The operator's priority order is Gemini 4 Neon, then Gemini 3.8 Flash, then Hydrogen, Carbon and Argon, then the older Flash line and 3.1 Pro, so depth follows that order. Neon has its own file, `gemini-4-neon-tuning.md`; read it too for any Gemini 4 model and for any Antigravity work, because the sampling, tool, pre-tool text, turn-state and caching rules there hold for all four Gemini 4 models. Claims carry the same labels as there: **Doc** (a Google page), **Carried** (Google guidance written for another Gemini generation), **Reported** (a third-party firsthand report; the number of reporters is stated) and **Inference** (this skill's reading).

Primary sources, all fetched 2026-11-23 (the `.md` copies on `aistudio.google.com` carry the text):

- Thinking, with the per-model default and level table: https://aistudio.google.com/docs/thinking.md
- What's new: https://aistudio.google.com/docs/whats-new-gemini-3.8.md , `whats-new-gemini-3.6.md`, `whats-new-gemini-4-hydrogen.md`, `whats-new-gemini-4-carbon.md`, `whats-new-gemini-4-argon.md` (same folder)
- Choosing a model, pricing, models and deprecations: https://aistudio.google.com/docs/choosing-a-model.md , `pricing.md`, `models.md`, `deprecations.md`; prompt design: `prompting-strategies.md`; model page: `models/gemini-3.1-pro-preview.md`
- DeepMind model card for 3.8 Flash: https://deepmind.google/models/model-cards/gemini-3-8-flash/
- Cloud guides: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen , `gemini-4-carbon`, `gemini-4-argon`
- Antigravity model table: https://antigravity.google/docs/models
- Artificial Analysis (AA) model pages, index v5.0.1: https://artificialanalysis.ai/models/gemini-3-8-flash , `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-4-argon`
- Carbon trace study (one blog, private bug-fix evals): https://kernel.dev/blog/why-is-gemini-4-carbon-taking-so-long/
- Reports: Hacker News items 49919170, 50294078, 50288524 and 50277126; opencode issues 52378 and 64967 (https://github.com/anomalyco/opencode/issues/52378)

Not verified: Hydrogen failure modes (no report with more than one reporter found), a Google prompting guide for any of these models (none found), Carbon's developer guide (a JavaScript shell, unreadable), and Antigravity context windows or Gemini CLI behaviour for these models.

## The matrix (Doc)

| Model | Default; levels | Output cap per call | Price per 1M, in / out | Google's use |
|---|---|---|---|---|
| `gemini-4-neon` | `high`; low, medium, high, xhigh | 65,536 | $3 / $15 | complex software engineering, knowledge work, science |
| `gemini-3.8-flash` (stable, "previous-generation Flash") | `medium`; low, medium, high | 65,536 | $0.75 / $3.75 through 2026-12-31, then $1.50 / $7.50 | long-horizon software engineering, autonomous agents, complex enterprise workflows |
| `gemini-4-hydrogen` | `high`; low, medium, high, xhigh | 65,536 | $1.50 / $7.50 | everyday coding, tool-using agents, parallel subagents; Google's upgrade target from 3.8 Flash |
| `gemini-4-carbon` | `medium`; low, medium, high | 32,768 per non-streaming REST hop | $2 / $10 through 2026-11-30, then $4 / $20 | long-horizon asynchronous work, deep verification, the hardest problems |
| `gemini-4-argon` | `medium`; low, medium, high | 32,768 per non-streaming REST hop | as Carbon | "efficient Gemini 4 frontier reasoning model": faster and fewer tokens per turn than Carbon |
| `gemini-3.6-flash` | `medium`; minimal, low, medium, high | 65,536 | as 3.8 Flash | code generation, multimodal reasoning, agentic workflows |
| `gemini-3.5-flash-lite` | `minimal`; minimal, low, medium, high | 65,536 | $0.30 / $2.50 | translation, summarization, structured extraction at scale |
| `gemini-3.1-pro-preview` | `high`; low, medium, high | 65,536 | $2 / $12 up to 200k prompt tokens, $4 / $18 above | deep reasoning (preview) |
| `gemini-3.7-flash` | released 2026-08-13, no longer in AI Studio; requests route to 3.8 Flash | | | |

The Gemini 3 models keep a separate output budget next to the 1M input window, while Neon, Hydrogen, Carbon and Argon share one 1,048,576-token window across input, thinking and output (Hydrogen migration notes). From 2026-12-01 requests to `gemini-2.5-pro` route to 3.8 Flash and `gemini-2.5-flash` to 3.5 Flash-Lite (deprecations page), so an old prompt will start running on these cards' models.

Shared by Gemini 4 and 3.6 and later: `temperature`, `top_p` and `top_k` are ignored (deprecation headers now, "400 errors in a future release"; the Neon and Hydrogen pages already return a 400 for out-of-range values, the Carbon and Argon pages say only that values are ignored); prefill is unsupported; text before a tool call follows the `\n\n` and `update()` rules in `gemini-4-neon-tuning.md`. `minimal` is rejected on Neon, Hydrogen, Carbon, Argon and 3.8 Flash; the thinking page lists it as supported on 3.6 Flash, 3.5 Flash-Lite and 3.1 Flash-Lite. Carbon and Argon do not offer `xhigh` (thinking page table). For earlier Gemini 3 models, including 3.1 Pro, Google says to keep the sampling parameters at their defaults (Doc).

## Gemini 3.8 Flash (second priority)

- **What it is (Doc).** GA 2026-09-02. `medium` is the default and "Recommended for complex code and agentic use cases, providing higher first-pass accuracy"; thinking cannot be turned off. Google: it "can use more tokens on longer running and complex tasks, by design ... the model takes smaller reasoning steps, calls tools iteratively, and verifies its work along the way. Not every workflow needs this level of verification. For everyday tasks, you can lower the reasoning effort". The models page calls it the previous-generation Flash and Google's upgrade table sends it to Hydrogen.
- **Measured (AA, v5.0.1, 2026-11-23).** Index 31 at `high`, 30 at `medium`, 23 at `low`, against a comparable-model median of 44; 105 tokens per second; "very verbose" (126M output tokens for the index at `high`). `medium` costs one point and `low` costs eight, so lower the level to `medium` before adding "be brief" prose, and treat `low` as a quality trade.
- **Reported failure modes (each one reporter).** It answers from its own knowledge instead of calling tools (HN 49919170, who contrasts it with other frontier models); a commenter who moved to Argon credits it with "not claiming to have done things it clearly didn't", implying 3.8 Flash does (HN 50294078); a subagent turn ended in an empty `MALFORMED_FUNCTION_CALL` (opencode issue 52378, through the Vercel gateway; opencode then reported it to the parent as success, a harness bug).
- **Lines worth testing (Inference from the reports; a draft, not tested on 3.8 Flash).**

  ```text
  Look up any fact that can change or that you are not sure of with a tool; do not answer it from memory. Do not report a step as done until a tool result shows it.
  ```

- **Grounded answers (Carried).** The "Gemini 3 Flash strategies" section of the prompt design page gives a clause for answers that must stay inside supplied text: "You are a strictly grounded assistant limited to the information provided in the User Context ... If the exact answer is not explicitly written in the context, you must state that the information is not available." Google says Hydrogen cuts fabricated claims by more than 5x against 3.8 Flash (a vendor claim), so 3.8 Flash is the weaker model on this axis (Inference).
- **Dates (Inference).** The same section's clauses "Remember it is 2026 this year" and "Your knowledge cutoff date is January 2025" were written for Gemini 3 Flash. The DeepMind 3.8 Flash card says knowledge reaches March 2026 in some domains and stays limited to January 2025 in others, so the cutoff clause is half right. Put the current date in the prompt when it matters.

## Gemini 4 Hydrogen

- **Doc.** `high` default, `xhigh` available, `minimal` and `thinking_budget` rejected. It "batches read and search tool calls in parallel", so do not ask for one call per turn. With several parallel `functionCall` parts in one turn, `thought_signature` rides on the first only; do not copy it onto the later parts (Cloud guide). It is the default Orchestrator executor, and Google pairs it with Carbon and Neon as parallel worker and verifier agents. Antigravity defaults it to `Medium`.
- **Measured (AA).** Index 54 at `xhigh`, 51 at `high`, 41 at `medium`, 27 at `low`; 152 tokens per second; "very verbose" (304M output tokens at `xhigh`). The level matters more here than on any other model in this file.
- **Reported.** No Hydrogen-specific failure mode with more than one reporter found.
- **Action (Inference).** Give it a plan: the files, the change, the check to run. Keep agent work at `high` or above; `low` is for classification and routing.

## Gemini 4 Carbon

- **Doc.** `medium` default and `high` cap. Google: "Prefer sequential tool execution turns in multi-step tool loops." Never set `max_output_tokens` below 32,768 ("Gemini 4 Carbon can spend more of the limit on thinking than earlier models. To use fewer tokens, lower the thinking level instead"), and set client timeouts to at least 15 minutes ("Hard prompts can take several minutes"). Its price doubles on 2026-12-01.
- **Measured (AA).** Index 60 at `high`, 58 at `medium`, 54 at `low`; 59 tokens per second; 34.7 minutes per index task at `high`; "very verbose".
- **Reported (one blog, private bug-fix evals, Carbon at `high`).** Half of Carbon's steps went into work the ticket did not ask for, and it kept re-reading code it had already read. At `low` "it went in circles". In one re-run a modified harness injected "do you already have enough to make the fix?" every five turns and cut 37 minutes to 28.
- **Action (Inference).** Pin the boundary ("only what the ticket asks; report adjacent problems") and the done condition. The check-in worked as a harness injection; as a sentence in the prompt it is untested. Use Carbon for background and verification work, not for interactive loops.

## Gemini 4 Argon

- **Doc.** Same API shape, levels (`medium` default, `high` cap), output hop and price as Carbon, with faster turns and fewer tokens per turn. Google: Argon for most advanced software engineering and knowledge work, Carbon for the hardest problems.
- **Measured (AA).** Index 50 at `high`, 48 at `medium`; 75 tokens per second; "somewhat verbose".
- **Reported.** Hallucination, from two commenters in one thread, both describing mostly Gemini app use: it "hallucinates significantly more even on moderately complex tasks compared to Astra or Opus" (HN 50294078, HN 50288524). Single reporters: it stops and waits for confirmation far more often than other models, and the commenter finds that less annoying with permission prompts off inside a VM (HN 50277126); the 3.6+ models, Argon "less often", sometimes treat unstaged changes as not their own and undo them or delete files (HN 50294078); runaway `}}}}` streams before tool calls, in Cyrillic text through OpenRouter (opencode issue 64967, open, cause unconfirmed).
- **Action (Inference).** For answers from supplied text, add the grounding clause quoted in the 3.8 Flash card. For agent work, say what it may do without asking and add "do not revert or delete changes you did not make".

## Older Flash line and 3.1 Pro (Doc)

- **3.7 Flash:** the endpoint keeps working and routes to 3.8 Flash.
- **3.6 Flash:** `medium` default; the thinking page lists `minimal` as supported, while the 3.6 migration checklist names only `medium` and `high`, so test `minimal`.
- **3.5 Flash-Lite:** `minimal` default. For "autonomous subagents with tool calls, code execution, or multi-step reasoning: set `thinking_level` to `"medium"` or `"high"` to prevent premature tool termination."
- **3.1 Pro (preview):** `high` default; keep sampling at defaults. The `-customtools` endpoint "is better at prioritizing" your own tools but can fluctuate on work that does not use them (model page).

## Porting a prompt between models (Inference on the facts above)

| From to | What to change |
|---|---|
| Neon to Hydrogen | Same API shape and levels; set the level again (AA: 51 at `high` against Neon's 60) and supply the plan Neon would have made. |
| Neon or Hydrogen to Carbon or Argon | `xhigh` becomes `high`; the default drops to `medium`; `max_output_tokens` no lower than 32,768; timeouts at least 15 minutes; sequential tool turns; a non-streaming REST hop stops at 32,768. |
| 3.8 Flash to Hydrogen (Google's path) | The default level moves from `medium` to `high`: set `thinking_level` explicitly. Drop the tool-use and grounding reminders only after testing. |
| Anything to 3.5 Flash-Lite | The default is `minimal`: set `medium` or `high` for any subagent that calls tools. |

## Checklist for a Gemini model prompt

- [ ] The target model is named, and its default level, level set and output cap checked against the matrix.
- [ ] `thinking_level` set explicitly; `xhigh` only on Neon or Hydrogen; no `minimal` on Neon, Hydrogen, Carbon, Argon or 3.8 Flash.
- [ ] No sampling parameters, no prefill; `max_output_tokens` and timeouts sized for the model (Carbon and Argon especially).
- [ ] For 3.8 Flash: the tool-use and done-claim lines tested, the grounding clause when answering from supplied text, the current date given.
- [ ] For Carbon: scope boundary and done condition; a periodic check-in only as a harness injection.
- [ ] For Argon: the grounding clause for supplied text, what it may do without asking, and a rule against undoing changes it did not make.
- [ ] The report says which claims were Doc, Carried, Reported or Inference.
