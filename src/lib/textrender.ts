import fs from "node:fs";
import opentype from "opentype.js";
import sharp from "sharp";

/**
 * Deterministic offline frame renderer.
 *   text  -> real font glyph outlines (opentype.js) -> SVG path data
 *   frame -> SVG (shapes, gradients, diagrams) -> PNG (sharp)
 * No image API, no cost, byte-reproducible for the same inputs.
 * Caption layout measures actual glyph advances, so text never overflows.
 */

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;

export type FontKind = "bold" | "regular" | "mono" | "serif";

const FONT_CANDIDATES: Record<FontKind, string[]> = {
  bold: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ],
  regular: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ],
  mono: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "C:/Windows/Fonts/consolab.ttf",
  ],
  serif: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "C:/Windows/Fonts/georgiab.ttf",
  ],
};

type GlyphLike = { advanceWidth: number; getPath(x: number, y: number, size: number): { toPathData(places?: number): string } };
type FontLike = {
  unitsPerEm: number;
  charToGlyphIndex(char: string): number;
  glyphs: { get(index: number): GlyphLike };
};
type LoadedFont = { font: FontLike; path: string };
const fontCache = new Map<FontKind, LoadedFont>();

export function loadFont(kind: FontKind = "bold"): LoadedFont {
  const cached = fontCache.get(kind);
  if (cached) return cached;
  for (const candidate of FONT_CANDIDATES[kind]) {
    if (!fs.existsSync(candidate)) continue;
    const buffer = fs.readFileSync(candidate);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const font = opentype.parse(arrayBuffer);
    const loaded = { font, path: candidate };
    fontCache.set(kind, loaded);
    return loaded;
  }
  throw new Error(
    `No usable font file found for "${kind}". Install DejaVu/Liberation fonts (Linux) or run on Windows where C:/Windows/Fonts is used. Frame rendering cannot continue honestly without real glyphs.`,
  );
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type TextRun = { d: string; width: number };

/** Build glyph outlines manually — avoids GSUB/ligature feature lookups entirely. */
export function textRun(text: string, x: number, baselineY: number, size: number, kind: FontKind = "bold"): TextRun {
  const { font } = loadFont(kind);
  let cursor = x;
  let d = "";
  for (const char of text) {
    const glyph = font.glyphs.get(font.charToGlyphIndex(char));
    if (!glyph) continue;
    const path = glyph.getPath(cursor, baselineY, size);
    const data = path.toPathData(2);
    if (data) d += data;
    cursor += (glyph.advanceWidth / font.unitsPerEm) * size;
  }
  return { d, width: cursor - x };
}

export function measureText(text: string, size: number, kind: FontKind = "bold"): number {
  return textRun(text, 0, 0, size, kind).width;
}

export type WrapResult = { lines: string[]; truncated: boolean };

/** Greedy wrap measured with real advances; never returns a line wider than maxWidth when a break exists. */
export function wrapText(text: string, maxWidth: number, size: number, kind: FontKind = "bold", maxLines = 6): WrapResult {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measureText(candidate, size, kind) <= maxWidth || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current);
  const truncated = lines.length >= maxLines && words.join(" ") !== lines.join(" ");
  return { lines, truncated };
}

export type Theme = {
  id: string;
  name: string;
  bg1: string;
  bg2: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
};

export const THEMES: Theme[] = [
  { id: "deep-space", name: "Deep Space", bg1: "#050b18", bg2: "#0d2036", accent: "#4cc9f0", accent2: "#8f7bff", text: "#f2f7ff", muted: "#9fb3c8" },
  { id: "ember", name: "Ember Signal", bg1: "#140705", bg2: "#33140c", accent: "#ff8a3d", accent2: "#ffd166", text: "#fff4ec", muted: "#d9b3a0" },
  { id: "bio-lab", name: "Bio Lab", bg1: "#04120f", bg2: "#0b2c26", accent: "#3ddc97", accent2: "#7ef0c4", text: "#eafff7", muted: "#9dc9ba" },
  { id: "graphite", name: "Graphite Blueprint", bg1: "#0a0d12", bg2: "#1b2430", accent: "#7bdff2", accent2: "#b8bfff", text: "#f5f7fa", muted: "#a4b0c2" },
  { id: "magenta", name: "Neon Magenta", bg1: "#12041a", bg2: "#2c0a3d", accent: "#ff5da2", accent2: "#c084fc", text: "#fdf2ff", muted: "#c9a6d8" },
];

