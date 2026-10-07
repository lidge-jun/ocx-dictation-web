import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
const files = [
  ...new Set(
    raw
      .toString("utf8")
      .split("\0")
      .filter((f) => /\.(?:mjs|js)$/.test(f) && fs.existsSync(path.join(root, f))),
  ),
].sort();
let failed = 0;
for (const file of files) {
  if (file === "server.mjs" || /^(?:bin|lib|scripts|tests|public\/js)\//.test(file)) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.length > 120 && !line.trimEnd().endsWith("// long-line-ok")) {
        failed++;
        process.stderr.write(`${file}:${index + 1}: ${line.length} columns (max 120)\n`);
      }
    }
  }
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`${file}\n${result.stderr || result.error?.message || "syntax check failed"}`);
  }
}
console.log(`Checked ${files.length} JavaScript files; failures: ${failed}`);
if (!files.length || failed) process.exitCode = 1;
