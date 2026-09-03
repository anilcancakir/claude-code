# Language Server Detection, Proposal, and Verification

How to detect which language server a target project needs, propose it, and prove it actually
answers. A language server plugin is a directory holding `plugin.json` plus a `.lsp.json`; there is
no settings-level config for the server itself, only `enabledPlugins` in `~/.claude/settings.json`
deciding which plugins run.

## Rule 1: read the manifests at runtime, never a baked table

Do not hardcode a language-to-plugin table in the command body. A snapshot goes stale between
releases: the extension coverage recorded during planning for this feature was already wrong by two
entries within a day.

Enumerate every installed marketplace and match the project's own file extensions against the
plugins' own `extensionToLanguage` maps:

```bash
for m in ~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json; do
  dir=$(dirname "$(dirname "$m")")
  for f in "$dir"/*/.lsp.json; do
    [ -f "$f" ] || continue
    jq -r --arg plugin "$(basename "$(dirname "$f")")" \
      'to_entries[] | .value.extensionToLanguage | keys[] | $plugin + " " + .' "$f"
  done
done
```

This prints `<plugin-name> <extension>` pairs sourced from the plugins actually on disk. Match
against the extensions present in the target project (`find` or `git ls-files` plus counting
suffixes) rather than assuming a language from the project's stated stack.

## Rule 2: prefer the official marketplace, fall back explicitly

When the detected language is covered by a plugin in `claude-plugins-official`, propose from there
first. Only fall back to `claude-code-lsps` (or any other installed marketplace) when the official
marketplace has no matching plugin, and say in the proposal text that the fallback source is
third-party.

Coverage differs by marketplace and by moment: `claude-plugins-official` does not cover every
language `claude-code-lsps` does (Dart is one example that is absent from the official marketplace
entirely), so a language can require the fallback even when the project is otherwise a mainstream
stack. Read both manifests each time rather than remembering which marketplace covered what last
time.

## Rule 3: refuse overlapping proposals

When more than one enabled server declares the same extension, the first server registered handles
files with that extension and the others never start (`plugins-reference.md:265`). Proposing two
plugins whose `extensionToLanguage` sets intersect silently disables one of them, and a later `hover`
probe still passes because the survivor answers, hiding the failure.

Before proposing a set of plugins, diff their extension sets pairwise. Refuse the proposal, or drop
to a single candidate per extension, when any two intersect. `vtsls` and the eslint server inside
`vscode-langservers` both claim `.ts` and `.tsx` in the `claude-code-lsps` marketplace; that pair
must never be proposed together. Two candidates for one language (for example `basedpyright` and
`pyright` for Python) is a legitimate choice to hand to the user, not a detection result to resolve
silently.

## Verification: two required parts, neither optional on its own

Enabling a plugin is not proof the language server runs. Installing a language server plugin does
not install the server binary; the plugin ships the wiring, and the binary is a separate install the
user performs. A verification that only checks the plugin is enabled will pass while the tool stays
dead.

1. **Plugin enabled.** Confirm the plugin appears under `enabledPlugins` in `~/.claude/settings.json`.
2. **Server answers.** Run one real `LSP` operation, `hover` or `documentSymbol`, against a real file
   of that language already in the project, and record which server replied. A successful call alone
   is not proof: with overlapping extensions the survivor of Rule 3's conflict answers even when the
   plugin meant to be primary never started, so name the responding server, not merely that a call
   returned a result.

Only when both parts pass is the language server considered wired. Report the gap to the user by
name when part 2 fails after part 1 passes: the plugin is enabled but the binary is missing, and the
fix is installing that binary, not re-enabling the plugin.

## Two constraints worth stating to the user up front

- `restartOnCrash` and `shutdownTimeout` require Claude Code 2.1.205 or later. Before that version,
  setting either field in a `.lsp.json` caused Claude Code to skip that language server entirely at
  startup rather than ignoring the unsupported field.
- Cloud sessions never start plugin language servers. Verification step 2 above will fail there by
  design, not by misconfiguration; do not treat a cloud-session failure as evidence the setup is
  wrong.

## The uncovered case

A language outside every installed marketplace's coverage needs a hand-written `.lsp.json`, which
means authoring a plugin: a materially larger job than installing one. Name this gap to the user
rather than attempting to author a server plugin as part of a project-setup step.
