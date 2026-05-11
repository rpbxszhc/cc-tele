# cc-tele

Self-hosted Telegram bridge for Claude Code. It receives Telegram Bot API updates by long polling, runs the local `claude` CLI, and returns Claude Code results back to Telegram.

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
- `ENABLE_SHELL_COMMANDS`: enables `/sh <command>` when set to `true`.
- `SHELL_TIMEOUT_MS`: timeout for `/sh` commands.
- `SHELL_MAX_OUTPUT_CHARS`: maximum captured stdout/stderr characters per stream.
- `STATE_FILE`: local chat/session state path.

For installations that already have a Claude Code Telegram channel file, the token can be copied into `.env`:

```bash
grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env > .env
cat config.example.env | grep -v '^TELEGRAM_BOT_TOKEN=' >> .env
chmod 600 .env
```

Review `ALLOWED_WORKSPACES` carefully before exposing the bot. Telegram users with access to the bot can switch only to those directories, but Claude Code may edit files inside the selected workspace depending on the configured permission mode.

`/sh` is disabled by default. Enabling it makes the Telegram bot token equivalent to shell access on the host user account.

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
- `/cancel` terminates the active Claude run and clears queued prompts.
- `/reset` forgets the stored Claude session for the chat.
- `/sh <command>` runs a shell command in the current chat cwd when enabled.

Any normal text message is queued as a Claude Code prompt.
