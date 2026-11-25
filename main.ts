// News-image entry for make.fun's "Sum up 24 November's world news in one
// image" bounty (news-image-20261124). Node 22, standard library only.
//
// The front page is drawn from scratch by this program: a bitmap font
// (font.ts), flat geometric shapes, and a hand-rolled PNG writer. Nothing
// is downloaded and nothing is read from disk except this code, so both
// grader runs produce byte-identical output with no network access.
//
// Layout: a masthead naming the day, three lead stories in large type,
// then a dense brief grid of 28 more stories in four columns, so the page
// sums up 31 stories from the day across wars, diplomacy, markets, tech,
// science and Asia. Every headline below was checked against news reported
// on 24 November 2026.
//
// Run locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { FONT, GLYPH_H, SPACE_W } from './font.ts';

// ---------------------------------------------------------------- palette
const PAPER: RGB = [247, 242, 231];
const INK: RGB = [24, 34, 52];
const RED: RGB = [192, 57, 43];
const NAVY: RGB = [34, 64, 107];
const GOLD: RGB = [217, 164, 65];
const GREY: RGB = [107, 114, 128];
const SKY: RGB = [157, 184, 210];
const LIGHT: RGB = [233, 228, 216];

type RGB = [number, number, number];

// ------------------------------------------------------------ PNG writer
// CRC-32 (IEEE) table, built once at startup.
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

