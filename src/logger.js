// Logger de una línea por evento: "<timestamp UTC> <NIVEL> <mensaje>".
// Todo lo que se escribe pasa por redact() para que nunca salgan secretos.

export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const secrets = new Set();
let threshold = LEVELS.info;

export function setLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

// Registra un valor (p.e. un client secret) que debe ocultarse en cualquier línea de log.
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
}

export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('***');
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 ***')
    .replace(/("(?:access_token|refresh_token|id_token|clientsecret|client_secret)"\s*:\s*")[^"]*"/gi, '$1***"');
}

export function truncate(text, max = 500) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}…[truncado]` : str;
}

function write(level, message) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  error: (msg) => write('error', msg),
  warn: (msg) => write('warn', msg),
  info: (msg) => write('info', msg),
  debug: (msg) => write('debug', msg),
};
