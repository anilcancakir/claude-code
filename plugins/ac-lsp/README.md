# ac-lsp

Language servers for Claude Code that stay in step with the disk, say only what an agent can act on, and stay cheap. `ac-lsp` runs Dart, PHP (Intelephense), TypeScript and JavaScript (Node.js included), Python, Go, Swift, HTML, CSS, SCSS and Sass, each started through one small proxy. No more stale diagnostics after an edit from Bash, git, a formatter or another Claude Code session, no diagnostics about files that no longer exist, and no hints or environment errors spending the agent's tokens. Intelephense also keeps a workspace exclude list that holds indexing finite in repositories with Claude Code worktrees or Flutter build output.

| Language | Server | Memory, one-file project | Notes |
|---|---|---|---|
| Dart | `dart language-server` | 400 MB | from the SDK |
| PHP | `intelephense` | 330 MB, grows with the index | workspace excludes for worktrees and `build/` |
| TypeScript, JavaScript | `typescript-language-server` | 120 to 170 MB (stock plugin 250 to 430 MB) | one tsserver process instead of two |
| Python | `pyrefly lsp` | 57 MB (pyright 200 MB, basedpyright 166 MB) | `default` checking mode, editor extras off |
| Go | `gopls` | 97 MB | style and modernisation analyzers and staticcheck off |
| Swift | `sourcekit-lsp` | 77 MB, 8 to 10 s to the first diagnostic | from the Swift toolchain |
| HTML | `superhtml lsp --syntax-only` | 47 to 53 MB | syntax errors only |
| CSS, SCSS, Sass | `some-sass-language-server` | 91 MB | lint rules that fire on Tailwind and vendor prefixes off |

Memory is the resident size (`ps` RSS) of the whole process tree, proxy included, about ten seconds after the first file is opened in a one-file project. The proxy is a Node process of about 45 MB per server (superhtml itself is 3 MB), a run varies by 20% or more (TypeScript the most, because `ps` leaves out compressed pages), and a real project grows every figure. Kotlin and Java are not shipped (see the end).

## Why a proxy

Claude Code tells a language server only about the changes its own Edit and Write tools make. It never sends `workspace/didChangeWatchedFiles`, and it sends `didClose` only for the least-recently-used file once more than 50 are open, so a change that comes from Bash, git, a formatter or another Claude Code session on the same repository never reaches the server. The two servers fail in different ways:

- **Dart** watches the disk itself, but once a file has been opened it trusts the opened copy and ignores the disk for that file for the rest of the session.
- **Intelephense** does not watch the disk at all; it waits for the client to report file changes.

Both end in the same place: diagnostics about code that no longer exists, and a model that learns to dismiss them. The proxy sits between Claude Code and the server and fills the gap:

- Before it forwards each message from Claude Code, and whenever a watched directory changes, it compares every opened file with the disk and sends the server a full-text `didChange` when they differ.
- For Intelephense (`--watch-root`), it watches the workspace root and reports changed `.php` files as `workspace/didChangeWatchedFiles`, skipping `.git`, `node_modules`, `vendor/composer`, `storage`, `build` and `.claude/worktrees`.

Everything else passes through byte for byte, except one thing going the other way (next section). The `ac` plugin's PostToolUse hook covers the synchronous side by running `dart analyze --fatal-infos` on an edited Dart file, and `php -l` plus the project's PHPStan (when `vendor/bin/phpstan` exists) on an edited PHP file.

## Held diagnostics

Claude Code keeps every non-empty `publishDiagnostics` until its next turn and never withdraws one. A diagnostic that the server retracts a second later, because the file it was missing has just been written, is still shown a turn later, and the model learns to call every diagnostic stale. In a multi-worker run that is most of the noise: a test written before its implementation, a worktree removed while its files are still open in the server (Dart then republishes errors for the files that are gone, `Target of URI doesn't exist` and `The function isn't defined`; Intelephense showed the same in transcripts but not in a lab run), a wave of edits that is consistent only at the end. In the transcripts of four sessions that ran with the proxy, 683 of 837 diagnostics were on files that have since been deleted, and 270 of the 663 in worktrees were delivered after the command that removed the worktree (delivery is a turn late, so some of those were published before it).

