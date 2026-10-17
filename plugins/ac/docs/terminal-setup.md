# Terminal setup: iTerm2 and the Claude Code CLI

A machine setup for running one Claude Code session per iTerm2 tab, independent of the plugin. Checked on Claude Code 2.1.302 and iTerm2 3.7.6, macOS.

## What it fixes

| Symptom | Cause | Fix |
|---|---|---|
| Scrolling up through a long reply shows its start mixed into older messages | The classic renderer redraws inside the terminal's own scrollback, and iTerm2 keeps 1000 lines by default | Fullscreen renderer |
| Copied text carries the reply's indentation and a newline at every wrap point | Native selection copies the screen cells, gutter and wrap points included | Copy inside Claude Code, or `/copy` |
| Selecting text copies it at once | iTerm2 "Copy to clipboard on selection", and Claude Code's own Copy on select | Both off |
| `←` on an empty prompt backgrounds the session and opens agent view | `leftArrowOpensAgents` defaults to on | Off |
| A two-finger horizontal swipe no longer switches tabs | In the alternate screen, iTerm2 hands a horizontal scroll to the app as a mouse report or, with alternate mouse scroll on, as `←` and `→` keys; both take priority over swipe to switch tabs | Stop reporting horizontal scrolls, and keep alternate mouse scroll off or vertical only |

## Apply

Needs `jq` (shipped with macOS 15 and later; `brew install jq` before that). Quit the Claude Code sessions in your tabs first: the renderer is chosen at launch, and quitting also keeps a session's own save from racing the edit. Each file is backed up before it is changed, and a symlinked file (a dotfiles setup) is edited through its target so the link survives.

```sh
ts=$(date +%Y%m%d%H%M%S)
[ -f ~/.claude/settings.json ] || echo '{}' > ~/.claude/settings.json

# Claude Code: fullscreen renderer. The env key forces the classic renderer over the tui setting.
f=$(realpath ~/.claude/settings.json); cp "$f" "$f.bak-terminal-$ts"
t=$(mktemp "$f.XXXX")
jq '.tui = "fullscreen" | del(.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)' "$f" > "$t" && mv "$t" "$f"

# Claude Code: no left arrow agent view, no copy on select. Both live in the global config.
f=$(realpath ~/.claude.json); cp "$f" "$f.bak-terminal-$ts"
t=$(mktemp "$f.XXXX")
jq '.leftArrowOpensAgents = false | .copyOnSelect = false' "$f" > "$t" && chmod 600 "$t" && mv "$t" "$f"

# iTerm2: no copy on select, and horizontal swipes stay with iTerm2 for tab switching.
defaults write com.googlecode.iterm2 CopySelection -bool false
defaults write com.googlecode.iterm2 ReportHorizontalScrollEvents -bool false
defaults write com.googlecode.iterm2 AlternateMouseScroll -bool false
```

`AlternateMouseScroll` is the Advanced setting "Scroll wheel sends arrow keys when in alternate screen mode". It is off by default, but a machine that ever turned it on keeps it, and while it is on iTerm2 turns every horizontal swipe in a fullscreen Claude Code tab into `←` and `→` keys instead of a tab switch. Claude Code does not need it: it takes the vertical wheel through mouse reporting. To keep wheel scrolling in `less`, `man` or a mouseless `vim`, tick "Automatically enable alternate mouse scroll" and "Restrict alternate mouse scroll to vertical scrolling" in the profile instead (Profiles, Terminal); the restriction leaves horizontal swipes to iTerm2.

Then, in iTerm2 Settings, Profiles, Terminal, untick "Save lines to scrollback in alternate screen mode" for every profile you run Claude Code in. It is on by default and is a per-profile key that `defaults write` cannot reach; left on, fullscreen frames pile up in the native scrollback. Keep "Enable mouse reporting" on in the same pane (the default): wheel scrolling, clicks and selection inside Claude Code need it.

If you run Claude Code over SSH, also turn on General, Selection, "Applications in terminal may access clipboard" (off by default), or run `/terminal-setup` in iTerm2, which writes the same key: a remote session copies through OSC 52, which iTerm2 drops otherwise. Local copies go through `pbcopy` and do not need it.

