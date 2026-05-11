# cc-tele

Self-hosted Telegram bridge for Claude Code on Fedora. It uses the local `claude` CLI and sources `~/.claude.sh`, so your Anthropic-compatible provider config can stay in one place.

## Setup

```bash
git clone <your-repo-url> ~/z/cc-tele
cd ~/z/cc-tele
npm install
cp config.example.env .env
chmod 600 .env
```

If you already configured the official Telegram channel, reuse its token:

```bash
grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env > .env
cat config.example.env | grep -v '^TELEGRAM_BOT_TOKEN=' >> .env
chmod 600 .env
```

Edit `ALLOWED_WORKSPACES` before exposing the bot. `/cwd` can switch only to those directories.

## Run

```bash
npm run check
npm start
```

## systemd user service

```bash
mkdir -p ~/.config/systemd/user
cp ~/z/cc-tele/systemd/cc-tele.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cc-tele.service
journalctl --user -u cc-tele.service -f
```

The included unit assumes the repo lives at `~/z/cc-tele`. If you clone it elsewhere, edit `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` before enabling the service.

To keep it running after logout:

```bash
loginctl enable-linger "$USER"
```

## Telegram commands

- `/start` shows bot status and chat id.
- `/cwd` lists allowed workspaces.
- `/cwd <name-or-path>` switches to an allowlisted workspace.
- `/status` shows current cwd, session, and queue state.
- `/cancel` terminates the active Claude run and clears queued prompts.
- `/reset` forgets the stored Claude session for the chat.

Any normal text message is queued as a Claude Code prompt.
