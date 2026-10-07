import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, publicConfig } from "../lib/config.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-cfg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, configFile: path.join(root, "config.json") };
}
test("defaults < file < env and public projection is safe", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.configFile,
    JSON.stringify({ port: 14000, ocxKey: "dummy-secret", defaultNoteModel: "file-model", courses: ["BIO101"] }),
  );
  const cfg = loadConfig({ paths: f, env: { PORT: "14001", OCX_DICTATION_TZ: "UTC" } });
  assert.equal(cfg.port, 14001);
  assert.equal(cfg.noteModel, "file-model");
  assert.equal(cfg.timezone, "UTC");
  assert.equal(cfg.transcribeModel, "gpt-4o-transcribe");
  const pub = publicConfig(cfg);
  assert.deepEqual(Object.keys(pub), [
    "version",
    "transcribeModel",
    "noteModel",
    "refineModel",
    "timezone",
    "courses",
    "vaultEnabled",
  ]);
  assert.equal(pub.vaultEnabled, false);
  assert.equal(JSON.stringify(pub).includes("dummy-secret"), false);
  assert.equal(JSON.stringify(pub).includes(f.root), false);
});
test("invalid host, timezone and course reject", (t) => {
  const f = fixture(t);
  for (const [value, message] of [
    [{ host: "0.0.0.0" }, /loopback/],
    [{ timezone: "Bad\/Zone" }, /timezone/],
    [{ courses: ["../bad"] }, /courses/],
  ]) {
    fs.writeFileSync(f.configFile, JSON.stringify(value));
    assert.throws(() => loadConfig({ paths: f, env: {} }), message);
  }
});
test("ignored keys warn once without values", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.configFile,
    JSON.stringify({ wikiRoot: "private-value", [["se", "mester"].join("")]: "private-value",
      extra: "private-value" }),
  );
  const old = console.warn,
    warnings = [];
  console.warn = (s) => warnings.push(s);
  try {
    loadConfig({ paths: f, env: {} });
  } finally {
    console.warn = old;
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("wikiRoot") && warnings[0].includes("extra"));
  assert.ok(warnings[0].includes(["se", "mester"].join("")));
  assert.equal(warnings[0].includes("private-value"), false);
});
test("vault config normalizes and public projection keeps paths private", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.configFile, JSON.stringify({ vault: { root: "/tmp/example-vault", includeRaw: true,
    unknown: "private-value" } }));
  const old = console.warn, warnings = [];
  console.warn = (value) => warnings.push(value);
  let cfg;
  try { cfg = loadConfig({ paths: f, env: {} }); }
  finally { console.warn = old; }
  assert.deepEqual(cfg.vault, { root: "/tmp/example-vault", notePath: "{course}/{date}-{slug}.md",
    rawPath: "_raw/{course}/{date}-transcript.txt", includeRaw: true });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes("private-value"), false);
  assert.equal(publicConfig(cfg).vaultEnabled, true);
  assert.equal(JSON.stringify(publicConfig(cfg)).includes("example-vault"), false);
  for (const vault of [[], "x", {}, { root: "" }, { root: "x", notePath: null },
    { root: "x", rawPath: 3 }, { root: "x", includeRaw: "yes" }]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ vault }));
    assert.throws(() => loadConfig({ paths: f, env: {} }), /Invalid vault/);
  }
});
test("missing config uses defaults; malformed config fails", (t) => {
  const f = fixture(t);
  assert.equal(loadConfig({ paths: f, env: {} }).noteModel, "gpt-6-luna");
  fs.writeFileSync(f.configFile, "{");
  assert.throws(() => loadConfig({ paths: f, env: {} }), /Invalid config file \(not valid JSON\)/);
});
test("malformed config never prints its content", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.configFile, '{"ocxKey":"SENTINEL-123",');
  assert.throws(
    () => loadConfig({ paths: f, env: {} }),
    (e) => {
      assert.ok(e.message.includes(f.configFile));
      assert.equal(e.message.includes("SENTINEL-123"), false);
      return true;
    },
  );
});
test("ocxBase with URL credentials is rejected without echoing them", (t) => {
  const f = fixture(t);
  const warnings = [],
    old = console.warn;
  console.warn = (s) => warnings.push(String(s));
  try {
    assert.throws(
      () => loadConfig({ paths: f, env: { OCX_BASE: "http://u:pw@127.0.0.1:1" } }),
      (e) => {
        assert.match(e.message, /must not contain credentials/);
        assert.equal(/u:pw/.test(e.message), false);
        return true;
      },
    );
  } finally {
    console.warn = old;
  }
  assert.equal(
    warnings.some((w) => w.includes("u:pw")),
    false,
  );
});
test("ocxBase with a query string or fragment is rejected without echoing it", (t) => {
  const f = fixture(t);
  for (const base of ["http://127.0.0.1:1/?token=SECRETQ", "http://127.0.0.1:1/#SECRETF"]) {
    assert.throws(
      () => loadConfig({ paths: f, env: { OCX_BASE: base } }),
      (e) => {
        assert.match(e.message, /query string or fragment/);
        assert.equal(/SECRET/.test(e.message), false);
        return true;
      },
    );
  }
});
