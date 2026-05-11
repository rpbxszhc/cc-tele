import fs from 'node:fs';
import path from 'node:path';

const EMPTY_STATE = {
  chats: {},
};

export class StateStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.state = this.#load();
  }

  getChat(chatId) {
    const key = String(chatId);
    if (!this.state.chats[key]) {
      this.state.chats[key] = {
        cwd: this.defaults.defaultCwd,
        sessionId: null,
        recentRuns: [],
      };
      this.save();
    }
    return this.state.chats[key];
  }

  updateChat(chatId, patch) {
    const chat = this.getChat(chatId);
    Object.assign(chat, patch);
    this.save();
    return chat;
  }

  clearSession(chatId) {
    return this.updateChat(chatId, { sessionId: null });
  }

  addRun(chatId, run) {
    const chat = this.getChat(chatId);
    chat.recentRuns = [run, ...(chat.recentRuns || [])].slice(0, 10);
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...EMPTY_STATE,
        ...parsed,
        chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }
}
