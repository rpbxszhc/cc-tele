import { runClaude } from './claude-runner.js';
import { replyLong, sanitizeOutput } from './messages.js';

export class ChatQueueManager {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    this.queues = new Map();
  }

  status(chatId) {
    const queue = this.#queue(chatId);
    return {
      running: Boolean(queue.active),
      queued: queue.items.length,
      activeStartedAt: queue.active?.startedAt || null,
    };
  }

  enqueue(ctx, prompt) {
    const chatId = ctx.chat.id;
    const queue = this.#queue(chatId);
    queue.items.push({ ctx, prompt, enqueuedAt: new Date().toISOString() });
    const position = queue.items.length + (queue.active ? 1 : 0);
    if (position > 1) {
      void ctx.reply(`Queued at position ${position}.`);
    }
    void this.#drain(chatId);
  }

  cancel(chatId) {
    const queue = this.#queue(chatId);
    const hadActive = Boolean(queue.active);
    const dropped = queue.items.length;
    queue.items = [];
    if (queue.active) {
      queue.active.runner.cancel();
    }
    return { hadActive, dropped };
  }

  #queue(chatId) {
    const key = String(chatId);
    if (!this.queues.has(key)) {
      this.queues.set(key, { active: null, items: [] });
    }
    return this.queues.get(key);
  }

  async #drain(chatId) {
    const queue = this.#queue(chatId);
    if (queue.active) return;

    const item = queue.items.shift();
    if (!item) return;

    const chat = this.store.getChat(chatId);
    const cwd = chat.cwd;
    const sessionId = chat.sessionId;
    const startedAt = new Date();
    const runner = runClaude({
      prompt: item.prompt,
      cwd,
      sessionId,
      config: this.config,
    });

    queue.active = { runner, startedAt: startedAt.toISOString() };

    const typingTimer = setInterval(() => {
      item.ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);
    typingTimer.unref();

    try {
      await item.ctx.reply(`Started Claude Code in ${cwd}`);
      await item.ctx.telegram.sendChatAction(chatId, 'typing');
      const result = await runner.promise;
      if (result.sessionId) {
        this.store.updateChat(chatId, { sessionId: result.sessionId });
      }
      this.store.addRun(chatId, {
        ok: true,
        cwd,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
      });
      await replyLong(item.ctx, result.text, this.config.messageChunkSize);
    } catch (error) {
      this.store.addRun(chatId, {
        ok: false,
        cwd,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        error: error.message,
      });
      const details = sanitizeOutput([error.message, error.stderr, error.stdout].filter(Boolean).join('\n\n'));
      await replyLong(item.ctx, `Claude run failed:\n${details}`, this.config.messageChunkSize);
    } finally {
      clearInterval(typingTimer);
      queue.active = null;
      void this.#drain(chatId);
    }
  }
}
