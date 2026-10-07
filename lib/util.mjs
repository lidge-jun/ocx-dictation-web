import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
export const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
export const COURSE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
export function isCourseCode(value) {
  return typeof value === "string" && (value === "" || COURSE_RE.test(value));
}
export async function writeJsonAtomic(file, obj) {
  await writeTextAtomic(file, JSON.stringify(obj, null, 2));
}
export async function writeTextAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, value);
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
export function slugify(value) {
  return (
    String(value || "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}
