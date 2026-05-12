import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./pty-helper.py', import.meta.url));

const KEY_BYTES = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
};

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.TELEGRAM_BOT_TOKEN;
  return env;
}

class TerminalScreen {
  constructor({ rows = 30, cols = 100, maxLines = 80 } = {}) {
    this.rows = rows;
    this.cols = cols;
    this.maxLines = maxLines;
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.state = 'text';
    this.escape = '';
    this.osc = '';
  }

  write(chunk) {
    for (const char of chunk) {
      this.#process(char);
    }
    this.#trimHistory();
  }

  toString() {
    return this.lines
      .slice(Math.max(0, this.lines.length - this.maxLines))
      .map((line) => line.replace(/[^\S\n]+$/g, ''))
      .join('\n')
      .replace(/\n+$/g, '');
  }

  resize({ rows, cols }) {
    this.rows = rows;
    this.cols = cols;
    if (this.col >= this.cols) this.col = this.cols - 1;
  }

  #process(char) {
    if (this.state === 'osc') {
      if (char === '\x07') {
        this.state = 'text';
        this.osc = '';
      } else {
        this.osc += char;
        if (this.osc.endsWith('\x1b\\')) {
          this.state = 'text';
          this.osc = '';
        }
      }
      return;
    }

    if (this.state === 'escape') {
      this.escape += char;
      if (this.escape === ']') {
        this.state = 'osc';
        this.osc = '';
        return;
      }
      if (this.escape === '7') {
        this.savedRow = this.row;
        this.savedCol = this.col;
        this.state = 'text';
        this.escape = '';
        return;
      }
      if (this.escape === '8') {
        this.row = this.savedRow;
        this.col = this.savedCol;
        this.state = 'text';
        this.escape = '';
        return;
      }
      if (this.escape === '[') return;
      if (this.escape.startsWith('[')) {
        if (this.escape.length > 1 && /[@-~]$/.test(this.escape)) {
          this.#handleCsi(this.escape.slice(1, -1), this.escape.at(-1));
          this.state = 'text';
          this.escape = '';
        }
        return;
      }
      if (this.escape.length >= 2 || /^[=>c]$/.test(this.escape)) {
        this.state = 'text';
        this.escape = '';
      }
      return;
    }

    if (char === '\x1b') {
      this.state = 'escape';
      this.escape = '';
      return;
    }
    if (char === '\r') {
      this.col = 0;
      return;
    }
    if (char === '\n') {
      this.row += 1;
      this.#ensureLine();
      return;
    }
    if (char === '\b' || char === '\x7f') {
      this.col = Math.max(0, this.col - 1);
      return;
    }
    if (char === '\t') {
      const spaces = 8 - (this.col % 8);
      for (let index = 0; index < spaces; index += 1) this.#putChar(' ');
      return;
    }
    if (char < ' ' && char !== '\u00a0') return;
    this.#putChar(char);
  }

  #putChar(char) {
    this.#ensureLine();
    const chars = Array.from(this.lines[this.row]);
    while (chars.length < this.col) chars.push(' ');
    chars[this.col] = char;
    this.lines[this.row] = chars.join('');
    this.col += 1;
    if (this.col >= this.cols) {
      this.col = 0;
      this.row += 1;
      this.#ensureLine();
    }
  }

  #ensureLine() {
    while (this.lines.length <= this.row) this.lines.push('');
  }

  #trimHistory() {
    const limit = Math.max(this.maxLines, this.rows) * 3;
    if (this.lines.length <= limit) return;
    const removeCount = this.lines.length - limit;
    this.lines.splice(0, removeCount);
    this.row = Math.max(0, this.row - removeCount);
    this.savedRow = Math.max(0, this.savedRow - removeCount);
  }

  #params(raw) {
    const clean = raw.replace(/[?=><]/g, '');
    return clean.split(';').map((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  }

  #handleCsi(raw, final) {
    const params = this.#params(raw);
    const first = params[0] || 1;
    if (final === 'A') this.row = Math.max(0, this.row - first);
    else if (final === 'B') this.row += first;
    else if (final === 'C') this.col = Math.min(this.cols - 1, this.col + first);
    else if (final === 'D') this.col = Math.max(0, this.col - first);
    else if (final === 'E') {
      this.row += first;
      this.col = 0;
    } else if (final === 'F') {
      this.row = Math.max(0, this.row - first);
      this.col = 0;
    } else if (final === 'G') {
      this.col = Math.max(0, first - 1);
    } else if (final === 'H' || final === 'f') {
      this.row = Math.max(0, (params[0] || 1) - 1);
      this.col = Math.max(0, (params[1] || 1) - 1);
    } else if (final === 'J') {
      this.#eraseDisplay(params[0] || 0);
    } else if (final === 'K') {
      this.#eraseLine(params[0] || 0);
    } else if (final === 'S') {
      this.lines.splice(0, first);
      this.row = Math.max(0, this.row - first);
    } else if (final === 'T') {
      for (let index = 0; index < first; index += 1) this.lines.unshift('');
      this.row += first;
    }
    this.#ensureLine();
  }

  #eraseDisplay(mode) {
    this.#ensureLine();
    if (mode === 2 || mode === 3) {
      this.lines = [''];
      this.row = 0;
      this.col = 0;
      return;
    }
    if (mode === 0) {
      this.lines[this.row] = Array.from(this.lines[this.row]).slice(0, this.col).join('');
      this.lines.splice(this.row + 1);
    } else if (mode === 1) {
      for (let index = 0; index < this.row; index += 1) this.lines[index] = '';
      this.lines[this.row] = Array.from(this.lines[this.row]).slice(this.col).join('');
    }
  }

  #eraseLine(mode) {
    this.#ensureLine();
    const chars = Array.from(this.lines[this.row]);
    if (mode === 2) {
      this.lines[this.row] = '';
    } else if (mode === 1) {
      this.lines[this.row] = chars.slice(this.col).join('');
      this.col = 0;
    } else {
      this.lines[this.row] = chars.slice(0, this.col).join('');
    }
  }
}

