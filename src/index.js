import process from 'node:process';
import { Telegraf } from 'telegraf';
import { loadConfig, formatConfigSummary } from './config.js';
import { StateStore } from './state-store.js';
import { listWorkspaces, resolveAllowedWorkspace } from './workspaces.js';
import {
  createClaudePty,
  createShellPty,
  supportedKeys,
} from './pty-session.js';
import { sanitizeOutput } from './messages.js';

const checkConfig = process.argv.includes('--check-config');
const config = loadConfig({ requireToken: !checkConfig });

if (checkConfig) {
  console.log(formatConfigSummary(config));
  process.exit(0);
}

const store = new StateStore(config.stateFile, { defaultCwd: config.defaultCwd });
const sessions = new Map();
const bot = new Telegraf(config.telegramToken);

function chatState(ctx) {
  return store.getChat(ctx.chat.id);
}

function chatSessions(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, { shell: null, claude: null });
  }
  return sessions.get(key);
}

function uptime(startedAt) {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function truncateMiddle(text, maxLength) {
  if (text.length <= maxLength) return text;
  const keep = Math.max(0, maxLength - 80);
  return `[truncated ${text.length - keep} chars]\n${text.slice(text.length - keep)}`;
}

function sessionText(session) {
  const exitValue = session.exitInfo?.signal ?? session.exitInfo?.code ?? 'unknown';
  const status = session.running
    ? `running for ${uptime(session.startedAt)}`
    : `exited ${exitValue}`;
  const header = [
    `${session.kind} PTY: ${status}`,
    `cwd: ${session.cwd}`,
    `command: ${session.label}`,
    '---',
  ].join('\n');
  const body = sanitizeOutput(session.screen || '(no output yet)');
  return truncateMiddle(`${header}\n${body}`, config.messageChunkSize);
}

async function renderSession(ctx, session, force = false) {
  if (force && session.renderTimer) {
    clearTimeout(session.renderTimer);
    session.renderTimer = null;
  }
  if (!force && session.renderTimer) return;
  const delay = force ? 0 : config.ptyOutputIntervalMs;
  session.renderTimer = setTimeout(async () => {
    session.renderTimer = null;
    const text = sessionText(session);
    try {
      if (session.messageId) {
        await ctx.telegram.editMessageText(ctx.chat.id, session.messageId, undefined, text);
      } else {
        const message = await ctx.reply(text);
        session.messageId = message.message_id;
      }
    } catch {
      const message = await ctx.reply(text);
      session.messageId = message.message_id;
    }
  }, delay);
  session.renderTimer.unref();
}

async function attachSession(ctx, session) {
  const message = await ctx.reply(sessionText(session));
  session.messageId = message.message_id;
  session.on('output', () => {
    void renderSession(ctx, session);
  });
  session.on('exit', () => {
    void renderSession(ctx, session, true);
  });
  session.on('error', async (error) => {
    await ctx.reply(`PTY error: ${error.message}`);
  });
}

function stopSession(session) {
  if (session?.running) session.terminate();
}

function stopAll(chatId) {
  const group = chatSessions(chatId);
  const stopped = [];
  for (const kind of ['shell', 'claude']) {
    if (group[kind]?.running) {
      stopSession(group[kind]);
      stopped.push(kind);
    }
    group[kind] = null;
  }
  return stopped;
}

function resolveTargetSession(ctx, rawText, commandName) {
  const group = chatSessions(ctx.chat.id);
  const text = rawText.replace(new RegExp(`^/${commandName}(@\\w+)?\\s*`, 's'), '');
  const trimmed = text.trimStart();
  const firstSpace = trimmed.search(/\s/);
  const first = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (first === 'shell' || first === 'claude') {
    return {
      target: group[first],
      targetName: first,
      rest: firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1),
    };
  }

  const active = [
    ['shell', group.shell],
    ['claude', group.claude],
  ].filter(([, session]) => session?.running);

  if (active.length === 1) {
    return { targetName: active[0][0], target: active[0][1], rest: text };
  }

  return { targetName: null, target: null, rest: text, ambiguous: active.length > 1 };
}

