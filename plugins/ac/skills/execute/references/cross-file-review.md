# Cross-file Consistency Check

The seven boundaries to inspect in Phase 2d Layer B step 5, with the concrete failure each one catches. Read this at the first wave that produces two or more files sharing an interface; the skill body carries the rule and the boundary list, this file carries the detail.

The point of the check is what the worker did not see. A worker gets one file's scope; the orchestrator sees the whole wave. Catching an inconsistency here costs one extra Read; missing it costs a Phase 3 revision iteration, or ships a dead link.

## 1. Shared data shapes

A `_data/site.json` field path the template reads, an API response field the client expects, props a parent passes to a child. Grep every consumer of a newly declared field and verify they agree on shape.

## 2. URL and path conventions

When multiple files build URLs from the same source field, verify they use the SAME composition rule. A real bug from a shipped wave: a GitHub link hardcoded `https://github.com/{{ handle }}`, Mastodon used `{{ url }}` directly, LinkedIn hardcoded `https://linkedin.com/in/{{ handle }}`. Three platforms, three rules, one file. Pick one shape per field across the project.

## 3. Component and function name match

Compare the registration site (`Alpine.data('themeToggle', ...)`, `defineComponent('foo', ...)`, a named export) against the call site (`x-data="themeToggle"`, `<foo />`, `import { foo }`). A one-character typo silently no-ops at runtime, so no build or test failure points at it.

## 4. Template engine interop

Layout-inheritance mechanisms do not mix. An Eleventy front-matter `layout:` chain expects `{{ content | safe }}` injection; Nunjucks `{% extends %}` expects `{% block content %}` slots. Pick one per project and verify every file in the wave uses it.

## 5. Front-matter is data, not template

YAML, TOML, and JSON front-matter values containing `{{ ... }}` expressions are stored as literal strings, never evaluated. If a step's plan said `title: "{{ site.name }}"` in front-matter, the rendered output carries literal curly braces. Grep the changed files for `title:.*{{` and `description:.*{{`, and flag any match.

## 6. Asset paths

The `<link href>` and `<script src>` URLs must match where the bundler actually writes its output. A template path that points at the source tree instead of the build destination passes every file-level check and 404s in the browser.

## 7. Link target reachability

For every internal route or component reference the wave generates (`route('foo.bar', ...)`, `<a href="{{ route(...) }}">`, `<Link to="...">`, `<router-link>`, named-route helpers), open the target view or component and confirm it renders meaningful content under the project's layout, not a stub placeholder.

File-level checks pass as soon as the file exists and the route is defined, so rendered content is the only signal that catches a dead end. A stub like `<div>Foo: {{ $foo->name }}</div>` sitting outside the layout chrome ships as a dead-end user click. Stage 5.4 of the deep reviewer would catch it eventually; catching it here costs one Read per target instead of a full revision iteration.