export type VisualType =
  | "TITLE_CARD"
  | "STAT_CALLOUT"
  | "DIAGRAM_FLOW"
  | "TIMELINE"
  | "CHART_BARS"
  | "SOURCE_LIST"
  | "QUOTE_CARD"
  | "PARTICLE_FIELD"
  | "COMPARISON_TABLE"
  | "ICON_GRID"
  | "MECHANISM_STEPS"
  | "PARALLAX_CROP";

export type SceneSpec = {
  index: number;
  kicker: string;
  title: string;
  body: string;
  bullets: string[];
  visualType: VisualType;
  data: { label: string; value: string }[];
  sources: { title: string; url: string; engine?: string }[];
  accent: string;
  accent2: string;
  themeId: string;
  totalScenes: number;
};

function themeOf(scene: SceneSpec): Theme {
  return THEMES.find((t) => t.id === scene.themeId) ?? THEMES[0];
}

function textSvg(text: string, x: number, baseline: number, size: number, fill: string, kind: FontKind = "bold", opacity = 1): string {
  if (!text) return "";
  const run = textRun(text, x, baseline, size, kind);
  return `<path d="${run.d}" fill="${fill}" opacity="${opacity}"/>`;
}

function wrappedSvg(text: string, x: number, baseline: number, size: number, fill: string, maxWidth: number, kind: FontKind = "bold", lineHeight = 1.32, maxLines = 6, opacity = 1): string {
  const { lines } = wrapText(text, maxWidth, size, kind, maxLines);
  return lines
    .map((line, i) => textSvg(line, x, baseline + i * size * lineHeight, size, fill, kind, opacity))
    .join("");
}

function frameChrome(scene: SceneSpec, theme: Theme): string {
  const progress = scene.totalScenes <= 1 ? 1 : scene.index / (scene.totalScenes - 1 || 1);
  const dots = Array.from({ length: scene.totalScenes })
    .map((_, i) => {
      const cx = 540 - ((scene.totalScenes - 1) * 22) / 2 + i * 22;
      return `<circle cx="${cx.toFixed(1)}" cy="1836" r="${i === scene.index ? 7 : 4.5}" fill="${i === scene.index ? theme.accent : theme.muted}" opacity="${i === scene.index ? 1 : 0.45}"/>`;
    })
    .join("");
  return [
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="url(#bg)"/>`,
    `<g opacity="0.16">${Array.from({ length: 13 })
      .map((_, i) => `<line x1="${i * 90}" y1="0" x2="${i * 90}" y2="${FRAME_HEIGHT}" stroke="${theme.accent}" stroke-width="1"/>`)
      .join("")}${Array.from({ length: 21 })
      .map((_, i) => `<line x1="0" y1="${i * 96}" x2="${FRAME_WIDTH}" y2="${i * 96}" stroke="${theme.accent}" stroke-width="1"/>`)
      .join("")}</g>`,
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="8" fill="${theme.accent}" opacity="0.9"/>`,
    dots,
    `<rect x="0" y="0" width="${FRAME_WIDTH * progress}" height="8" fill="${theme.accent2}" opacity="0.95"/>`,
    textSvg("AI-EXECUTIVE · RENDERED LOCALLY", 64, 92, 24, theme.muted, "mono", 0.75),
    textSvg(scene.kicker.toUpperCase().slice(0, 42), 64, 190, 30, theme.accent, "mono", 0.95),
  ].join("");
}

