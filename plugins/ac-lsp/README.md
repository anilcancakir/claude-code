# ac-lsp

No more stale diagnostics after an edit from Bash, git, a formatter or another Claude Code session. `ac-lsp` runs Dart and Intelephense for Claude Code, each started through a small proxy that keeps the server in step with the disk. Intelephense also keeps a workspace exclude list that holds indexing finite in repositories with Claude Code worktrees or Flutter build output.

## Why a proxy

Claude Code tells a language server only about the changes its own Edit and Write tools make. It never sends `workspace/didChangeWatchedFiles`, and it sends `didClose` only for the least-recently-used file once more than 50 are open, so a change that comes from Bash, git, a formatter or another Claude Code session on the same repository never reaches the server. The two servers fail in different ways:

- **Dart** watches the disk itself, but once a file has been opened it trusts the opened copy and ignores the disk for that file for the rest of the session.
- **Intelephense** does not watch the disk at all; it waits for the client to report file changes.

Both end in the same place: diagnostics about code that no longer exists, and a model that learns to dismiss them. The proxy sits between Claude Code and the server and fills the gap:

- Before it forwards each message from Claude Code, and whenever a watched directory changes, it compares every opened file with the disk and sends the server a full-text `didChange` when they differ.
- For Intelephense (`--watch-root`), it watches the workspace root and reports changed `.php` files as `workspace/didChangeWatchedFiles`, skipping `.git`, `node_modules`, `vendor/composer`, `storage`, `build` and `.claude/worktrees`.

Everything else passes through byte for byte. Claude Code still shows each diagnostic once and may deliver it a turn late; the `ac` plugin's PostToolUse hook covers that side by running `dart analyze --fatal-infos` on an edited Dart file, and `php -l` plus the project's PHPStan (when `vendor/bin/phpstan` exists) on an edited PHP file.

## Why not the stock `php-lsp`

The official `php-lsp` plugin starts Intelephense with no settings, so it indexes with Intelephense's default excludes. Two kinds of directory make that go wrong:

- **`build/`.** After `flutter build ios` or `flutter build macos`, `build/` can hold Xcode SourcePackages for the app's Swift Package Manager dependencies: tens of thousands of files and hundreds of symlinks. Intelephense's file search stalls on it, `indexingEnded` does not arrive, and every cross-file request (definition, references, workspace symbols) comes back empty. Measured on a Flutter plus Laravel monorepo with a 62,788-file `build/`: rooted at that checkout, no index within 150 s on the defaults and 11,614 files indexed in 9.4 s with `build/` excluded; rooted at the main checkout that holds it as a worktree, no index within 6 minutes on the defaults.
- **`.claude/worktrees/`.** `claude --worktree` creates each worktree inside the main checkout. A session in the main checkout then indexes every worktree too, its own `vendor/` included: goToDefinition returns one result per copy, and one worktree took the server from 597 MB to 975 MB.

## Install

Disable any other plugin that claims `.php` or `.dart` first. When two plugins claim an extension, Claude Code routes it to whichever loads first and never starts the other one for it.

```
/plugin marketplace add anilcancakir/claude-code
/plugin disable php-lsp@claude-plugins-official
/plugin disable dart@claude-code-lsps
/plugin install ac-lsp@ac
```

The proxy runs on `node` (22.13 or later, the same floor as the `ac` plugin).

A project that enables `php-lsp@claude-plugins-official` in its own `.claude/settings.json` turns it back on there. Override it in that project's `.claude/settings.local.json`:

```json
{
    "enabledPlugins": {
        "php-lsp@claude-plugins-official": false
    }
}
```

Intelephense comes from npm, and Dart from the Dart or Flutter SDK on your `PATH`:

```
npm install -g intelephense
```

## Behaviour to know

- Claude Code roots the server at the session's working directory the first time a `.php` file is touched, and keeps that root for the session. Start worktree sessions with `claude --worktree <name>` so the worktree is the root.
- After `EnterWorktree` in a session whose PHP server is already running, the server stays rooted at the main checkout, and the worktree's files fall under the `.claude/worktrees` exclude. Intelephense answers nothing for an excluded file, even an open one. Start a new session in the worktree for PHP work there. `/reload-plugins` is meant to restart language servers, but whether it re-roots them has not been verified.
- A PHP source directory named `build/` is excluded as well (the match is case-sensitive, so `app/Build/` is not). Fork the plugin if a project keeps code there.
- Intelephense's "declared but not used" hints are switched off (`diagnostics.unusedSymbols: false` in `.lsp.json`). By a raw count of transcripts since 1 October they were 3,062 of 35,968 Intelephense diagnostic lines Claude saw (8.5%, repeats included), nothing acts on them, and Pint already removes unused imports. Every other diagnostic stays on, so a real undefined method or type still shows.
- A language server starts with the session. A session opened before `ac-lsp` was enabled keeps the stock server, without the proxy, so a class created from Bash shows as `Undefined type` until the session restarts. Restart it; `/reload-plugins` is documented to reload plugin language servers, but swapping the stock plugin for this one that way has not been verified.
- The index cache lives in `~/.config/intelephense/workspace/` (or under `$XDG_CONFIG_HOME`), one hashed directory of roughly 20 MB per workspace root, so each worktree root adds one. Intelephense rebuilds a missing cache on the next start, so deleting the whole directory is safe.