function helpText(ctx) {
  const chat = chatState(ctx);
  return [
    'Claude Code bridge commands',
    '',
    'Plain text sends a prompt to the Claude PTY, like /ask.',
    '',
    `Current cwd: ${chat.cwd}`,
    `PTY: ${config.enablePty ? 'enabled' : 'disabled'}`,
    `Shell commands: ${config.enableShellCommands ? 'enabled' : 'disabled'}`,
    '',
    '/start - Show bridge status.',
    '/help - Show this help.',
    '/cwd - List current cwd and allowed workspaces.',
    '/cwd <path> - Switch cwd, stopping active PTY sessions first.',
    '/status - Show cwd and active PTY sessions.',
    '/cancel - Stop active shell and Claude PTY sessions.',
    '/reset - Stop Claude PTY and clear stored session metadata.',
    '/claude - Start an interactive Claude Code PTY.',
    '/ask <prompt> - Send a prompt plus Enter to Claude PTY.',
    '/sh <command> - Run a shell command in a shell PTY when enabled.',
    '/type [shell|claude] <text> - Send raw text to a PTY.',
    '/key [shell|claude] <key> - Send a terminal key.',
    '/eof [shell|claude] - Send Ctrl-D to a PTY.',
    '',
    `Keys: ${supportedKeys().join(', ')}`,
  ].join('\n');
}

bot.start(async (ctx) => {
  const chat = chatState(ctx);
  await ctx.reply([
    'Claude Code bridge is running.',
    `chat: ${ctx.chat.id}`,
    `cwd: ${chat.cwd}`,
    'Use /help to list commands.',
  ].join('\n'));
});

bot.help(async (ctx) => {
  await ctx.reply(helpText(ctx));
});

bot.command('cwd', async (ctx) => {
  const text = ctx.message?.text || '';
  const requested = text.replace(/^\/cwd(@\w+)?\s*/, '').trim();

  if (!requested) {
    const chat = chatState(ctx);
    const workspaces = listWorkspaces(config)
      .map((workspace) => `${workspace.label}: ${workspace.path}`)
      .join('\n');
    await ctx.reply(`Current cwd:\n${chat.cwd}\n\nAllowed workspaces:\n${workspaces}`);
    return;
  }

  const workspace = resolveAllowedWorkspace(requested, config, chatState(ctx).cwd);
  if (!workspace) {
    await ctx.reply('Rejected: that path is not in ALLOWED_WORKSPACES.');
    return;
  }

  const stopped = stopAll(ctx.chat.id);
  store.updateChat(ctx.chat.id, { cwd: workspace, sessionId: null });
  await ctx.reply([
    stopped.length ? `Stopped active PTY sessions: ${stopped.join(', ')}` : null,
    `cwd switched to:\n${workspace}`,
    'Stored Claude session was cleared.',
  ].filter(Boolean).join('\n'));
});

bot.command('status', async (ctx) => {
  const chat = chatState(ctx);
  const group = chatSessions(ctx.chat.id);
  const format = (name, session) => {
    if (!session?.running) return `${name}: idle`;
    return `${name}: running for ${uptime(session.startedAt)} (${session.label})`;
  };
  await ctx.reply([
    `cwd: ${chat.cwd}`,
    `session: ${chat.sessionId || '(none)'}`,
    format('shell', group.shell),
    format('claude', group.claude),
  ].join('\n'));
});

bot.command('cancel', async (ctx) => {
  const stopped = stopAll(ctx.chat.id);
  await ctx.reply(stopped.length ? `Cancel requested: ${stopped.join(', ')}` : 'Nothing to cancel.');
});

bot.command('reset', async (ctx) => {
  const group = chatSessions(ctx.chat.id);
  stopSession(group.claude);
  group.claude = null;
  store.clearSession(ctx.chat.id);
  await ctx.reply('Claude PTY was stopped and stored session metadata was cleared.');
});

async function startClaude(ctx) {
  if (!config.enablePty) {
    await ctx.reply('PTY mode is disabled. Set ENABLE_PTY=true and restart the service.');
    return null;
  }
  const group = chatSessions(ctx.chat.id);
  if (group.claude?.running) return group.claude;

  const chat = chatState(ctx);
  const session = createClaudePty({ cwd: chat.cwd, config });
  group.claude = session;
  await attachSession(ctx, session);
  return session;
}