export function keySequence(key) {
  return KEY_BYTES[key] || null;
}

export function supportedKeys() {
  return Object.keys(KEY_BYTES);
}

export class PtySession extends EventEmitter {
  constructor({ kind, label, cwd, argv, env, config }) {
    super();
    this.kind = kind;
    this.label = label;
    this.cwd = cwd;
    this.config = config;
    this.startedAt = new Date();
    this.screen = '';
    this.exitInfo = null;
    this.messageId = null;
    this.renderTimer = null;
    this.idleTimer = null;
    this.hardTimer = null;
    this.lineBuffer = '';
    this.rows = config.ptyRows;
    this.cols = config.ptyCols;
    this.terminal = new TerminalScreen({
      rows: this.rows,
      cols: this.cols,
      maxLines: config.ptyScreenLines,
    });

    this.child = spawn('python3', [
      HELPER_PATH,
      '--cwd',
      cwd,
      '--rows',
      String(this.rows),
      '--cols',
      String(this.cols),
      '--',
      ...argv,
    ], {
      cwd: path.dirname(HELPER_PATH),
      env: childEnv({
        ...env,
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (data) => this.#handleControlOutput(data));
    this.child.stderr.on('data', (data) => this.#appendOutput(data));
    this.child.on('error', (error) => this.emit('error', error));
    this.child.on('close', (code, signal) => {
      if (!this.exitInfo) this.exitInfo = { code, signal };
      this.#clearTimers();
      this.emit('exit', this.exitInfo);
    });

    this.#armIdleTimer();
    if (config.ptyHardTimeoutMs > 0) {
      this.hardTimer = setTimeout(() => this.terminate(), config.ptyHardTimeoutMs);
      this.hardTimer.unref();
    }
  }

  get running() {
    return !this.exitInfo && this.child.exitCode === null;
  }

  write(value) {
    if (!this.running || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify({ type: 'write', data: value })}\n`);
    this.#armIdleTimer();
    return true;
  }

  key(key) {
    const sequence = keySequence(key);
    if (!sequence) return false;
    return this.write(sequence);
  }

  eof() {
    return this.key('ctrl-d');
  }

  resize({ rows = this.rows, cols = this.cols } = {}) {
    if (!this.running || this.child.stdin.destroyed) return false;
    this.rows = rows;
    this.cols = cols;
    this.terminal.resize({ rows, cols });
    this.child.stdin.write(`${JSON.stringify({ type: 'resize', rows, cols })}\n`);
    this.screen = this.terminal.toString();
    this.emit('output', this.screen);
    return true;
  }

  terminate() {
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify({ type: 'terminate' })}\n`);
    setTimeout(() => {
      if (this.running && !this.child.stdin.destroyed) {
        this.child.stdin.write(`${JSON.stringify({ type: 'kill' })}\n`);
      }
    }, 5000).unref();
  }

  #handleControlOutput(data) {
    this.lineBuffer += data;
    while (this.lineBuffer.includes('\n')) {
      const index = this.lineBuffer.indexOf('\n');
      const line = this.lineBuffer.slice(0, index);
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (!line.trim()) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#appendOutput(line);
        continue;
      }

      if (message.type === 'output') {
        const chunk = Buffer.from(message.data, 'base64').toString('utf8');
        this.#appendOutput(chunk);
      } else if (message.type === 'exit') {
        this.exitInfo = { code: message.code, signal: message.signal };
      } else if (message.type === 'error') {
        this.#appendOutput(`\n[pty-helper] ${message.message}\n`);
      }
    }
  }

  #appendOutput(chunk) {
    this.terminal.write(chunk);
    this.screen = this.terminal.toString();
    this.#armIdleTimer();
    this.emit('output', this.screen);
  }

  #armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.ptyIdleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => this.terminate(), this.config.ptyIdleTimeoutMs);
    this.idleTimer.unref();
  }

  #clearTimers() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }
}

export function createShellPty({ command, cwd, config }) {
  return new PtySession({
    kind: 'shell',
    label: command,
    cwd,
    argv: ['bash', '-lc', command],
    config,
  });
}

export function createClaudePty({ cwd, config }) {
  const script = 'source "$CLAUDE_ENV_FILE" && exec claude --permission-mode "$CLAUDE_PERMISSION_MODE"';
  return new PtySession({
    kind: 'claude',
    label: 'claude',
    cwd,
    argv: ['bash', '-lc', script],
    env: {
      CLAUDE_ENV_FILE: config.claudeEnvFile,
      CLAUDE_PERMISSION_MODE: config.claudePermissionMode,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    config,
  });
}