The proxy therefore holds a non-empty set for a file until its project has been quiet:

- **Quiet** means no new publish for that file, and no client edit, synced disk change or watched-file event in its project (the nearest ancestor with a `.git`, so a worktree is its own project), for `--settle` milliseconds, 6000 by default.
- A newer publish for the file replaces the held one, and an empty publish drops it, so a diagnostic that resolves inside the window never reaches Claude Code.
- A set for a file that no longer exists is dropped, never forwarded.
- A set held for `--max-hold` milliseconds, 300000 by default, is forwarded anyway, so a project that never goes quiet still hears about a real error.
- `--settle 0` turns holding off and keeps only the deleted-file drop.
- `--busy <start>,<end>` names two server notifications. From the first until the second, nothing is released for being quiet (the hold limit still applies), and the quiet time starts over when the second arrives, so the republish that follows an indexing run can still replace the set. The Intelephense entry passes `indexingStarted,indexingEnded`: a server that is indexing reports symbols it has not read yet as undefined.

A real, persistent error still arrives, once, after the quiet time. Measured: in a real Claude Code run, a Dart test written before its implementation was shown as `Target of URI doesn't exist` and `The function 'B' isn't defined` on the stock server and not at all behind the proxy, while a persistent type error was still shown once; against a real Dart server, the 2 errors published after the whole package was removed became 0, and a persistent error arrived 3 s after publication with `--settle 3000`. To change the flags, edit `args` in `.lsp.json` in a fork of the plugin; a plugin update replaces the installed copy.

## Less noise, fewer tokens

Every diagnostic Claude Code receives costs tokens, and most of what a server says is not about the code. Of the 13,227 diagnostics in my session transcripts (24 September to 31 October), 1,351 were hints or information (909 of them Intelephense unused-symbol hints, which `unusedSymbols: false` already removes), and 251 of 656 TypeScript diagnostics were missing-dependency errors (`Cannot find module 'left-pad'`, `Cannot find name 'process'`). Only 53 of those 251 came from a tree with no `node_modules` above the file, the case the `typescript` profile removes; the other 198 had an install and stay. The proxy removes the noise at the source:

- `--max-severity 2` (set for every server) forwards errors and warnings only. For Dart and PHP, the `ac` plugin's PostToolUse check still reports the rest at the end of an edit (`dart analyze --fatal-infos`, `php -l`, PHPStan); for the other languages, and without `ac`, hints and information are not reported at all.
- `--profile` names diagnostics that are symptoms of a missing environment, not of the code:
  - `php` drops Intelephense's undefined-symbol errors (P1009 type, P1010 function, P1011 constant, P1012 class constant, P1013 method, P1014 property) in a project that has a `composer.json` but no `vendor` directory between the file and its project root (the nearest directory with a `.git` entry, so a worktree is its own project and the checkout's `vendor` above it does not count), such as a git worktree before `composer install`: Laravel, PHPUnit and Carbon cannot be resolved, so every symbol from them is undefined. A project without `composer.json` has no dependencies to miss, so its undefined symbols stay errors. Measured on a copy of a Laravel backend whose `vendor` appeared after the server had started: 47 errors (P1009 and P1013) that the stock server never withdrew, and that an earlier `ac-lsp` delivered after 8.9 s although the server cleared them at 46 s.
  - `typescript` drops the dependency errors (TS2307, 2792, 7016, 2688, 2580 to 2582, 2591 to 2593, 7026) while no `node_modules` exists in any directory above the file, and keeps a relative import that cannot be found, because that one is a typo.
  - `swift` drops `The package access level used on 'X' requires a package name` (raised for a file compiled with fallback settings) and `No such module` in a project that has no `Package.swift`, `compile_commands.json` or `buildServer.json` (an Xcode project, where sourcekit-lsp cannot see the modules). In a Swift package a missing module is reported: `.build` is no signal, because sourcekit-lsp creates it within a fraction of a second.