function visualBody(scene: SceneSpec, theme: Theme): string {
  const left = 76;
  const right = FRAME_WIDTH - 76;
  const contentWidth = right - left;
  switch (scene.visualType) {
    case "TITLE_CARD": {
      return [
        `<circle cx="880" cy="560" r="240" fill="none" stroke="${theme.accent}" stroke-width="2" opacity="0.5"/>`,
        `<circle cx="880" cy="560" r="170" fill="none" stroke="${theme.accent2}" stroke-width="2" opacity="0.4"/>`,
        wrappedSvg(scene.title, left, 820, 84, theme.text, contentWidth - 80, "bold", 1.14, 4),
        `<rect x="${left}" y="980" width="180" height="6" fill="${theme.accent2}"/>`,
        wrappedSvg(scene.body, left, 1060, 34, theme.muted, contentWidth - 40, "regular", 1.4, 4),
      ].join("");
    }
    case "STAT_CALLOUT": {
      const stats = scene.data.slice(0, 3);
      return [
        wrappedSvg(scene.title, left, 420, 62, theme.text, contentWidth, "bold", 1.16, 3),
        ...stats.map((stat, i) => {
          const top = 620 + i * 300;
          return [
            `<rect x="${left}" y="${top - 150}" width="${contentWidth}" height="230" rx="26" fill="${theme.bg2}" opacity="0.72" stroke="${theme.accent}" stroke-width="2"/>`,
            textSvg(stat.value.slice(0, 14), left + 44, top, 108, theme.accent, "bold"),
            wrappedSvg(stat.label, left + 44, top + 56, 32, theme.text, contentWidth - 88, "regular", 1.3, 2),
          ].join("");
        }),
        wrappedSvg(scene.body, left, 1560, 32, theme.muted, contentWidth, "regular", 1.4, 3),
      ].join("");
    }
    case "DIAGRAM_FLOW": {
      const steps = (scene.bullets.length > 0 ? scene.bullets : ["Input", "Process", "Output"]).slice(0, 4);
      return [
        wrappedSvg(scene.title, left, 400, 62, theme.text, contentWidth, "bold", 1.16, 3),
        ...steps.map((step, i) => {
          const cy = 600 + i * 250;
          return [
            `<rect x="${left}" y="${cy - 80}" width="${contentWidth - 120}" height="160" rx="22" fill="${theme.bg2}" opacity="0.7" stroke="${theme.accent2}" stroke-width="2"/>`,
            `<circle cx="${left + 56}" cy="${cy}" r="30" fill="${theme.accent}"/>`,
            textSvg(String(i + 1), left + 48, cy + 11, 34, theme.bg1, "bold"),
            wrappedSvg(step, left + 116, cy + 12, 33, theme.text, contentWidth - 280, "regular", 1.3, 2),
            i < steps.length - 1 ? `<path d="M ${left + (contentWidth - 120) / 2} ${cy + 84} l 0 78" stroke="${theme.accent}" stroke-width="4" marker-end="url(#arrow)"/>` : "",
          ].join("");
        }),
      ].join("");
    }
    case "TIMELINE": {
      const points = (scene.data.length > 0 ? scene.data : scene.bullets.map((b, i) => ({ label: `Phase ${i + 1}`, value: b }))).slice(0, 5);
      return [
        wrappedSvg(scene.title, left, 400, 62, theme.text, contentWidth, "bold", 1.16, 3),
        `<line x1="${left + 40}" y1="640" x2="${left + 40}" y2="1500" stroke="${theme.accent}" stroke-width="5" opacity="0.85"/>`,
        ...points.map((point, i) => {
          const cy = 680 + i * 190;
          return [
            `<circle cx="${left + 40}" cy="${cy}" r="16" fill="${theme.accent2}"/>`,
            textSvg(point.label.slice(0, 22).toUpperCase(), left + 86, cy - 8, 30, theme.accent, "mono"),
            wrappedSvg(point.value, left + 86, cy + 42, 33, theme.text, contentWidth - 130, "regular", 1.28, 2),
          ].join("");
        }),
      ].join("");
    }
    case "CHART_BARS": {
      const bars = scene.data.slice(0, 6);
      const values = bars.map((b) => Number.parseFloat(b.value.replace(/[^0-9.]/g, "")) || 0);
      const max = Math.max(1, ...values);
      const chartLeft = left + 30;
      const chartBottom = 1440;
      const barWidth = Math.min(120, (contentWidth - 60) / Math.max(1, bars.length) - 26);
      return [
        wrappedSvg(scene.title, left, 400, 62, theme.text, contentWidth, "bold", 1.16, 3),
        `<line x1="${chartLeft}" y1="${chartBottom}" x2="${right - 20}" y2="${chartBottom}" stroke="${theme.muted}" stroke-width="2"/>`,
        ...bars.map((bar, i) => {
          const height = Math.max(30, (values[i] / max) * 780);
          const x = chartLeft + 24 + i * (barWidth + 34);
          return [
            `<rect x="${x}" y="${chartBottom - height}" width="${barWidth}" height="${height}" rx="12" fill="${i % 2 === 0 ? theme.accent : theme.accent2}" opacity="0.92"/>`,
            wrappedSvg(bar.label, x, chartBottom + 44, 28, theme.text, barWidth + 34, "regular", 1.24, 3),
            textSvg(bar.value, x, chartBottom - height - 18, 32, theme.text, "mono"),
          ].join("");
        }),
      ].join("");
    }
    case "SOURCE_LIST": {
      const sources = scene.sources.slice(0, 6);
      return [
        wrappedSvg(scene.title, left, 400, 58, theme.text, contentWidth, "bold", 1.16, 3),
        ...sources.map((source, i) => {
          const top = 520 + i * 190;
          const host = (() => {
            try {
              return new URL(source.url).host;
            } catch {
              return source.url;
            }
          })();
          return [
            `<rect x="${left}" y="${top}" width="${contentWidth}" height="160" rx="20" fill="${theme.bg2}" opacity="0.66"/>`,
            textSvg(`${String(i + 1).padStart(2, "0")}`, left + 30, top + 66, 44, theme.accent, "mono"),
            wrappedSvg(source.title, left + 120, top + 60, 32, theme.text, contentWidth - 170, "regular", 1.26, 2),
            textSvg(host, left + 120, top + 132, 26, theme.accent2, "mono", 0.9),
          ].join("");
        }),
        `<rect x="0" y="0" width="0" height="0"/>`,
      ].join("");
    }
    case "QUOTE_CARD": {
      return [
        textSvg("“", left, 560, 220, theme.accent, "serif", 0.9),
        wrappedSvg(scene.body || scene.title, left + 40, 700, 56, theme.text, contentWidth - 80, "serif", 1.3, 7),
        textSvg(scene.title.slice(0, 70), left + 40, 1500, 32, theme.accent2, "bold", 0.95),
      ].join("");
    }
    case "PARTICLE_FIELD": {
      const seedRand = (seed: number) => {
        let value = seed;
        return () => {
          value = (value * 1103515245 + 12345) % 2147483648;
          return value / 2147483648;
        };
      };
      const rand = seedRand(scene.index * 977 + 13);
      const dots = Array.from({ length: 130 })
        .map(() => {
          const cx = (rand() * FRAME_WIDTH).toFixed(1);
          const cy = (rand() * 1300 + 240).toFixed(1);
          const r = (rand() * 6 + 1.5).toFixed(2);
          const opacity = (rand() * 0.6 + 0.25).toFixed(2);
          return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${rand() > 0.5 ? theme.accent : theme.accent2}" opacity="${opacity}"/>`;
        })
        .join("");
      return [
        dots,
        wrappedSvg(scene.title, left, 1480, 66, theme.text, contentWidth, "bold", 1.16, 3),
        wrappedSvg(scene.body, left, 1640, 32, theme.muted, contentWidth, "regular", 1.36, 3),
      ].join("");
    }
    case "COMPARISON_TABLE": {
      const rows = (scene.data.length > 0 ? scene.data : scene.bullets.map((b) => ({ label: b, value: "—" }))).slice(0, 5);
      return [
        wrappedSvg(scene.title, left, 400, 58, theme.text, contentWidth, "bold", 1.16, 3),
        `<rect x="${left}" y="470" width="${contentWidth}" height="70" rx="14" fill="${theme.accent}" opacity="0.9"/>`,
        textSvg("OPTION", left + 28, 516, 30, theme.bg1, "mono"),
        textSvg("KEY POINT", left + contentWidth * 0.45, 516, 30, theme.bg1, "mono"),
        ...rows.map((row, i) => {
          const top = 556 + i * 190;
          return [
            `<rect x="${left}" y="${top}" width="${contentWidth}" height="176" rx="16" fill="${theme.bg2}" opacity="${i % 2 === 0 ? 0.72 : 0.5}"/>`,
            wrappedSvg(row.label, left + 28, top + 62, 33, theme.text, contentWidth * 0.4, "bold", 1.24, 3),
            wrappedSvg(row.value, left + contentWidth * 0.45, top + 62, 30, theme.muted, contentWidth * 0.5, "regular", 1.28, 3),
          ].join("");
        }),
      ].join("");
    }
    case "ICON_GRID": {
      const items = (scene.bullets.length > 0 ? scene.bullets : ["Capability"]).slice(0, 6);
      return [
        wrappedSvg(scene.title, left, 400, 58, theme.text, contentWidth, "bold", 1.16, 3),
        ...items.map((item, i) => {
          const col = i % 2;
          const row = Math.floor(i / 2);
          const x = left + col * (contentWidth / 2 + 12);
          const y = 500 + row * 330;
          return [
            `<rect x="${x}" y="${y}" width="${contentWidth / 2 - 12}" height="290" rx="24" fill="${theme.bg2}" opacity="0.7" stroke="${theme.accent}" stroke-width="2"/>`,
            `<circle cx="${x + 52}" cy="${y + 62}" r="26" fill="${theme.accent2}"/>`,
            wrappedSvg(item, x + 28, y + 150, 31, theme.text, contentWidth / 2 - 70, "regular", 1.28, 4),
          ].join("");
        }),
      ].join("");
    }
    case "MECHANISM_STEPS": {
      const steps = (scene.bullets.length > 0 ? scene.bullets : ["Step"]).slice(0, 5);
      return [
        wrappedSvg(scene.title, left, 400, 60, theme.text, contentWidth, "bold", 1.16, 3),
        `<circle cx="540" cy="1080" r="300" fill="none" stroke="${theme.accent}" stroke-width="3" opacity="0.4"/>`,
        ...steps.map((step, i) => {
          const angle = (-Math.PI / 2) + (i / steps.length) * Math.PI * 2;
          const cx = 540 + Math.cos(angle) * 300;
          const cy = 1080 + Math.sin(angle) * 300;
          return [
            `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="64" fill="${theme.bg2}" stroke="${theme.accent2}" stroke-width="3"/>`,
            textSvg(String(i + 1), cx - 12, cy + 14, 44, theme.accent, "bold"),
            wrappedSvg(step, cx - 96, cy + 130, 27, theme.text, 200, "regular", 1.24, 3),
          ].join("");
        }),
      ].join("");
    }
    case "PARALLAX_CROP":
    default: {
      return [
        wrappedSvg(scene.title, left, 560, 68, theme.text, contentWidth, "bold", 1.16, 3),
        `<rect x="${left}" y="640" width="200" height="6" fill="${theme.accent}"/>`,
        wrappedSvg(scene.body, left, 720, 34, theme.muted, contentWidth - 40, "regular", 1.38, 5),
        ...scene.bullets.slice(0, 4).map((bullet, i) => {
          const cy = 1120 + i * 120;
          return [
            `<circle cx="${left + 12}" cy="${cy - 10}" r="12" fill="${theme.accent2}"/>`,
            wrappedSvg(bullet, left + 48, cy, 32, theme.text, contentWidth - 90, "regular", 1.26, 2),
          ].join("");
        }),
      ].join("");
    }
  }
}

