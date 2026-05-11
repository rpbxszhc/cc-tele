import { spawn } from 'node:child_process';

function appendBounded(current, chunk, maxLength) {
  const next = current + chunk;
  if (next.length <= maxLength) return next;
  return next.slice(next.length - maxLength);
}

export function runShell({ command, cwd, config }) {
  const childEnv = { ...process.env };
  delete childEnv.TELEGRAM_BOT_TOKEN;

  const child = spawn('bash', ['-lc', command], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && child.exitCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    }, config.shellTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout = appendBounded(stdout, data, config.shellMaxOutputChars);
    });
    child.stderr.on('data', (data) => {
      stderr = appendBounded(stderr, data, config.shellMaxOutputChars);
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });

  return {
    child,
    promise,
    writeInput(input) {
      if (child.exitCode !== null || child.stdin.destroyed) return false;
      child.stdin.write(input);
      return true;
    },
    endInput() {
      if (child.exitCode !== null || child.stdin.destroyed) return false;
      child.stdin.end();
      return true;
    },
    cancel() {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}
