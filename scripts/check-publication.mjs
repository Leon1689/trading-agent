import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked files; stage the release before checking it.');
const failures = [];
const privateFile = /(^|\/)(?:AGENTS\.md|auth\.json|credentials\.json|config\.local\.json|\.env(?:\..+)?|\.DS_Store)$|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|jsonl|log)$/i;
const privateDirectory = /^(?:node_modules|data|backups|sessions|\.pi-trader|docs\/verification)\//;
const patterns = [
  ['private home path', /(?:\/Users\/|\/home\/)[a-zA-Z0-9._-]+\//],
  ['private knowledge link', /\[\[(?:RAW|wiki)\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider credential', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{40,}\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
];

for (const file of files) {
  if (privateDirectory.test(file) || (privateFile.test(file) && file !== '.env.example')) failures.push(`${file}: private runtime file`);
  const full = resolve(root, file);
  if (lstatSync(full).isSymbolicLink()) { failures.push(`${file}: release files must not be symlinks`); continue; }
  const bytes = readFileSync(full);
  if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');
  for (const [label, pattern] of patterns) {
    const match = pattern.exec(source);
    if (match) failures.push(`${file}:${source.slice(0, match.index).split('\n').length}: ${label}`);
  }
  if (!file.endsWith('.md')) continue;
  const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
    const target = resolve(dirname(full), decodeURIComponent(href.split(/[?#]/)[0]));
    if (!target.startsWith(root + sep) || !existsSync(target)) failures.push(`${file}: missing or external local link ${href}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication checks passed for ${files.length} tracked files.`);
}