- The servers are configured lean in `.lsp.json`: tsserver with `disableSuggestions` (no unused-variable hints), `useSyntaxServer: never` (one process, not two) and no automatic type acquisition from the network; pyrefly in `default` mode with inlay hints, completion, semantic tokens and code lenses off, which leaves `definition`, `references` and `hover` working; gopls with 35 style, simplification and modernisation analyzers (`writestring`, `mapsloop`, `unusedparams` and others) and `staticcheck` off, which keeps the `go vet` analyzers and `unusedwrite`; some-sass with `unknownProperties`, `unknownAtRules` (Tailwind `@apply`), `vendorPrefix`, `emptyRules`, `fontFaceProperties` and `propertyIgnoredDueToDisplay` ignored.

A real error is never dropped by these rules: an assignment of a string to an `int`, an undefined name and a missing `}` all still arrive (checked in real Claude Code runs for each language).

## Why not the stock `php-lsp`

The official `php-lsp` plugin starts Intelephense with no settings, so it indexes with Intelephense's default excludes. Two kinds of directory make that go wrong:

- **`build/`.** After `flutter build ios` or `flutter build macos`, `build/` can hold Xcode SourcePackages for the app's Swift Package Manager dependencies: tens of thousands of files and hundreds of symlinks. Intelephense's file search stalls on it, `indexingEnded` does not arrive, and every cross-file request (definition, references, workspace symbols) comes back empty. Measured on a Flutter plus Laravel monorepo with a 62,788-file `build/`: rooted at that checkout, no index within 150 s on the defaults and 11,614 files indexed in 9.4 s with `build/` excluded; rooted at the main checkout that holds it as a worktree, no index within 6 minutes on the defaults.
- **`.claude/worktrees/`.** `claude --worktree` creates each worktree inside the main checkout. A session in the main checkout then indexes every worktree too, its own `vendor/` included: goToDefinition returns one result per copy, and one worktree took the server from 597 MB to 975 MB.

## Install

Disable any other plugin that claims one of these extensions first. When two plugins claim an extension, Claude Code routes it to whichever loads first and never starts the other one for it. The `kotlin-lsp` line is not an overlap; the reason is under Kotlin and Java at the end. Other marketplaces ship servers for the same extensions too (`vtsls`, `basedpyright` and others), so disable any that you have installed.

