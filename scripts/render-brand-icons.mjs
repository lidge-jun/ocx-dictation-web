#!/usr/bin/env node
// Renders the brand icon PNGs from the same geometry as assets/logo.svg and assets/icon.svg.
// Zero dependencies: supersampled coverage of rounded rects and circles, encoded as RGBA PNG.
// Usage: node scripts/render-brand-icons.mjs [outDir=assets]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const INK = [255, 254, 251], PAGE = [29, 95, 83], REC = [217, 68, 58];
const LOGO = { size: 128, shapes: [
  { rect: [8, 8, 112, 112, 26], color: PAGE },
  { circle: [41, 65, 17], color: INK },
  { rect: [64, 51, 44, 7, 3.5], color: INK },
  { rect: [64, 61.5, 35, 7, 3.5], color: INK },
  { rect: [64, 72, 25, 7, 3.5], color: INK },
  { circle: [98, 30, 7], color: REC },
] };
const FAVICON = { size: 32, shapes: [
  { rect: [0, 0, 32, 32, 8], color: PAGE },
  { circle: [10.5, 17, 5], color: INK },
  { rect: [17.5, 12.5, 10, 3.2, 1.6], color: INK },
  { rect: [17.5, 18.3, 7, 3.2, 1.6], color: INK },
  { circle: [25.5, 6.8, 2.6], color: REC },
] };
// Full-bleed square (iOS and Android crop it themselves); content kept inside the maskable safe zone.
const fullBleed = (scale) => ({ size: 128, shapes: [
  { rect: [0, 0, 128, 128, 0], color: PAGE },
  ...LOGO.shapes.slice(1).map((s) => scaled(s, scale)),
] });
function scaled(shape, k) {
  const c = 64, f = (v) => c + (v - c) * k;
  if (shape.circle) return { ...shape, circle: [f(shape.circle[0]), f(shape.circle[1]), shape.circle[2] * k] };
  const [x, y, w, h, r] = shape.rect;
  return { ...shape, rect: [f(x), f(y), w * k, h * k, r * k] };
}
function inside(shape, x, y) {
  if (shape.circle) { const [cx, cy, r] = shape.circle; return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; }
  const [rx, ry, w, h, r] = shape.rect;
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const qx = Math.max(rx + r - x, 0, x - (rx + w - r)), qy = Math.max(ry + r - y, 0, y - (ry + h - r));
  return qx * qx + qy * qy <= r * r;
}
function render({ size, shapes }, px) {
  const out = Buffer.alloc(px * px * 4), ss = 4, unit = size / px;
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (i + (sx + 0.5) / ss) * unit, y = (j + (sy + 0.5) / ss) * unit;
          let hit = null;
          for (const s of shapes) if (inside(s, x, y)) hit = s.color;
          if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a += 1; }
        }
      }
      const o = (j * px + i) * 4;
      if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = (255 * a) / (ss * ss); }
    }
  }
  return out;
}
function png(rgba, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let j = 0; j < px; j++) rows.push(Buffer.from([0]), rgba.subarray(j * px * 4, (j + 1) * px * 4));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const outDir = process.argv[2] || "assets";
fs.mkdirSync(outDir, { recursive: true });
const jobs = [
  ["icon-32.png", FAVICON, 32],
  ["icon-192.png", LOGO, 192],
  ["icon-512.png", LOGO, 512],
  ["apple-touch-icon.png", fullBleed(1), 180],
  ["icon-maskable-512.png", fullBleed(0.72), 512],
];
for (const [name, spec, px] of jobs) {
  fs.writeFileSync(path.join(outDir, name), png(render(spec, px), px));
  console.log(`wrote ${path.join(outDir, name)} ${px}x${px}`);
}