export function sceneSvg(scene: SceneSpec): string {
  const theme = themeOf(scene);
  const safeBody = visualBody(scene, theme);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${theme.bg1}"/>
    <stop offset="1" stop-color="${theme.bg2}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.7">
    <stop offset="0" stop-color="${scene.accent}" stop-opacity="0.32"/>
    <stop offset="1" stop-color="${scene.accent}" stop-opacity="0"/>
  </radialGradient>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="5" refY="3" orient="auto">
    <path d="M0,0 L0,6 L7,3 z" fill="${theme.accent}"/>
  </marker>
</defs>
<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="url(#bg)"/>
<ellipse cx="540" cy="900" rx="620" ry="720" fill="url(#glow)"/>
${frameChrome(scene, theme)}
${safeBody}
<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="none" stroke="${theme.muted}" stroke-width="2" opacity="0.25"/>
</svg>`;
}

export async function renderScenePng(scene: SceneSpec): Promise<Buffer> {
  return sharp(Buffer.from(sceneSvg(scene))).png({ compressionLevel: 9 }).toBuffer();
}

/** Caption band composited above the moving background so captions never zoom or drift. */
export type CaptionStyle = {
  fontSize: number;
  maxLines: number;
  bottomSafe: number;
  sideSafe: number;
  bandOpacity: number;
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 54,
  maxLines: 2,
  bottomSafe: 250,
  sideSafe: 84,
  bandOpacity: 0.55,
};

export type CaptionRender = {
  buffer: Buffer;
  lines: string[];
  overflowed: boolean;
  measuredWidth: number;
  fontSize: number;
};

export async function renderCaptionPng(text: string, theme: Theme, style: CaptionStyle = DEFAULT_CAPTION_STYLE): Promise<CaptionRender> {
  const maxWidth = FRAME_WIDTH - style.sideSafe * 2;
  let fontSize = style.fontSize;
  let wrap = wrapText(text, maxWidth, fontSize, "bold", style.maxLines);
  let overflowed = wrap.truncated;
  while (wrap.lines.length > style.maxLines && fontSize > 30) {
    fontSize -= 2;
    wrap = wrapText(text, maxWidth, fontSize, "bold", style.maxLines);
    overflowed = wrap.truncated;
  }
  const lineHeight = fontSize * 1.26;
  const blockHeight = wrap.lines.length * lineHeight;
  const bandHeight = blockHeight + 56;
  const bandTop = FRAME_HEIGHT - style.bottomSafe - bandHeight;
  const measuredWidth = Math.max(...wrap.lines.map((line) => measureText(line, fontSize, "bold")), 1);
  if (measuredWidth > maxWidth) overflowed = true;

  const pieces: string[] = [
    `<rect x="${style.sideSafe - 24}" y="${bandTop}" width="${FRAME_WIDTH - (style.sideSafe - 24) * 2}" height="${bandHeight}" rx="24" fill="#04070d" opacity="${style.bandOpacity}"/>`,
  ];
  wrap.lines.forEach((line, i) => {
    const lineWidth = measureText(line, fontSize, "bold");
    const x = (FRAME_WIDTH - lineWidth) / 2;
    const baseline = bandTop + 40 + i * lineHeight + fontSize * 0.78;
    // outline via offset copies, then the crisp fill
    for (const [dx, dy] of [
      [-3, 0],
      [3, 0],
      [0, -3],
      [0, 3],
      [-2, -2],
      [2, 2],
    ]) {
      pieces.push(textSvg(line, x + dx, baseline + dy, fontSize, "#000000", "bold", 0.85));
    }
    pieces.push(textSvg(line, x, baseline, fontSize, "#ffffff", "bold", 1));
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}">${pieces.join("")}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, lines: wrap.lines, overflowed, measuredWidth, fontSize };
}

export async function composeFrameWithCaption(sceneBuffer: Buffer, caption: Buffer | null): Promise<Buffer> {
  const base = sharp(sceneBuffer);
  if (!caption) return base.png().toBuffer();
  return base.composite([{ input: caption, top: 0, left: 0 }]).png().toBuffer();
}