bot.command('claude', async (ctx) => {
  const session = await startClaude(ctx);
  if (session) await ctx.reply('Claude PTY is ready. Use /ask <prompt>, /type claude <text>, or /key claude enter.');
});

bot.command('ask', async (ctx) => {
  const prompt = (ctx.message?.text || '').replace(/^\/ask(@\w+)?\s*/s, '').trim();
  if (!prompt) {
    await ctx.reply('Usage: /ask <prompt>');
    return;
  }
  const session = await startClaude(ctx);
  if (!session) return;
  session.write(`${prompt}\r`);
  await ctx.reply('Sent to Claude PTY.');
});

bot.command('sh', async (ctx) => {
  if (!config.enablePty) {
    await ctx.reply('PTY mode is disabled. Set ENABLE_PTY=true and restart the service.');
    return;
  }
  if (!config.enableShellCommands) {
    await ctx.reply('Shell commands are disabled. Set ENABLE_SHELL_COMMANDS=true and restart the service to enable /sh.');
    return;
  }

  const command = (ctx.message?.text || '').replace(/^\/sh(@\w+)?\s*/s, '').trim();
  if (!command) {
    await ctx.reply('Usage: /sh <command>');
    return;
  }

  const group = chatSessions(ctx.chat.id);
  if (group.shell?.running) {
    await ctx.reply('A shell PTY is already running for this chat. Use /cancel to stop it.');
    return;
  }

  const chat = chatState(ctx);
  const session = createShellPty({ command, cwd: chat.cwd, config });
  group.shell = session;
  await attachSession(ctx, session);
});

bot.command('type', async (ctx) => {
  const { target, ambiguous, rest } = resolveTargetSession(ctx, ctx.message?.text || '', 'type');
  if (ambiguous) {
    await ctx.reply('Both shell and Claude PTY are running. Use /type shell <text> or /type claude <text>.');
    return;
  }
  if (!target?.running) {
    await ctx.reply('No active PTY target. Start /claude or /sh first.');
    return;
  }
  if (!rest) {
    await ctx.reply('Usage: /type [shell|claude] <text>');
    return;
  }
  target.write(rest);
  await ctx.reply('Input sent.');
});

bot.command('key', async (ctx) => {
  const { target, ambiguous, rest } = resolveTargetSession(ctx, ctx.message?.text || '', 'key');
  if (ambiguous) {
    await ctx.reply('Both shell and Claude PTY are running. Use /key shell <key> or /key claude <key>.');
    return;
  }
  if (!target?.running) {
    await ctx.reply('No active PTY target. Start /claude or /sh first.');
    return;
  }

  const key = rest.trim();
  if (!key || !target.key(key)) {
    await ctx.reply(`Usage: /key [shell|claude] <key>\nSupported keys: ${supportedKeys().join(', ')}`);
    return;
  }
  await ctx.reply(`Key sent: ${key}`);
});

bot.command('eof', async (ctx) => {
  const { target, ambiguous } = resolveTargetSession(ctx, ctx.message?.text || '', 'eof');
  if (ambiguous) {
    await ctx.reply('Both shell and Claude PTY are running. Use /eof shell or /eof claude.');
    return;
  }
  if (!target?.running) {
    await ctx.reply('No active PTY target.');
    return;
  }
  target.eof();
  await ctx.reply('Ctrl-D sent.');
});

bot.on('text', async (ctx) => {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;
  const session = await startClaude(ctx);
  if (!session) return;
  session.write(`${text}\r`);
  await ctx.reply('Sent to Claude PTY.');
});

bot.catch((error, ctx) => {
  console.error('bot error', error);
  if (ctx?.reply) {
    ctx.reply(`Bot error: ${error.message}`).catch(() => {});
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const me = await bot.telegram.getMe();
console.log(`cc-tele is running as @${me.username || me.id}`);

bot.launch({
  allowedUpdates: ['message'],
}).catch((error) => {
  console.error('failed to launch bot', error);
  process.exitCode = 1;
});