```
/plugin marketplace add anilcancakir/claude-code
/plugin disable php-lsp@claude-plugins-official
/plugin disable dart@claude-code-lsps
/plugin disable typescript-lsp@claude-plugins-official
/plugin disable pyright-lsp@claude-plugins-official
/plugin disable gopls-lsp@claude-plugins-official
/plugin disable swift-lsp@claude-plugins-official
/plugin disable kotlin-lsp@claude-plugins-official
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

Dart comes from the Dart or Flutter SDK and `sourcekit-lsp` from the Swift toolchain, both on your `PATH`. The rest:

```
npm install -g intelephense typescript@6 typescript-language-server some-sass-language-server
uv tool install pyrefly
go install golang.org/x/tools/gopls@latest
brew install superhtml
```

Install `typescript@6`, not the latest: TypeScript 7 ships no `tsserver.js`, which `typescript-language-server` runs, and without a TypeScript 5 or 6 (a global one, or the project's own in `node_modules`) the server exits and delivers nothing (checked with typescript 7.0.2 and typescript-language-server 6.0.2). That version of the server needs Node 22.22.2 or later (`engines` in its package.json); the proxy itself needs 22.13.

A server that is not installed fails to start for its own extensions only; the others are unaffected.

## Behaviour to know

- Claude Code roots the server at the session's working directory the first time a `.php` file is touched, and keeps that root for the session. Start worktree sessions with `claude --worktree <name>` so the worktree is the root.
- After `EnterWorktree` in a session whose PHP server is already running, the server stays rooted at the main checkout, and the worktree's files fall under the `.claude/worktrees` exclude. Intelephense answers nothing for an excluded file, even an open one. Start a new session in the worktree for PHP work there. `/reload-plugins` is meant to restart language servers, but whether it re-roots them has not been verified.
- Dart gives a server rooted at the main checkout no diagnostics at all for a worktree under `.claude/worktrees` (measured on SDK 3.13.7: it does not analyze files below a hidden directory, and a worktree outside the root is not analyzed either). Rooted at the worktree it works as in any project. Silence is not a clean bill, so the PostToolUse `dart analyze` result is the check for worktree files.
- A PHP source directory named `build/` is excluded as well (the match is case-sensitive, so `app/Build/` is not). Fork the plugin if a project keeps code there.
- Intelephense's "declared but not used" hints are switched off (`diagnostics.unusedSymbols: false` in `.lsp.json`). By a raw count of transcripts since 1 October they were 3,062 of 35,968 Intelephense diagnostic lines Claude saw (8.5%, repeats included), nothing acts on them, and Pint already removes unused imports. Every other diagnostic stays on, so a real undefined method or type still shows.
- A language server starts with the session. A session opened before `ac-lsp` was enabled keeps the stock server, without the proxy, so a class created from Bash shows as `Undefined type` until the session restarts. Restart it; `/reload-plugins` is documented to reload plugin language servers, but swapping the stock plugin for this one that way has not been verified.
- Markdown is not shipped. The one check `marksman` made for an agent was a link to a document that does not exist; it cost a process of about 150 MB in every session that edits a Markdown file, it flagged two links in this repository's own READMEs as non-existent although their targets exist, and it stays silent in a git worktree (a `.git` file does not count as a root; an empty `.marksman.toml` does).
- Swift: in a project without `Package.swift`, `compile_commands.json` or `buildServer.json` (an Xcode project) the `swift` profile drops every `No such module`, a misspelled import included; the compiler catches it. In a package, a sibling target is reported as `No such module` until the first index build finishes (5 s in one run, with the real error following 4.6 s later); the quiet time absorbs that when the index builds within it, and a slower first build can let the transient through once.
- sourcekit-lsp writes `textDocument\/publishDiagnostics` with an escaped slash; the proxy reads both spellings, and a server that escapes other characters of the method name is not handled.
- some-sass fails with a `TypeError` on `loadPaths` when the client answers its configuration request with null, which is what Claude Code sends for a plugin entry that has no `settings`. That is why `.lsp.json` carries a `somesass` settings object for it; keep one if you fork the file.
- The `php` profile also drops a typo in the project's own class, function or constant while `vendor` is missing: Intelephense cannot tell it from a missing dependency. It returns once `composer install` has run and the server has indexed `vendor` (7 to 14 s for 17,000 files in the test above); a genuine undefined class written after that arrives after the quiet time. A project whose `composer.json` is never installed, or that moves `vendor` with `config.vendor-dir`, has these errors dropped for good; fork `.lsp.json` and remove `--profile php` for such a project.
- The TypeScript profile looks for `node_modules` the way module resolution does, in the file's directory and every directory above it, so a worktree under a checkout that has `node_modules` is not treated as uninstalled.
- JSON, ESLint and Tailwind servers are not shipped. JSON syntax errors are better caught by the tool that reads the file, and an ESLint server needs a project config and a custom client protocol.
- The index cache lives in `~/.config/intelephense/workspace/` (or under `$XDG_CONFIG_HOME`), one hashed directory of roughly 20 MB per workspace root, so each worktree root adds one. Intelephense rebuilds a missing cache on the next start, so deleting the whole directory is safe.

## Kotlin and Java

Not shipped, and the official `kotlin-lsp` plugin is best left disabled globally. In the transcripts since 20 October, agents made 2,439 Kotlin edits across 9 sessions and the language server produced one diagnostic. JetBrains' `kotlin-lsp` is in Alpha with experimental Android Gradle Plugin support. Its issue tracker reports 2.5 to 3.2 GB per JVM and a restart loop that leaks them ([#205](https://github.com/Kotlin/kotlin-lsp/issues/205)), servers that outlive the client and hold several GB ([#276](https://github.com/Kotlin/kotlin-lsp/issues/276)) and an Android import that builds every variant ([#291](https://github.com/Kotlin/kotlin-lsp/issues/291)); I did not measure these. `jdtls` needs Java 25 at a minimum, per its README. The authority for an Android project is Gradle (`./gradlew compileDebugKotlin`).

To use it in one project anyway, enable it there only, in that project's `.claude/settings.local.json`:

```json
{
    "enabledPlugins": {
        "kotlin-lsp@claude-plugins-official": true
    }
}
```
