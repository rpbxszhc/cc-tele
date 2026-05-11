export function splitMessage(text, maxLength) {
  const normalized = String(text || '').trim() || '(empty response)';
  if (normalized.length <= maxLength) return [normalized];

  const chunks = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < Math.floor(maxLength * 0.5)) {
      cut = rest.lastIndexOf(' ', maxLength);
    }
    if (cut < Math.floor(maxLength * 0.5)) {
      cut = maxLength;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function replyLong(ctx, text, maxLength) {
  for (const chunk of splitMessage(text, maxLength)) {
    await ctx.reply(chunk);
  }
}

export function sanitizeOutput(text) {
  return String(text || '')
    .replace(/(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|DEEPSEEK_API_KEY)=\S+/gi, '$1=<redacted>')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
}
