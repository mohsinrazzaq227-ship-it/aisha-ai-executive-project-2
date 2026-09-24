/**
 * Minimal local typings for the vendor modules used by the frame renderer and
 * media pipeline. We intentionally depend only on the subset we actually call.
 */
declare module "opentype.js" {
  export type Path = {
    toPathData(decimalPlaces?: number): string;
    commands: unknown[];
  };
  export type Glyph = {
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): Path;
    name?: string;
    unicode?: number;
    index: number;
  };
  export type Font = {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyphIndex(char: string): number;
    charToGlyph(char: string): Glyph;
    glyphs: {
      get(index: number): Glyph;
      length: number;
    };
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    getAdvanceWidth(text: string, fontSize: number): number;
  };
  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;
  export function loadSync(path: string, options?: Record<string, unknown>): Font;
  const opentype: { parse: typeof parse; loadSync: typeof loadSync };
  export default opentype;
}
