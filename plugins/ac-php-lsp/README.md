# ac-php-lsp

Intelephense for Claude Code, with a workspace exclude list that keeps indexing finite in repositories that hold Claude Code worktrees or Flutter build output.

## Why not the stock `php-lsp`

The official `php-lsp` plugin starts Intelephense with no settings, so it indexes with Intelephense's default excludes. Two kinds of directory make that go wrong:

- **`build/`.** After `flutter build ios` or `flutter build macos`, `build/` can hold Xcode SourcePackages for the app's Swift Package Manager dependencies: tens of thousands of files and hundreds of symlinks. Intelephense's file search stalls on it, `indexingEnded` does not arrive, and every cross-file request (definition, references, workspace symbols) comes back empty. Measured on a Flutter plus Laravel monorepo with a 62,788-file `build/`: rooted at that checkout, no index within 150 s on the defaults and 11,614 files indexed in 9.4 s with `build/` excluded; rooted at the main checkout that holds it as a worktree, no index within 6 minutes on the defaults.
- **`.claude/worktrees/`.** `claude --worktree` creates each worktree inside the main checkout. A session in the main checkout then indexes every worktree too, its own `vendor/` included: goToDefinition returns one result per copy, and one worktree took the server from 597 MB to 975 MB.

## Install

Disable the stock plugin first. When two plugins claim `.php`, Claude Code routes `.php` to whichever loads first and never starts the other one for it.

```
/plugin marketplace add anilcancakir/claude-code
/plugin disable php-lsp@claude-plugins-official
/plugin install ac-php-lsp@ac
```

A project that enables `php-lsp@claude-plugins-official` in its own `.claude/settings.json` turns it back on there. Override it in that project's `.claude/settings.local.json`:

```json
{
    "enabledPlugins": {
        "php-lsp@claude-plugins-official": false
    }
}
```

Intelephense itself comes from npm:

```
npm install -g intelephense
```

## Behaviour to know

- Claude Code roots the server at the session's working directory the first time a `.php` file is touched, and keeps that root for the session. Start worktree sessions with `claude --worktree <name>` so the worktree is the root.
- After `EnterWorktree` in a session whose PHP server is already running, the server stays rooted at the main checkout, and the worktree's files fall under the `.claude/worktrees` exclude. Intelephense answers nothing for an excluded file, even an open one. Start a new session in the worktree for PHP work there. `/reload-plugins` is meant to restart language servers, but whether it re-roots them has not been verified.
- A PHP source directory named `build/` is excluded as well (the match is case-sensitive, so `app/Build/` is not). Fork the plugin if a project keeps code there.
- The index cache lives in `~/.config/intelephense/workspace/` (or under `$XDG_CONFIG_HOME`), one hashed directory of roughly 20 MB per workspace root, so each worktree root adds one. Intelephense rebuilds a missing cache on the next start, so deleting the whole directory is safe.
