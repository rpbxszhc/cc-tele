# cc-tele

Self-hosted Telegram bridge for Claude Code. It receives Telegram Bot API updates by long polling, runs shell commands and Claude Code in PTY-backed sessions, and returns terminal output back to Telegram.

The bridge is designed for users who already run Claude Code with an Anthropic-compatible provider configuration, such as a shell file that exports `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and model variables.

This is a vibe-coding project built with Codex assistance.

## Requirements

- Linux with Node.js 20 or newer.
- Claude Code installed and available as `claude`.
- A Telegram bot token from BotFather.
- A provider environment file, defaulting to `~/.claude.sh`.

## Setup

```bash
git clone https://github.com/rpbxszhc/cc-tele.git
cd cc-tele
npm install
cp config.example.env .env
chmod 600 .env
```

Edit `.env` before starting the bot:

- `TELEGRAM_BOT_TOKEN`: Telegram bot token.
- `CLAUDE_ENV_FILE`: shell file sourced before each `claude` run.
- `DEFAULT_CWD`: initial workspace for new chats.
- `ALLOWED_WORKSPACES`: comma-separated allowlist for `/cwd`; `*` expands one directory level.
- `CLAUDE_PERMISSION_MODE`: defaults to `acceptEdits`.
- `ENABLE_PTY`: enables PTY-backed shell and Claude sessions.
- `PTY_OUTPUT_INTERVAL_MS`: throttle interval for Telegram message edits.
- `PTY_SCREEN_LINES`: number of terminal output lines retained in Telegram.
- `PTY_IDLE_TIMEOUT_MS`: idle timeout for PTY sessions.
- `PTY_HARD_TIMEOUT_MS`: hard timeout for PTY sessions; `0` disables it.
- `ENABLE_SHELL_COMMANDS`: enables `/sh <command>` when set to `true`.
- `STATE_FILE`: local chat/session state path.

For installations that already have a Claude Code Telegram channel file, the token can be copied into `.env`:

```bash
grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env > .env
cat config.example.env | grep -v '^TELEGRAM_BOT_TOKEN=' >> .env
chmod 600 .env
```

Review `ALLOWED_WORKSPACES` carefully before exposing the bot. Telegram users with access to the bot can switch only to those directories, but Claude Code and PTY shell commands may edit files inside the selected workspace depending on the configured permission mode and shell access.

PTY mode makes Telegram bot access equivalent to interactive terminal access on the host user account. `/sh` is disabled by default; enabling it allows arbitrary shell commands from Telegram.

## Run

```bash
npm run check
npm start
```

## systemd user service

The included unit assumes the repository is installed at `~/z/cc-tele`. For another location, edit `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` before enabling the service.

```bash
mkdir -p ~/.config/systemd/user
cp ~/z/cc-tele/systemd/cc-tele.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cc-tele.service
journalctl --user -u cc-tele.service -f
```

To keep a user service running after logout:

```bash
loginctl enable-linger "$USER"
```

## Telegram commands

- `/start` shows bot status and chat id.
- `/help` lists available commands.
- `/cwd` lists allowed workspaces.
- `/cwd <name-or-path>` switches to an allowlisted workspace.
- `/status` shows current cwd, session, and queue state.
- `/cancel` terminates active shell and Claude PTY sessions.
- `/reset` stops the Claude PTY and clears stored session metadata.
- `/claude` starts an interactive Claude Code PTY.
- `/ask <prompt>` sends a prompt plus Enter to the Claude PTY.
- `/sh <command>` runs a shell command in the current chat cwd when enabled.
- `/screen [shell|claude]` sends the latest PTY screen as a new message.
- `/type [shell|claude] <text>` sends raw text to a PTY session.
- `/key [shell|claude] <key>` sends a terminal key such as `enter`, `tab`, `ctrl-c`, `ctrl-d`, arrows, or `backspace`.
- `/eof [shell|claude]` sends Ctrl-D to a PTY session.

Any normal text message is sent to the Claude PTY as a prompt, equivalent to `/ask <prompt>`.

When both shell and Claude PTY sessions are active, target input explicitly:

```text
/type shell hello
/key shell enter
/type claude please summarize this repo
/key claude enter
```

Because `/sh` allocates a PTY, commands such as `sudo dnf update` can show an interactive password prompt. For private deployments, enter a password with `/type` and `/key enter`; avoid doing this in shared chats or group chats. A narrow `NOPASSWD` sudoers rule for exact maintenance commands is safer.

```text
/sh sudo dnf update
/type shell <password>
/key shell enter
```
