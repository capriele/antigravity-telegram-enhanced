// @ts-nocheck
const { spawn } = require('child_process');
function parseCommandLine(input) {
  const args = [];
  let cur = '', quote = null, escaped = false;
  for (const ch of String(input)) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { args.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (quote) throw new Error('Unclosed quote in command.');
  if (cur) args.push(cur);
  return args;
}
function isAllowedCommand(argv, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some(p => {
    let wanted;
    try { wanted = parseCommandLine(String(p)); } catch { return false; }
    return wanted.length && wanted.every((part, i) => argv[i] === part);
  });
}
function quoteForDisplay(s) { return /\s/.test(s) ? JSON.stringify(s) : s; }
function spawnCaptured(command, args, opts) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '', stderr = '', done = false, timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const append = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + text).slice(-opts.maxChars);
      else stderr = (stderr + text).slice(-opts.maxChars);
    };
    child.stdout.on('data', c => append('out', c));
    child.stderr.on('data', c => append('err', c));
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code, signal) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? (signal ? -1 : 0), signal, stdout, stderr, timedOut, ms: Date.now() - started }); } });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, opts.timeoutMs);
  });
}
module.exports = { parseCommandLine, isAllowedCommand, quoteForDisplay, spawnCaptured };
