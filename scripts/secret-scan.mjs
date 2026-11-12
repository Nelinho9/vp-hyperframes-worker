// H4 gate recorrente: scan de secrets nos ficheiros TRACKED do repo público
// do worker (antes do push). Padrões de keys/tokens reais; ignora placeholders
// de teste óbvios (test-*, fixture, example).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const patterns = [
  /sk-[A-Za-z0-9_-]{24,}/g,                       // OpenAI/OpenRouter-style
  /AKIA[0-9A-Z]{16}/g,                            // AWS access key
  /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9]{30,}/g,                        // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,               // Slack
];
const testish = /(test|fixture|example|dummy|fake|mock|placeholder|redacted|your[-_]|xxx|<|changeme)/i;
const hits = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|mp3|wav|mp4|woff2?|ttf|ico|lock)$/i.test(f)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      const ctx = text.split('\n')[line - 1] ?? '';
      if (testish.test(m[0]) || testish.test(ctx)) continue;
      hits.push(`${f}:${line}: ${m[0].slice(0, 12)}… (${ctx.trim().slice(0, 100)})`);
    }
  }
}
if (hits.length) {
  console.error('SECRET_SCAN_HITS:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`SECRET_SCAN_CLEAN (${files.length} tracked files)`);