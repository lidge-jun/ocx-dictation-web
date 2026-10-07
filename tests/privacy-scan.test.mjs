import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/privacy-scan.mjs', import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-privacy-'));
  const git = spawnSync('git', ['init', '-q'], { cwd: root });
  assert.equal(git.status, 0);
  return root;
}
function put(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function scan(root, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PRIVACY_DENYLIST;
  return spawnSync(process.execPath, [scanner], { cwd: root, env: { ...cleanEnv, ...env }, encoding: 'utf8' });
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

test('flags home path, key shape, audio file and hides values', () => {
  const root = fixture();
  try {
    const home = '/U' + 'sers/x/private.txt';
    const key = 's' + 'k-' + 'A'.repeat(20);
    put(root, 'notes.txt', `safe\n${home}\n${key}\n`);
    put(root, 'clip.wav', Buffer.from([82, 73, 70, 70]));
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /home-path notes\.txt:2/);
    assert.match(out.stderr, /key-shape notes\.txt:3/);
    assert.match(out.stderr, /audio-file clip\.wav:1/);
    assert.doesNotMatch(out.stderr + out.stdout, /private\.txt|A{20}/);
  } finally { cleanup(root); }
});

test('a sensitive staged version is flagged even after an unstaged cleanup', () => {
  const root = fixture();
  try {
    const key = 's' + 'k-' + 'C'.repeat(20);
    put(root, 'notes.txt', `safe\n${key}\n`);
    assert.equal(spawnSync('git', ['add', 'notes.txt'], { cwd: root }).status, 0);
    put(root, 'notes.txt', 'safe\n'); // working tree cleaned, index still holds the key
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /key-shape notes\.txt \(staged\):2/);
    assert.equal((out.stderr + out.stdout).includes('C'.repeat(20)), false);
  } finally { cleanup(root); }
});

test('flags macOS, Linux and Windows home paths without printing them', () => {
  const root = fixture();
  try {
    const paths = [
      '/U' + 'sers/x/private.txt',
      '/ho' + 'me/x/private.txt',
      'C:' + '\\' + 'Users' + '\\' + 'x' + '\\' + 'private.txt',
    ];
    put(root, 'paths.txt', paths.join('\n'));
    const out = scan(root);
    assert.equal(out.status, 1);
    for (const n of [1, 2, 3]) assert.match(out.stderr, new RegExp(`home-path paths\\.txt:${n}`));
    for (const value of paths) assert.equal((out.stderr + out.stdout).includes(value), false);
  } finally { cleanup(root); }
});

test('denylist is external, excludes private plans, prints rule and line only', () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-deny-'));
  try {
    const term = 'private' + ' marker';
    const file = path.join(outside, 'terms.txt');
    fs.writeFileSync(file, term + '\n');
    put(root, 'public.txt', `ok\n${term}\n`);
    put(root, 'devlog/_plan/plan.txt', term);
    put(root, 'devlog/_fin/finished.txt', term);
    const out = scan(root, { PRIVACY_DENYLIST: file });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /denylist public\.txt:2/);
    assert.doesNotMatch(out.stderr, /devlog|private marker/);
  } finally { cleanup(root); cleanup(outside); }
});

test('fails closed on an in-repo denylist or arbitrary binary', () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-deny-link-'));
  try {
    put(root, 'terms.txt', 'marker\n');
    assert.equal(scan(root, { PRIVACY_DENYLIST: path.join(root, 'terms.txt') }).status, 2);
    const link = path.join(outside, 'terms.txt');
    fs.symlinkSync(path.join(root, 'terms.txt'), link);
    assert.equal(scan(root, { PRIVACY_DENYLIST: link }).status, 2);
    put(root, 'blob.bin', Buffer.from([0, 1, 2]));
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /binary-(?:file|format) blob\.bin:1/);
  } finally { cleanup(root); cleanup(outside); }
});

test('flags tracked local config and data paths', () => {
  const root = fixture();
  try {
    put(root, 'config.' + 'local.json', '{}');
    put(root, 'data/sessions/example/meta.json', '{}');
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /local-data-path config\.local\.json:1/);
    assert.match(out.stderr, /local-data-path data\/sessions\/example\/meta\.json:1/);
  } finally { cleanup(root); }
});

test('allows a PNG under assets/ but flags binary elsewhere (C7 amendment)', () => {
  const root = fixture();
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    put(root, 'assets/screenshot.png', png);
    put(root, 'public/blob.bin', png);
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.doesNotMatch(out.stderr, /assets\/screenshot\.png/);
    assert.match(out.stderr, /binary-(?:file|format) public\/blob\.bin:1/);
  } finally { cleanup(root); }
});

test('allows a JPG directly under assets but scans SVG as text', () => {
  const root = fixture();
  try {
    put(root, 'assets/fictional.jpg', Buffer.from([255, 216, 255, 217]));
    const home = '/U' + 'sers/x/private.txt';
    put(root, 'assets/diagram.svg', `<svg><text>${home}</text></svg>`);
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.doesNotMatch(out.stderr, /fictional\.jpg/);
    assert.match(out.stderr, /home-path assets\/diagram\.svg:1/);
    assert.equal((out.stderr + out.stdout).includes(home), false);
  } finally { cleanup(root); }
});

test('A round 1: hyphenated provider keys and text-decodable binary formats are flagged', () => {
  const root = fixture();
  try {
    const key = 's' + 'k-' + 'proj-' + 'B'.repeat(24);
    put(root, 'config.example.json', `{"note":"${key}"}\n`);
    put(root, 'docs/manual.pdf', 'plain utf-8 bytes, no NUL'); // decodes as text but is not an approved format
    const out = scan(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /key-shape config\.example\.json:1/);
    assert.match(out.stderr, /binary-format docs\/manual\.pdf:1/);
    assert.equal((out.stderr + out.stdout).includes('B'.repeat(24)), false);
  } finally { cleanup(root); }
});