// Encode raw RGB pixels (row-major, no alpha) as a PNG.
function encodePNG(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- canvas
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;

  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    this.fill(bg);
  }

  fill(c: RGB): void {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
    }
  }

  set(x: number, y: number, c: RGB): void {
    // Floor: callers often pass half-pixel centres, and a typed array
    // silently drops writes at fractional indices.
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }

  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
    }
  }

  // Filled circle by horizontal spans.
  circle(cx: number, cy: number, r: number, c: RGB): void {
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let dx = -half; dx <= half; dx++) this.set(cx + dx, cy + dy, c);
    }
  }

  // Straight line (Bresenham) with a square brush of `thick` pixels.
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, thick = 1): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.rect(x - Math.floor(thick / 2), y - Math.floor(thick / 2), thick, thick, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  // Filled polygon (convex or concave) by scanline.
  poly(points: Array<[number, number]>, c: RGB): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          xs.push(Math.round(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = xs[k]; x <= xs[k + 1]; x++) this.set(x, y, c);
      }
    }
  }

  // Five-pointed star centred at (cx, cy).
  star(cx: number, cy: number, rOuter: number, rInner: number, c: RGB): void {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? rOuter : rInner;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
    }
    this.poly(pts, c);
  }

  // -------------------------------------------------------------- text
  textWidth(text: string, scale: number): number {
    let w = 0;
    for (const ch of text) {
      if (ch === ' ') w += SPACE_W * scale;
      else {
        const g = FONT[ch];
        if (g) w += (g.w + 1) * scale;
      }
    }
    return w - scale; // no trailing gap after the last glyph
  }

  // Draw one line of text, top edge at y, in colour c.
  text(x: number, y: number, text: string, scale: number, c: RGB): void {
    let cx = x;
    for (const ch of text) {
      if (ch === ' ') {
        cx += SPACE_W * scale;
        continue;
      }
      const g = FONT[ch];
      if (!g) {
        cx += 6 * scale;
        continue;
      }
      for (let row = 0; row < GLYPH_H; row++) {
        const bits = g.rows[row];
        for (let col = 0; col < g.w; col++) {
          if (bits & (1 << (g.w - 1 - col))) {
            this.rect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += (g.w + 1) * scale;
    }
  }

  textCentred(cx: number, y: number, text: string, scale: number, c: RGB): void {
    this.text(cx - Math.floor(this.textWidth(text, scale) / 2), y, text, scale, c);
  }

  // Greedy word wrap. Returns the lines, each at most maxW wide.
  wrap(text: string, scale: number, maxW: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const trial = cur ? `${cur} ${word}` : word;
      if (this.textWidth(trial, scale) <= maxW || !cur) cur = trial;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
}

// ------------------------------------------------------------- panels
interface Lead {
  lines: string[]; // headline, already split, scale 2
  sub: string;
}

function drawLead(cv: Canvas, x: number, y: number, w: number, h: number, p: Lead): void {
  cv.rect(x, y, w, 2, INK);
  cv.rect(x, y, 2, h, INK);
  cv.rect(x + w - 2, y, 2, h, INK);
  cv.rect(x, y + h - 2, w, 2, INK);
  cv.rect(x + 12, y + 12, 72, 5, RED);
  let ty = y + 26;
  for (const line of p.lines) {
    cv.text(x + 12, ty, line, 2, INK);
    ty += 38;
  }
  const subLines = cv.wrap(p.sub, 1, w - 24).slice(0, 2);
  let sy = ty + 2;
  for (const line of subLines) {
    cv.text(x + 12, sy, line, 1, NAVY);
    sy += 20;
  }
}

interface Brief {
  kicker: string;
  headline: string;
}

function drawBrief(cv: Canvas, x: number, y: number, w: number, h: number, b: Brief, tint: boolean): void {
  if (tint) cv.rect(x, y, w, h, LIGHT);
  cv.rect(x, y, w, 1, INK);
  cv.rect(x, y + h - 1, w, 1, INK);
  cv.rect(x, y, 1, h, INK);
  cv.rect(x + w - 1, y, 1, h, INK);
  cv.text(x + 8, y + 7, b.kicker, 1, RED);
  const lines = cv.wrap(b.headline, 1, w - 16).slice(0, 2);
  let ty = y + 27;
  for (const line of lines) {
    cv.text(x + 8, ty, line, 1, INK);
    ty += 20;
  }
}

// ------------------------------------------------------------- stories
// All 31 headlines were checked against news reported on 24 November 2026:
// Just Security Early Edition, SCMP, WION, CNA, The Daily Edition, BBC via
// The Global Eye, RFE/RL, Financial Express, BBN Times, Asgard News.

const LEADS: Lead[] = [
  {
    lines: ['HORMUZ MINES', 'HIT 3 TANKERS'],
    sub: 'IRGC: TANKERS CAUGHT FIRE IN HORMUZ',
  },
  {
    lines: ['NVIDIA SLIDES', 'RALLY FADES'],
    sub: 'NASDAQ -1.5% TO 23,734; ANTHROPIC BELOW IPO',
  },
  {
    lines: ['GIULIANI', 'GETS MEDAL'],
    sub: 'TRUMP AWARDS MEDAL OF FREEDOM',
  },
];

// Four columns of seven briefs each, read down each column.
const COLUMNS: Brief[][] = [
  [
    { kicker: 'GAZA', headline: 'GAZA: HAMAS SECURITY CHIEF KILLED' },
    { kicker: 'UKRAINE', headline: 'ZAPORIZHZHIA: 2 DEAD, 40 WOUNDED' },
    { kicker: 'IRAN', headline: 'IRAN VOWS TO FIGHT US BLOCKADE' },
    { kicker: 'DIPLOMACY', headline: 'VANCE, RUBIO MEET QATAR PM' },
    { kicker: 'RUSSIA', headline: 'PUTIN WARNS OF RETALIATION' },
    { kicker: 'TALKS', headline: 'NEW UKRAINE PEACE TALKS SOON' },
    { kicker: 'YEMEN', headline: 'HOUTHI STRIKE HITS RIYADH TOWER' },
  ],
  [
    { kicker: 'NATO', headline: 'NATO VOWS SPACE DEFENCE' },
    { kicker: 'KOREA', headline: 'RUSSIAN JETS ENTER KOREA ZONE' },
    { kicker: 'GERMANY', headline: 'GERMANY GETS UKRAINE DELTA SYSTEM' },
    { kicker: 'EU', headline: '7 STATES BACK RUSSIAN VISA CURB' },
    { kicker: 'LIBYA', headline: 'UN SEEKS PROBE INTO LIBYA ATTACKS' },
    { kicker: 'AFRICA', headline: 'UKRAINE HITS RUSSIAN NETS IN AFRICA' },
    { kicker: 'WAR DEAD', headline: '700,000 RUSSIAN SOLDIERS DEAD' },
  ],
  [
    { kicker: 'BANGLADESH', headline: 'HASINA PLANS DEC 16 RETURN' },
    { kicker: 'NEPAL', headline: 'NEPAL QUAKE: MAGNITUDE 5.3' },
    { kicker: 'INDIA', headline: 'INDIA GIVES NEPAL $1.62BN AID' },
    { kicker: 'INDONESIA', headline: 'INDONESIA FIRE TOLL RISES TO 26' },
    { kicker: 'VIETNAM', headline: 'HANOI BLAST KILLS 6' },
    { kicker: 'BANGLADESH', headline: 'BANGLADESH WORKERS CLASH WITH POLICE' },
    { kicker: 'SOUTH KOREA', headline: 'SOUTH KOREA SECURITY RESHUFFLE' },
  ],
  [
    { kicker: 'TRADE', headline: 'US PLANS HIGHER TARIFFS ON 17' },
    { kicker: 'MARKETS', headline: 'NIKKEI +3.9% TO 58,645' },
    { kicker: 'NVIDIA', headline: 'HUANG: I AM IN THERAPY' },
    { kicker: 'SCIENCE', headline: 'RIEMANN PROOF: LEAN CERTIFIES IT' },
    { kicker: 'AI', headline: 'KOREA PAYS $375,000 TO CATCH AI CHEATS' },
    { kicker: 'USA', headline: 'TRUMP ORDERS DEATH PENALTY PUSH' },
    { kicker: 'CLIMATE', headline: 'COP31 FALLOUT: RETHINK CLIMATE TALKS' },
  ],
];

// ------------------------------------------------------------- layout
function buildPage(): Buffer {
  const W = 1024;
  const H = 1024;
  const cv = new Canvas(W, H, PAPER);
  // Outer frame.
  cv.rect(10, 10, W - 20, 4, INK);
  cv.rect(10, H - 14, W - 20, 4, INK);
  cv.rect(10, 10, 4, H - 20, INK);
  cv.rect(W - 14, 10, 4, H - 20, INK);

  // Masthead: the day, large and legible.
  cv.textCentred(W / 2, 28, '24 NOVEMBER 2026', 4, INK);
  cv.textCentred(W / 2, 28 + 4 * GLYPH_H + 6, 'THE WORLD IN ONE DAY', 2, INK);
  const ruleY = 28 + 4 * GLYPH_H + 6 + 2 * GLYPH_H + 10;
  cv.rect(32, ruleY, W - 64, 3, INK);
  cv.rect(32, ruleY + 7, W - 64, 2, RED);

  // Three lead stories in large type.
  const leadY = ruleY + 18;
  const leadH = 148;
  const leadW = 309;
  const leadGap = 16;
  for (let i = 0; i < 3; i++) {
    drawLead(cv, 32 + i * (leadW + leadGap), leadY, leadW, leadH, LEADS[i]);
  }

  // Dense brief grid: 28 more stories, four columns of seven.
  const labelY = leadY + leadH + 10;
  cv.text(32, labelY, 'THE DAY IN BRIEF - 28 MORE STORIES', 1, RED);
  const gridY = labelY + 24;
  const cellW = 232;
  const cellH = 78;
  const cellGap = 6;
  const colGap = 10;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 7; r++) {
      const x = 32 + c * (cellW + colGap);
      const y = gridY + r * (cellH + cellGap);
      drawBrief(cv, x, y, cellW, cellH, COLUMNS[c][r], r % 2 === 1);
    }
  }

  // Footer.
  cv.textCentred(W / 2, gridY + 7 * cellH + 6 * cellGap + 10, 'GLOBAL NEWS - 24 NOVEMBER 2026', 2, INK);
  return encodePNG(W, H, cv.px);
}

// -------------------------------------------------------------- entry
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), buildPage());
