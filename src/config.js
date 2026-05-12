import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

function expandPath(input) {
  if (!input) return input;
  const home = process.env.HOME || '';
  return input
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?=$|\/)/g, home);
}

function parseInteger(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return value;
}

function parseBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function splitList(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandGlob(pattern) {
  const expanded = expandPath(pattern);
  const parts = expanded.split(path.sep);
  const starIndex = parts.indexOf('*');
  if (starIndex === -1) return [expanded];

  const prefix = parts.slice(0, starIndex).join(path.sep);
  const prefixResolved = prefix ? path.resolve(prefix) : '/';
  let entries;
  try {
    entries = fs.readdirSync(prefixResolved);
  } catch {
    return [];
  }
  return entries.map((e) => path.join(prefixResolved, e));
}

function realDirectory(input, label) {
  const resolved = path.resolve(expandPath(input));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function realFile(input, label) {
  const resolved = path.resolve(expandPath(input));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

export function loadConfig({ requireToken = true } = {}) {
  const defaultCwd = realDirectory(
    process.env.DEFAULT_CWD || ROOT_DIR,
    'DEFAULT_CWD',
  );

  const allowedRaw = splitList(process.env.ALLOWED_WORKSPACES);
  const allowedWorkspaces = Array.from(
    new Set([
      defaultCwd,
      ...allowedRaw.flatMap((item) =>
        expandGlob(item).map((p) => realDirectory(p, 'ALLOWED_WORKSPACES')),
      ),
    ]),
  );

  if (!allowedWorkspaces.includes(defaultCwd)) {
    allowedWorkspaces.unshift(defaultCwd);
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (requireToken && !telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const claudeEnvFile = realFile(
    process.env.CLAUDE_ENV_FILE || '~/.claude.sh',
    'CLAUDE_ENV_FILE',
  );

  const stateFile = path.resolve(expandPath(process.env.STATE_FILE) || path.join(ROOT_DIR, 'data/state.json'));

  return {
    rootDir: ROOT_DIR,
    telegramToken,
    claudeEnvFile,
    defaultCwd,
    allowedWorkspaces,
    claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE || 'auto',
    claudeTimeoutMs: parseInteger('CLAUDE_TIMEOUT_MS', 30 * 60 * 1000, { min: 1000 }),
    enablePty: parseBoolean('ENABLE_PTY', true),
    enableShellCommands: parseBoolean('ENABLE_SHELL_COMMANDS', false),
    ptyOutputIntervalMs: parseInteger('PTY_OUTPUT_INTERVAL_MS', 1200, { min: 250 }),
    ptyScreenLines: parseInteger('PTY_SCREEN_LINES', 80, { min: 5, max: 500 }),
    ptyRows: parseInteger('PTY_ROWS', 30, { min: 10, max: 80 }),
    ptyCols: parseInteger('PTY_COLS', 54, { min: 20, max: 160 }),
    ptyIdleTimeoutMs: parseInteger('PTY_IDLE_TIMEOUT_MS', 30 * 60 * 1000, { min: 0 }),
    ptyHardTimeoutMs: parseInteger('PTY_HARD_TIMEOUT_MS', 0, { min: 0 }),
    messageChunkSize: parseInteger('MESSAGE_CHUNK_SIZE', 3500, { min: 1000, max: 4000 }),
    stateFile,
  };
}

export function formatConfigSummary(config) {
  return [
    `root: ${config.rootDir}`,
    `claude env: ${config.claudeEnvFile}`,
    `default cwd: ${config.defaultCwd}`,
    `allowed workspaces: ${config.allowedWorkspaces.join(', ')}`,
    `permission mode: ${config.claudePermissionMode}`,
    `timeout ms: ${config.claudeTimeoutMs}`,
    `pty: ${config.enablePty ? 'enabled' : 'disabled'}`,
    `pty output interval ms: ${config.ptyOutputIntervalMs}`,
    `pty screen lines: ${config.ptyScreenLines}`,
    `pty size: ${config.ptyCols}x${config.ptyRows}`,
    `pty idle timeout ms: ${config.ptyIdleTimeoutMs}`,
    `shell commands: ${config.enableShellCommands ? 'enabled' : 'disabled'}`,
    `state file: ${config.stateFile}`,
  ].join('\n');
}
