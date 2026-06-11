[//]: # (Seed template consumed by /ac:install when generating a user's my-language skill.)
[//]: # (Angle-bracket markers are placeholders; the install interview fills them in.)
[//]: # (Do not paste personal voice samples or signature phrases here.)

# Language Style Skill Template

## Tone Spectrum

```
<informal-end-label>  <----------------------------->  <formal-end-label>
<context-A> (conversational, personal)                 <context-B> (professional, approachable)
```

The two ends share the core voice. What changes is opening pattern, closing pattern, and warmth level.

## Step Zero: Pick the Mode

Before the first sentence, identify which shape the prose will land in.

1. Read the user's request.
2. Match it to one row of the table below.
3. If two rows fit, use the personal-ownership signal (e.g. "my post", "my article") to choose the conversational end; default to the professional end otherwise.
4. If no row fits, ask which context applies.

| Context | Tone | Opening Pattern | Closing Pattern |
|---------|------|-----------------|-----------------|
| Documentation | <doc-tone-placeholder> | <doc-opening-placeholder> | <doc-closing-placeholder> |
| Article / Blog | <article-tone-placeholder> | <article-opening-placeholder> | <article-closing-placeholder> |
| Commit Message | <commit-tone-placeholder> | <commit-opening-placeholder> | n/a |
| Code Comment | <comment-tone-placeholder> | n/a | n/a |
| PR Description | <pr-tone-placeholder> | <pr-opening-placeholder> | <pr-closing-placeholder> |

## Core Voice Characteristics

These hold across every mode.

| Trait | Description |
|-------|-------------|
| <trait-1-name> | <trait-1-description> |
| <trait-2-name> | <trait-2-description> |
| <trait-3-name> | <trait-3-description> |
| <trait-4-name> | <trait-4-description> |
| <trait-5-name> | <trait-5-description> |

## Voice Rules

### Opening Patterns

```markdown
<!-- Good: <pattern-name> -->
<opening-example-1>

<!-- Good: <pattern-name> -->
<opening-example-2>
```

### Introducing Code

```markdown
<code-intro-phrase-1>
<code-intro-phrase-2>

<!-- After the code block -->
<post-code-phrase-1>
<post-code-phrase-2>
```

### Comparisons

```markdown
### <before-label>
[code or description]

### <after-label>
[code or description]

<observation-sentence>
```

### Callouts

```markdown
> [!NOTE]
> <note-example>

> [!WARNING]
> <warning-example>
```

### Transitions

```markdown
<!-- Good transitions -->
<transition-phrase-1>
<transition-phrase-2>

<!-- Avoid -->
<forbidden-transition-1>
```

### Closing

```markdown
<!-- Doc closing: <doc-closing-rule> -->
<!-- Article closing: <article-closing-phrase-1> / <article-closing-phrase-2> -->
<!-- Avoid in docs: <forbidden-doc-closing-phrase> -->
```

## Structure Templates

### Documentation

1. <doc-step-1>
2. Code block with language specified.
3. <doc-step-3>
4. Callouts for caveats.
5. <doc-step-5>
6. <doc-step-6>

### Article

1. Opening (<sentence-count> sentences): <article-opening-shape>
2. Topic list (optional): <article-topic-list-shape>
3. Body sections: <article-body-flow>
4. Closing: <article-closing-shape>

### Commit Message

```
<commit-format-example-1>
<commit-format-example-2>
```

- <commit-rule-1>
- <commit-rule-2>
- <commit-rule-3>

### PR Description

```markdown
## What
- <pr-what-placeholder>

## Why
- <pr-why-placeholder>

## Testing
- <pr-testing-placeholder>
```

## Signature Phrases

Use these to match the author's voice. Vary them; do not stack.

| Moment | Phrases |
|--------|---------|
| Starting work | <starting-phrase-1>, <starting-phrase-2> |
| Demonstrating | <demo-phrase-1>, <demo-phrase-2> |
| Completing | <completing-phrase-1>, <completing-phrase-2> |
| Encouraging | <encouraging-phrase-1>, <encouraging-phrase-2> |

## Writing Rules

### 1. No em-dash, no en-dash

Em-dash (U+2014) and en-dash (U+2013) are banned in every output: docs, articles, commits, comments, PR bodies, and anything else that reaches a human reader. Use comma, colon, semicolon, period, parentheses, or plain conjunctions instead.

### 2. <rule-2-title>

<rule-2-body>

### 3. <rule-3-title>

<rule-3-body>

### 4. <rule-4-title>

<rule-4-body>

## When to Read the References

Read `${CLAUDE_SKILL_DIR}/references/examples.md` when:

- The user is writing a personal article and wants the cadence to match prior published work.
- You need a worked example of the opening-to-code-to-result flow or a specific closing pattern.
- The user references a specific published piece and wants the new content to feel like a sibling.

Skip the file for short docs, commits, code comments, and PR bodies. This template body is enough for those.
