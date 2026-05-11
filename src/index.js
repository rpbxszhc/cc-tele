import process from 'node:process';
import { Telegraf } from 'telegraf';
import { loadConfig, formatConfigSummary } from './config.js';
import { StateStore } from './state-store.js';
import { ChatQueueManager } from './chat-queue.js';
import { listWorkspaces, resolveAllowedWorkspace } from './workspaces.js';
import { runShell } from './shell-runner.js';
import { replyLong, sanitizeOutput } from './messages.js';

const checkConfig = process.argv.includes('--check-config');
const config = loadConfig({ requireToken: !checkConfig });

if (checkConfig) {
  console.log(formatConfigSummary(config));
  process.exit(0);
}

const store = new StateStore(config.stateFile, { defaultCwd: config.defaultCwd });
const queueManager = new ChatQueueManager({ config, store });
const activeShells = new Map();
const bot = new Telegraf(config.telegramToken);

function chatState(ctx) {
  return store.getChat(ctx.chat.id);
}

function helpText(ctx) {
  const chat = chatState(ctx);
  return [
    'Claude Code bridge commands',
    '',
    'Send any normal text message to enqueue it as a Claude Code prompt.',
    '',
    `Current cwd: ${chat.cwd}`,
    `Shell commands: ${config.enableShellCommands ? 'enabled' : 'disabled'}`,
    '',
    '/start - Show bridge status.',
    '/help - Show this help.',
    '/cwd - List current cwd and allowed workspaces.',
    '/cwd <path> - Switch cwd to an allowlisted directory or child directory.',
    '/status - Show cwd, Claude session, queue, and shell state.',
    '/cancel - Stop the active Claude run or shell command and clear queued prompts.',
    '/reset - Forget the stored Claude session for this chat.',
    '/sh <command> - Run a shell command in the current cwd when enabled.',
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

  store.updateChat(ctx.chat.id, { cwd: workspace, sessionId: null });
  await ctx.reply(`cwd switched to:\n${workspace}\nStored Claude session was cleared.`);
});

bot.command('status', async (ctx) => {
  const chat = chatState(ctx);
  const status = queueManager.status(ctx.chat.id);
  await ctx.reply([
    `cwd: ${chat.cwd}`,
    `session: ${chat.sessionId || '(none)'}`,
    `running: ${status.running ? 'yes' : 'no'}`,
    `queued: ${status.queued}`,
    `shell: ${activeShells.has(String(ctx.chat.id)) ? 'running' : 'idle'}`,
    status.activeStartedAt ? `active since: ${status.activeStartedAt}` : null,
  ].filter(Boolean).join('\n'));
});

bot.command('cancel', async (ctx) => {
  const result = queueManager.cancel(ctx.chat.id);
  const shell = activeShells.get(String(ctx.chat.id));
  if (shell) shell.cancel();

  if (!result.hadActive && result.dropped === 0 && !shell) {
    await ctx.reply('Nothing to cancel.');
    return;
  }
  await ctx.reply([
    'Cancel requested.',
    `Dropped queued prompts: ${result.dropped}`,
    shell ? 'Shell command: cancel requested' : null,
  ].filter(Boolean).join('\n'));
});

bot.command('reset', async (ctx) => {
  store.clearSession(ctx.chat.id);
  await ctx.reply('Stored Claude session was cleared.');
});

bot.command('sh', async (ctx) => {
  if (!config.enableShellCommands) {
    await ctx.reply('Shell commands are disabled. Set ENABLE_SHELL_COMMANDS=true and restart the service to enable /sh.');
    return;
  }

  const command = (ctx.message?.text || '').replace(/^\/sh(@\w+)?\s*/s, '').trim();
  if (!command) {
    await ctx.reply('Usage: /sh <command>');
    return;
  }

  const chatId = String(ctx.chat.id);
  if (activeShells.has(chatId)) {
    await ctx.reply('A shell command is already running for this chat. Use /cancel to stop it.');
    return;
  }

  const chat = chatState(ctx);
  const startedAt = Date.now();
  const runner = runShell({ command, cwd: chat.cwd, config });
  activeShells.set(chatId, runner);

  const typingTimer = setInterval(() => {
    ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  }, 4000);
  typingTimer.unref();

  try {
    await ctx.reply(`Running shell command in ${chat.cwd}`);
    const result = await runner.promise;
    const durationMs = Date.now() - startedAt;
    const status = result.timedOut
      ? `timed out after ${durationMs} ms`
      : `exit ${result.signal || result.code} in ${durationMs} ms`;
    const output = [
      `Command: ${command}`,
      `Status: ${status}`,
      result.stdout ? `stdout:\n${result.stdout}` : null,
      result.stderr ? `stderr:\n${result.stderr}` : null,
    ].filter(Boolean).join('\n\n');

    await replyLong(ctx, sanitizeOutput(output), config.messageChunkSize);
  } catch (error) {
    await replyLong(ctx, sanitizeOutput(`Shell command failed:\n${error.message}`), config.messageChunkSize);
  } finally {
    clearInterval(typingTimer);
    activeShells.delete(chatId);
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;
  queueManager.enqueue(ctx, text);
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
