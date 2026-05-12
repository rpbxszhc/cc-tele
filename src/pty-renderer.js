import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RENDERER_PATH = fileURLToPath(new URL('./render-terminal.py', import.meta.url));

export function renderTerminalImage(text, config) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [RENDERER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errors = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errors.join('').trim() || `renderer exited ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.end(JSON.stringify({
      text,
      theme: config.ptyImageTheme,
      fontSize: config.ptyImageFontSize,
    }));
  });
}
