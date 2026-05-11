import process from 'node:process';
import { Telegraf } from 'telegraf';
import { loadConfig, formatConfigSummary } from './config.js';
import { StateStore } from './state-store.js';
import { ChatQueueManager } from './chat-queue.js';
import { listWorkspaces, resolveAllowedWorkspace } from './workspaces.js';

const checkConfig = process.argv.includes('--check-config');
const config = loadConfig({ requireToken: !checkConfig });

if (checkConfig) {
  console.log(formatConfigSummary(config));
  process.exit(0);
}

const store = new StateStore(config.stateFile, { defaultCwd: config.defaultCwd });
const queueManager = new ChatQueueManager({ config, store });
const bot = new Telegraf(config.telegramToken);

function chatState(ctx) {
  return store.getChat(ctx.chat.id);
}

bot.start(async (ctx) => {
  const chat = chatState(ctx);
  await ctx.reply([
    'Claude Code bridge is running.',
    `chat: ${ctx.chat.id}`,
    `cwd: ${chat.cwd}`,
    'Use /cwd, /status, /cancel, or send a prompt.',
  ].join('\n'));
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
    status.activeStartedAt ? `active since: ${status.activeStartedAt}` : null,
  ].filter(Boolean).join('\n'));
});

bot.command('cancel', async (ctx) => {
  const result = queueManager.cancel(ctx.chat.id);
  if (!result.hadActive && result.dropped === 0) {
    await ctx.reply('Nothing to cancel.');
    return;
  }
  await ctx.reply(`Cancel requested. Dropped queued prompts: ${result.dropped}`);
});

bot.command('reset', async (ctx) => {
  store.clearSession(ctx.chat.id);
  await ctx.reply('Stored Claude session was cleared.');
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
