#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const skipped = (name) => name.startsWith('devlog/_plan/') || name.startsWith('devlog/_fin/');
const audio = new Set(['.wav', '.ogg', '.opus', '.mp3', '.m4a', '.aac', '.flac', '.webm', '.mp4', '.mov']);
const archives = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z']);
// C7 amendment: reviewed screenshots are allowed only as images directly under assets/.
const allowedImage = (name) => /^assets\/[^/]+\.(png|jpg)$/i.test(name); // SVG is text: scanned normally below
// A round 1: allowlist of text formats. Any other extension (e.g. .pdf, .docx, .sqlite) is an unapproved binary format
// regardless of whether its bytes happen to decode as UTF-8. Extensionless files (LICENSE, dotfiles) are text.
const textExt = new Set(['', '.mjs', '.js', '.cjs', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.txt', '.svg']);
const homePattern = new RegExp(
  '(?:/U' + 'sers/[^/\\s]+/|/ho' + 'me/[^/\\s]+/|' +
  '[A-Za-z]:\\\\U' + 'sers\\\\[^\\\\\\s]+\\\\)', 'i',
);
const keyPattern = new RegExp(
  // A round 1: provider keys may contain '-' and '_' (e.g. sk-proj-…, ocx_data_…).
  '(?:oc' + 'x_[A-Za-z0-9_-]{8,}|s' + 'k-[A-Za-z0-9_-]{16,}|' +
  'gh[opusr]' + '_[A-Za-z0-9]{12,}|github' + '_pat_[A-Za-z0-9_]{12,}|' +
  'AK' + 'IA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)',
);
const hits = [];

function hit(rule, file, line = 1) { hits.push(`${rule} ${file}:${line}`); }
function publicCandidates() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort().filter((name) => !skipped(name));
}
// C review: the index can hold a different (e.g. sensitive) version than the working tree. Return staged blob ids so
// the staged bytes are scanned too whenever they differ from the file on disk.
function stagedBlobs() {
  const output = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root }).toString('utf8');
  const blobs = new Map();
  for (const entry of output.split('\0').filter(Boolean)) {
    const match = /^\d+ ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    if (match && !skipped(match[2])) blobs.set(match[2], match[1]);
  }
  return blobs;
}
function denyTerms() {
  const given = process.env.PRIVACY_DENYLIST;
  if (!given) return [];
  if (!path.isAbsolute(given)) throw new Error('denylist must be absolute');
  const file = fs.realpathSync(given);
  const rel = path.relative(fs.realpathSync(root), file);
  if (!rel.startsWith('..' + path.sep) && rel !== '..') throw new Error('denylist must be outside the repository');
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}
function scanFile(file, terms, blobs) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) { hit('unsafe-path', file); return; }
  const full = path.join(root, file);
  let stat;
  try { stat = fs.lstatSync(full); } catch { hit('unreadable', file); return; }
  if (stat.isSymbolicLink()) { hit('symlink', file); return; }
  if (!stat.isFile()) return;
  const bytes = fs.readFileSync(full);
  scanBytes(file, bytes, terms);
  const blob = blobs.get(file);
  if (blob) {
    const staged = execFileSync('git', ['cat-file', 'blob', blob], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (!staged.equals(bytes)) scanBytes(`${file} (staged)`, staged, terms, file);
  }
}
function scanBytes(label, bytes, terms, file = label) {
  if (file === 'config.' + 'local.json' || file.startsWith('data/')) hit('local-data-path', label);
  if (audio.has(path.extname(file).toLowerCase())) hit('audio-file', label);
  if (archives.has(path.extname(file).toLowerCase())) hit('archive-file', label);
  if (allowedImage(file)) return;
  if (!textExt.has(path.extname(file).toLowerCase())) { hit('binary-format', label); return; }
  let content;
  try { content = textDecoder.decode(bytes); } catch { hit('binary-file', label); return; }
  if (content.includes('\0')) { hit('binary-file', label); return; }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (homePattern.test(line)) hit('home-path', label, i + 1);
    if (keyPattern.test(line)) hit('key-shape', label, i + 1);
    if (terms.some((term) => line.includes(term))) hit('denylist', label, i + 1);
  }
}

try {
  const terms = denyTerms();
  const blobs = stagedBlobs();
  for (const file of publicCandidates()) scanFile(file, terms, blobs);
  for (const line of hits) console.error(line);
  if (hits.length) process.exitCode = 1;
} catch {
  console.error('privacy-scan-error <repository>:1');
  process.exitCode = 2;
}
