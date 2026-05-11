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

function stripAnsi(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\x1b./g, '');
}

function normalizeTerminalText(value) {
  return stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+$/gm, '');
}

function appendScreen(current, chunk, maxLines) {
  const next = normalizeTerminalText(current + chunk);
  const lines = next.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.TELEGRAM_BOT_TOKEN;
  return env;
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

    this.child = spawn('python3', [
      HELPER_PATH,
      '--cwd',
      cwd,
      '--rows',
      '30',
      '--cols',
      '100',
      '--',
      ...argv,
    ], {
      cwd: path.dirname(HELPER_PATH),
      env: childEnv(env),
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
    this.screen = appendScreen(this.screen, chunk, this.config.ptyScreenLines);
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
    },
    config,
  });
}