Finally quit iTerm2 with Cmd+Q and open it again. If iTerm2 loads its settings from a custom folder or URL (General, Settings), make these changes in the Settings window instead, since that folder's copy can overwrite the `defaults write` values at the next launch.

The two global config keys can also be set from inside a session with `/config leftArrowOpensAgents=false` and `/config copyOnSelect=false`, or toggled in `/config`. Claude Code re-reads `~/.claude.json` under a lock before it saves, so a value written while another session runs survives that session's next save.

Check, in a new tab:

```sh
claude          # then type /tui; it prints "Current renderer: fullscreen"
```

Press `←` on the empty prompt: nothing happens.

If `/tui` still says `default`, something else forces the classic renderer: `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` or `CLAUDE_CODE_NO_FLICKER=0` exported from a shell rc (`env | grep CLAUDE_CODE_`), or an `env` or `tui` entry in a project `.claude/settings*.json` or a managed settings file.

The native scrollback (Profiles, Terminal, Scrollback lines) no longer holds the conversation, so its size only matters for plain shell work.

## Using it

Fullscreen draws the conversation itself, like `vim`, and only renders what is visible, which keeps memory flat in long sessions.

| Task | How |
|---|---|
| Scroll | Mouse wheel or trackpad; `PgUp` and `PgDn` (`Fn+↑` and `Fn+↓` on a MacBook) |
| Back to the latest output | Scroll to the bottom or click `Jump to bottom` |
| Search | `Ctrl+o` for transcript mode, then `/`, then `n` and `N` |
| Hand the conversation to iTerm2's Cmd+F | `Ctrl+o`, then `[`; `Esc` returns to fullscreen |
| Copy a selection | Drag, then `Cmd+c`, `Ctrl+Shift+c`, or `Ctrl+c` while the selection is active |
| Copy a whole reply as markdown | `/copy`; it picks a code block or the full reply |
| Native iTerm2 selection | Hold `Option` while dragging; this copies the screen as drawn, indentation and wraps included |
| Switch tabs | Two-finger horizontal swipe, or `Cmd+Shift+[` and `Cmd+Shift+]` |
| Garbled screen | `Ctrl+L` redraws |

The in-app selection is what fixes the copy shape: the fullscreen screen buffer records which rows are soft wraps and which cells are the gutter, so a selection is not expected to carry either. This has not been measured with a drag; `/copy` is the dependable route for a full reply.

## Limits

- `leftArrowOpensAgents` covers foreground sessions only. In a background session you attached to (`claude --bg`, `/background`, `claude attach`, or a session opened from agent view), `←` on an empty prompt always detaches. For one tab per session, start each with plain `claude`.
- Background sessions always render fullscreen, whatever `tui` says.
- Do not use fullscreen inside iTerm2's `tmux -CC` integration mode; the wheel stops working there. Plain `tmux` is fine with `set -g mouse on`.
- Fullscreen is a research preview. `/tui default` switches back in place and saves the choice.

## Revert

```sh
f=$(realpath ~/.claude/settings.json); t=$(mktemp "$f.XXXX"); jq '.tui = "default"' "$f" > "$t" && mv "$t" "$f"
f=$(realpath ~/.claude.json); t=$(mktemp "$f.XXXX"); jq 'del(.leftArrowOpensAgents, .copyOnSelect)' "$f" > "$t" && chmod 600 "$t" && mv "$t" "$f"
defaults delete com.googlecode.iterm2 CopySelection
defaults delete com.googlecode.iterm2 ReportHorizontalScrollEvents
defaults delete com.googlecode.iterm2 AlternateMouseScroll
```

Then quit iTerm2 with Cmd+Q and open it again.

Sources: [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md), [Agent view](https://code.claude.com/docs/en/agent-view.md), [Terminal configuration](https://code.claude.com/docs/en/terminal-config.md), the iTerm2 3.7.6 notes "When mouse reporting is on, horizontal scrolling does not switch tabs." and "Alternate mouse scroll takes priority over swipe to switch tabs.", and its source at `v3.7.6` (`PTYMouseHandler.m`, `scrollWheelShouldSendDataForEvent:at:`).
