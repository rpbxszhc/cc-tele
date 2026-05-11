import { spawn } from 'node:child_process';

function tail(text, maxLength = 4000) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

export function runClaude({ prompt, cwd, sessionId, config }) {
  const claudeArgs = [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    config.claudePermissionMode,
  ];

  if (sessionId) {
    claudeArgs.push('--resume', sessionId);
  }
  claudeArgs.push(prompt);

  const childEnv = { ...process.env };
  delete childEnv.TELEGRAM_BOT_TOKEN;

  const script = 'source "$CLAUDE_ENV_FILE" && exec claude "$@"';
  const child = spawn('bash', ['-lc', script, 'claude-telegram-bridge', ...claudeArgs], {
    cwd,
    env: {
      ...childEnv,
      CLAUDE_ENV_FILE: config.claudeEnvFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && child.exitCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    }, config.claudeTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const error = new Error(`claude exited with ${signal || code}`);
        error.code = code;
        error.signal = signal;
        error.stderr = tail(stderr);
        error.stdout = tail(stdout);
        reject(error);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          raw: parsed,
          text: parsed.result || '',
          sessionId: parsed.session_id || null,
          durationMs: parsed.duration_ms || null,
          totalCostUsd: parsed.total_cost_usd ?? null,
        });
      } catch (error) {
        error.stderr = tail(stderr);
        error.stdout = tail(stdout);
        reject(error);
      }
    });
  });

  return {
    child,
    promise,
    cancel() {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}
