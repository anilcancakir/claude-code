# Terminal setup: iTerm2 and the Claude Code CLI

A machine setup for running one Claude Code session per iTerm2 tab, independent of the plugin. Checked on Claude Code 2.1.302 and iTerm2 3.7.6, macOS.

## What it fixes

| Symptom | Cause | Fix |
|---|---|---|
| Scrolling up through a long reply shows its start mixed into older messages | The classic renderer redraws inside the terminal's own scrollback, and iTerm2 keeps 1000 lines by default | Fullscreen renderer |
| Copied text carries the reply's indentation and a newline at every wrap point | Native selection copies the screen cells, gutter and wrap points included | Copy inside Claude Code, or `/copy` |
| Selecting text in a shell tab copies it at once | iTerm2 "Copy to clipboard on selection" | Off. Claude Code's own Copy on select stays on: `Cmd+c` cannot reach Claude Code in iTerm2 ([Limits](#limits)), so copy on release is what keeps drag-and-paste working |
| `←` on an empty prompt backgrounds the session and opens agent view | `leftArrowOpensAgents` defaults to on | Off |
| A two-finger horizontal swipe no longer switches tabs | In the alternate screen, iTerm2 hands a horizontal scroll to the app as a mouse report or, with alternate mouse scroll on, as `←` and `→` keys; both take priority over swipe to switch tabs | Stop reporting horizontal scrolls, and keep alternate mouse scroll off or vertical only |
| A notification arrives every time a turn finishes | Claude Code sends `idle_prompt` ("Claude is waiting for your input") 60 seconds after a turn ends | [Notifications](#notifications): raise the idle threshold |
| A tab waiting on a question or a permission prompt is easy to miss | The banner is the only signal outside the tab | [Notifications](#notifications): a hook that bounces the dock icon |

## Apply

Needs `jq` (shipped with macOS 15 and later; `brew install jq` before that). Quit the Claude Code sessions in your tabs first: the renderer is chosen at launch, and quitting also keeps a session's own save from racing the edit. Each file is backed up before it is changed, and a symlinked file (a dotfiles setup) is edited through its target so the link survives.

```sh
ts=$(date +%Y%m%d%H%M%S)
[ -f ~/.claude/settings.json ] || echo '{}' > ~/.claude/settings.json

# Claude Code: fullscreen renderer. The env key forces the classic renderer over the tui setting.
f=$(realpath ~/.claude/settings.json); cp "$f" "$f.bak-terminal-$ts"
t=$(mktemp "$f.XXXX")
jq '.tui = "fullscreen" | del(.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)' "$f" > "$t" && mv "$t" "$f"

# Claude Code: no left arrow agent view, and copy on select back at its default (on). Both live in the global config.
f=$(realpath ~/.claude.json); cp "$f" "$f.bak-terminal-$ts"
t=$(mktemp "$f.XXXX")
jq '.leftArrowOpensAgents = false | del(.copyOnSelect)' "$f" > "$t" && chmod 600 "$t" && mv "$t" "$f"

# iTerm2: no copy on select, and horizontal swipes stay with iTerm2 for tab switching.
defaults write com.googlecode.iterm2 CopySelection -bool false
defaults write com.googlecode.iterm2 ReportHorizontalScrollEvents -bool false
defaults write com.googlecode.iterm2 AlternateMouseScroll -bool false
```

`AlternateMouseScroll` is the Advanced setting "Scroll wheel sends arrow keys when in alternate screen mode". It is off by default, but a machine that ever turned it on keeps it, and while it is on iTerm2 turns every horizontal swipe in a fullscreen Claude Code tab into `←` and `→` keys instead of a tab switch. Claude Code does not need it: it takes the vertical wheel through mouse reporting. To keep wheel scrolling in `less`, `man` or a mouseless `vim`, tick "Automatically enable alternate mouse scroll" and "Restrict alternate mouse scroll to vertical scrolling" in the profile instead (Profiles, Terminal); the restriction leaves horizontal swipes to iTerm2.

Then, in iTerm2 Settings, Profiles, Terminal, untick "Save lines to scrollback in alternate screen mode" for every profile you run Claude Code in. It is on by default and is a per-profile key that `defaults write` cannot reach; left on, fullscreen frames pile up in the native scrollback. Keep "Enable mouse reporting" on in the same pane (the default): wheel scrolling, clicks and selection inside Claude Code need it.

If you run Claude Code over SSH, also turn on General, Selection, "Applications in terminal may access clipboard" (off by default), or run `/terminal-setup` in iTerm2, which writes the same key: a remote session copies through OSC 52, which iTerm2 drops otherwise. Local copies go through `pbcopy` and do not need it.

Finally quit iTerm2 with Cmd+Q and open it again. When a long-running session makes that inconvenient, change the settings in the Settings window instead, which applies them to open tabs at once: a `defaults write` value does not reach a running iTerm2 until its next launch, so for a row that already shows the new value, set it to the other value and back. Checked for "Scroll wheel sends arrow keys when in alternate screen mode" (Advanced, Mouse): the swipe switched tabs in an open session straight away. If iTerm2 loads its settings from a custom folder or URL (General, Settings), make these changes in the Settings window instead, since that folder's copy can overwrite the `defaults write` values at the next launch.

The global config keys can also be set from inside a session with `/config leftArrowOpensAgents=false` and `/config copyOnSelect=true`, or toggled in `/config`. Claude Code re-reads `~/.claude.json` under a lock before it saves, so a value written while another session runs survives that session's next save.

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
| Copy a selection | Drag; the selection is on the clipboard when you release. `Ctrl+c` while it is still highlighted, or `Ctrl+Shift+c`, copies it again. `Cmd+c` does nothing ([Limits](#limits)) |
| Copy a whole reply as markdown | `/copy`; it picks a code block or the full reply |
| Native iTerm2 selection | Hold `Option` while dragging; this copies the screen as drawn, indentation and wraps included |
| Switch tabs | Two-finger horizontal swipe, or `Cmd+Shift+[` and `Cmd+Shift+]` |
| Garbled screen | `Ctrl+L` redraws |

The in-app selection is what fixes the copy shape: the fullscreen screen buffer records which rows are soft wraps and which cells are the gutter, so a selection is not expected to carry either. This has not been measured with a drag; `/copy` is the dependable route for a full reply.

## Notifications

With `preferredNotifChannel` set to `iterm2` (the default channel in iTerm2), Claude Code posts a macOS banner through iTerm2 for these events, measured on 2.1.302:

| Event | When | Notification type |
|---|---|---|
| A question (`AskUserQuestion`) or a permission prompt is open | about 6 seconds after it opens, if you have not touched the session | `permission_prompt` |
| An MCP server asks for input | after the same delay | `elicitation_dialog`, `elicitation_url_dialog` |
| A turn has ended | 60 seconds after the last reply, if you have not typed since | `idle_prompt` |

The first two mean a session is blocked on you; the last only means it finished. To keep the first and silence the last, and to have a blocked session bounce the dock icon until you switch to iTerm2, add a hook script and two settings. Quit the Claude Code sessions first, as for Apply.

```sh
mkdir -p ~/.claude/hooks
cat > ~/.claude/hooks/needs-you.sh <<'EOF'
#!/bin/sh
# Claude Code Notification hook: bounce the iTerm2 dock icon until iTerm2 is
# activated. The hook runs without a controlling terminal, so the sequence goes
# to the tty of the nearest ancestor that has one, which is the claude process.
cat > /dev/null
pid=$PPID
tty=
while [ "${pid:-1}" -gt 1 ]; do
    t=$(ps -o tty= -p "$pid" | tr -d ' ')
    case $t in
        ttys*) tty=/dev/$t; break ;;
    esac
    pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
[ -n "$tty" ] || exit 0
# Inside tmux the sequence needs the passthrough wrapper (and allow-passthrough on).
if [ -n "$TMUX" ]; then
    printf '\033Ptmux;\033\033]1337;RequestAttention=yes\007\033\\' > "$tty"
else
    printf '\033]1337;RequestAttention=yes\007' > "$tty"
fi
EOF
chmod +x ~/.claude/hooks/needs-you.sh

ts=$(date +%Y%m%d%H%M%S)
m='permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|worker_permission_prompt'

# Register the hook next to any Notification hooks already there (iTerm2's cc-status, for one).
f=$(realpath ~/.claude/settings.json); cp "$f" "$f.bak-notify-$ts"
t=$(mktemp "$f.XXXX")
jq --arg m "$m" '.hooks.Notification |= ((. // []) | map(select(.matcher != $m))
  + [{matcher: $m, hooks: [{type: "command", command: "~/.claude/hooks/needs-you.sh"}]}])' "$f" > "$t" && mv "$t" "$f"

# Push the idle notification out to 24 hours, which in practice turns it off.
f=$(realpath ~/.claude.json); cp "$f" "$f.bak-notify-$ts"
t=$(mktemp "$f.XXXX")
jq '.messageIdleNotifThresholdMs = 86400000' "$f" > "$t" && chmod 600 "$t" && mv "$t" "$f"
```

The matcher lists exact notification types, not a pattern. The banner itself still comes from Claude Code, so the hook adds the bounce without a second banner. macOS bounces the dock icon only while iTerm2 is not the active app; while it is, the tab's status dot (below) is the signal.

What else marks a blocked tab: iTerm2's Claude Code integration, once installed, adds hooks that run iTerm2's `cc-status` and set each tab's status dot. A tab waiting on you gets the blue "waiting" dot with a ring around it until you select it, and the dock badge counts waiting tabs while iTerm2 is in the background. iTerm2 posts no banner of its own for these status changes unless you tick Notify for a status in the Session Status tool's settings.

Two things these settings leave alone:

- A background session that finishes (`claude --bg`, `/background`) still posts "finished" (`agent_completed`). Only `preferredNotifChannel: "notifications_disabled"` silences it, and that silences the waiting banners as well.
- `preferredNotifChannel` is read from `~/.claude/settings.json` first; a copy in `~/.claude.json` is only a fallback.

If you hear the notification sound but see no banner, open Notification Center: an iTerm2 entry there means the banner was posted and hid itself, or showed on another display. macOS hides a banner after a few seconds; System Settings, Notifications, iTerm2, set to Persistent, keeps it until you close it, but every answered prompt then leaves one behind, because iTerm2 never withdraws a notification it posted.

## Limits

- `Cmd+c` cannot copy a selection made inside Claude Code in iTerm2. With the Command keys at their default (Profiles, Keys, General, "Left command (⌘) key"), iTerm2 never sends a Command key to the app, and Edit, Copy only copies iTerm2's own selection. Setting the Command keys to Super does send `Cmd+c` through, but iTerm2 then routes every Command shortcut in that session to the app ahead of its menus, so `Cmd+v`, `Cmd+t`, `Cmd+w` and the rest stop working in Claude Code tabs. Keep Copy on select on, and use `Ctrl+c` while the selection is active, `Ctrl+Shift+c`, or `/copy`. Before fullscreen, `Cmd+c` worked because the classic renderer leaves selection to iTerm2.
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

# Notifications
m='permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|worker_permission_prompt'
f=$(realpath ~/.claude/settings.json); t=$(mktemp "$f.XXXX"); jq --arg m "$m" '.hooks.Notification |= map(select(.matcher != $m))' "$f" > "$t" && mv "$t" "$f"
f=$(realpath ~/.claude.json); t=$(mktemp "$f.XXXX"); jq 'del(.messageIdleNotifThresholdMs)' "$f" > "$t" && chmod 600 "$t" && mv "$t" "$f"
rm ~/.claude/hooks/needs-you.sh
```

Then quit iTerm2 with Cmd+Q and open it again.

Sources: [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md), [Agent view](https://code.claude.com/docs/en/agent-view.md), [Terminal configuration](https://code.claude.com/docs/en/terminal-config.md), the iTerm2 3.7.6 notes "When mouse reporting is on, horizontal scrolling does not switch tabs." and "Alternate mouse scroll takes priority over swipe to switch tabs.", and its source at `v3.7.6` (`PTYMouseHandler.m`, `scrollWheelShouldSendDataForEvent:at:`; `iTermModernKeyMapper.swift` and `PTYSession.m` `handleKeyDownWithBuckyBits:` for the Command keys; `PTYSession.m` `RequestAttention` for the dock bounce). The notification timings were measured with logging hooks in a nested Claude Code 2.1.302 session.
