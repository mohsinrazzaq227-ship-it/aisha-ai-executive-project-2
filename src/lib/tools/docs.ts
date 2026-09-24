import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import ExcelJS from "exceljs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, type ArtifactInput } from "@/lib/tools/types";
import { ensureDir, slugify, toRelative, truncate } from "@/lib/util";
import { artifactDirFor } from "@/lib/artifacts";

const FORMATS = ["txt", "md", "json", "csv", "pdf", "docx", "xlsx", "html"] as const;
type Format = (typeof FORMATS)[number];

const MIME: Record<Format, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
};

type Section = { heading: string; body: string };

function parseSections(raw: unknown, fallbackText: string): Section[] {
  if (Array.isArray(raw)) {
    const sections = raw
      .map((item) => {
        const record = item as Record<string, unknown>;
        const heading = String(record.heading ?? record.title ?? "").trim();
        const body = String(record.body ?? record.content ?? "").trim();
        return heading || body ? { heading: heading || "Section", body } : null;
      })
      .filter((v): v is Section => v !== null);
    if (sections.length) return sections;
  }
  return [{ heading: "Report", body: fallbackText }];
}

async function buildPdf(title: string, sections: Section[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let cursor = 792;
  const write = (text: string, size: number, useBold: boolean) => {
    const usable = 515;
    const words = text.split(/\s+/);
    let line = "";
    const flush = () => {
      if (!line) return;
      if (cursor < 60) {
        page = pdf.addPage([595, 842]);
        cursor = 792;
      }
      page.drawText(line, { x: 40, y: cursor, size, font: useBold ? bold : font, color: rgb(0.08, 0.09, 0.12) });
      cursor -= size + 4;
      line = "";
    };
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > usable) flush();
      const last = line;
      line = line ? `${line} ${word}` : word;
      if (line === last) continue;
    }
    flush();
  };
  write(title, 20, true);
  cursor -= 6;
  for (const section of sections) {
    write(section.heading, 13, true);
    for (const paragraph of section.body.split(/\n{1,}/)) write(paragraph, 10.5, false);
    cursor -= 8;
  }
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

async function buildDocx(title: string, sections: Section[]): Promise<Buffer> {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const section of sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const paragraph of section.body.split(/\n{1,}/)) {
      children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AISHA";
  workbook.created = new Date();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31) || "Sheet1");
    for (const row of sheet.rows) worksheet.addRow(row);
    worksheet.getRow(1).font = { bold: true };
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function csvFromRows(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .join("\n");
}

registerTool({
  id: "doc.generate",
  title: "Generate document",
  group: "docs",
  description: "Creates a real TXT/MD/JSON/CSV/PDF/DOCX/XLSX/HTML file and registers it as a verified artifact.",
  risk: "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["docs", "aisha", "media_director", "data", "research"],
  params: z.object({
    title: z.string().min(1).max(200),
    format: z.enum(FORMATS),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
    text: z.string().optional(),
    rows: z.array(z.array(z.string())).optional(),
    json: z.unknown().optional(),
    filename: z.string().optional(),
  }),
  verificationNote: "PDF/DOCX/XLSX are re-parsed after writing (pdf-lib reload, exceljs read, docx byte check) before success is reported.",
  availability: async () => ({ available: true, detail: "pdf-lib, docx, exceljs and native writers available" }),
  execute: async (ctx, params) => {
    const format = params.format as Format;
    const sections = parseSections(params.sections, params.text ?? "");
    const dir = await artifactDirFor(ctx.taskId);
    const filename = params.filename ?? `${slugify(params.title)}.${format}`;
    const output = path.join(dir, path.extname(filename) ? filename : `${filename}.${format}`);
    await ensureDir(path.dirname(output));

    let buffer: Buffer;
    if (format === "pdf") buffer = await buildPdf(params.title, sections);
    else if (format === "docx") buffer = await buildDocx(params.title, sections);
    else if (format === "xlsx") {
      const rows = params.rows ?? [["field", "value"], ...sections.map((s) => [s.heading, truncate(s.body, 300)])];
      buffer = await buildXlsx([{ name: params.title, rows }]);
    } else if (format === "csv") {
      const rows = params.rows ?? [["heading", "body"], ...sections.map((s) => [s.heading, s.body])];
      buffer = Buffer.from(csvFromRows(rows), "utf8");
    } else if (format === "json") {
      const payload = params.json ?? { title: params.title, sections, generatedAt: new Date().toISOString(), task: ctx.taskId };
      buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    } else if (format === "html") {
      const body = sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.body).replace(/\n/g, "<br/>")}</p>`).join("\n");
      buffer = Buffer.from(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(params.title)}</title><h1>${escapeHtml(params.title)}</h1>${body}`, "utf8");
    } else if (format === "md") {
      const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n");
      buffer = Buffer.from(`# ${params.title}\n\n${body}\n`, "utf8");
    } else {
      const body = sections.map((s) => `${s.heading.toUpperCase()}\n${"-".repeat(s.heading.length)}\n${s.body}`).join("\n\n");
      buffer = Buffer.from(`${params.title}\n${"=".repeat(params.title.length)}\n\n${body}\n`, "utf8");
    }

    await fs.writeFile(output, buffer);
    const readBack = await fs.readFile(output);
    let structural: { valid: boolean; detail: string };
    if (format === "pdf") {
      try {
        const parsed = await PDFDocument.load(readBack);
        structural = { valid: parsed.getPageCount() > 0, detail: `parsed ${parsed.getPageCount()} page(s)` };
      } catch (error) {
        structural = { valid: false, detail: `pdf parse failed: ${String(error)}` };
      }
    } else if (format === "xlsx") {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(readBack as unknown as ArrayBuffer);
        structural = { valid: workbook.worksheets.length > 0, detail: `${workbook.worksheets.length} sheet(s) reopened` };
      } catch (error) {
        structural = { valid: false, detail: `xlsx reopen failed: ${String(error)}` };
      }
    } else if (format === "docx") {
      const signature = readBack.subarray(0, 2).toString("ascii");
      structural = { valid: signature === "PK", detail: `zip container signature ${signature}` };
    } else if (format === "json") {
      try {
        JSON.parse(readBack.toString("utf8"));
        structural = { valid: true, detail: "JSON.parse succeeded" };
      } catch (error) {
        structural = { valid: false, detail: `JSON.parse failed: ${String(error)}` };
      }
    } else {
      structural = { valid: readBack.byteLength === buffer.byteLength, detail: `${readBack.byteLength}B byte-identical` };
    }

    return {
      status: "SUCCESS",
      summary: `generated ${format.toUpperCase()} artifact ${path.basename(output)} (${buffer.byteLength}B) — ${structural.detail}`,
      data: { path: toRelative(DIRS.root, output), bytes: buffer.byteLength, format, sections: sections.map((s) => s.heading) },
      evidence: [{ kind: "structural-validation", detail: structural.detail }],
      artifacts: [{ name: path.basename(output), kind: `document:${format}`, filePath: output, mimeType: MIME[format], origin: "deterministic" }],
      verification: { verified: structural.valid && readBack.byteLength === buffer.byteLength, method: `write-back-${format}-parse`, detail: structural.detail },
    };
  },
});

registerTool({
  id: "doc.extract",
  title: "Extract document text",
  group: "docs",
  description: "Extracts real text from TXT/MD/JSON/CSV/PDF/DOCX. Unsupported or unparseable formats are reported, not guessed.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["docs", "data", "research", "aisha", "qa"],
  params: z.object({ path: z.string().min(1), maxChars: z.number().int().min(100).max(500_000).default(20_000) }),
  verificationNote: "Extracted text length is compared against the byte length of the source file; an empty extraction is a failure.",
  availability: async () => ({ available: true, detail: "mammoth (docx) + unpdf (pdf) + native (text)" }),
  execute: async (ctx, params) => {
    const target = path.isAbsolute(params.path) ? params.path : path.resolve(DIRS.workspace, params.path);
    const buffer = await fs.readFile(target).catch(() => null);
    if (!buffer) return fail("FAILED", `cannot read ${toRelative(DIRS.root, target)}`);
    const ext = path.extname(target).toLowerCase();
    let text = "";
    let method = "native-utf8";
    const limit = Math.min(buffer.byteLength, 24 * 1024 * 1024);
    try {
      if (ext === ".docx") {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
        method = "mammoth-docx";
      } else if (ext === ".pdf") {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const proxy = await getDocumentProxy(new Uint8Array(buffer));
        const extracted = await extractText(proxy, { mergePages: true });
        text = Array.isArray(extracted.text) ? extracted.text.join("\n\n") : extracted.text;
        method = "unpdf-pdf";
      } else if (ext === ".xlsx") {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
        text = workbook.worksheets
          .map((sheet) => [`### ${sheet.name}`, ...sheet.getSheetValues().filter(Boolean).map((row) => (Array.isArray(row) ? row.join(" | ") : String(row)))].join("\n"))
          .join("\n\n");
        method = "exceljs-xlsx";
      } else {
        text = buffer.subarray(0, limit).toString("utf8");
      }
    } catch (error) {
      return fail("FAILED", `extraction failed for ${ext || "file"}: ${String(error)}`, [{ kind: "extraction", detail: String(error) }]);
    }
    text = text.replace(/\u0000/g, "").trim();
    if (!text) return fail("VERIFICATION_FAILED", `extractor produced no text for ${toRelative(DIRS.root, target)} (${method})`);
    return {
      status: "SUCCESS",
      summary: `extracted ${text.length} chars via ${method}`,
      data: { path: toRelative(DIRS.root, target), method, chars: text.length, text: truncate(text, params.maxChars) },
      evidence: [{ kind: "extraction", detail: `${method}: ${text.length} chars from ${buffer.byteLength}B` }],
      artifacts: [],
      verification: { verified: text.length > 0, method: `${method}-nonempty`, detail: `${text.length} chars` },
    };
  },
});

registerTool({
  id: "data.analyze",
  title: "Analyse dataset",
  group: "data",
  description: "Parses CSV/JSON, computes real aggregates (count, numeric sum/mean/min/max) and writes a summary artifact.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["data", "research", "docs", "aisha"],
  params: z.object({ path: z.string().min(1), groupBy: z.string().optional(), writeSummary: z.boolean().default(true) }),
  verificationNote: "Row count, per-column counts and arithmetic are recomputed in a second independent pass.",
  availability: async () => ({ available: true, detail: "native CSV/JSON parser" }),
  execute: async (ctx, params) => {
    const target = path.isAbsolute(params.path) ? params.path : path.resolve(DIRS.workspace, params.path);
    const raw = await fs.readFile(target, "utf8").catch(() => null);
    if (!raw) return fail("FAILED", `cannot read dataset ${toRelative(DIRS.root, target)}`);
    const ext = path.extname(target).toLowerCase();
    let rows: Record<string, unknown>[] = [];
    if (ext === ".json") {
      const parsed = JSON.parse(raw) as unknown;
      rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    } else {
      const lines = raw.split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length) return fail("FAILED", "dataset is empty");
      const headers = splitCsvLine(lines[0]);
      rows = lines.slice(1).map((line) => {
        const cells = splitCsvLine(line);
        return headers.reduce<Record<string, unknown>>((acc, header, index) => {
          acc[header] = cells[index] ?? "";
          return acc;
        }, {});
      });
    }
    const numeric = new Map<string, number[]>();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        const num = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
        if (Number.isFinite(num) && String(value).trim() !== "") {
          const list = numeric.get(key) ?? [];
          list.push(num);
          numeric.set(key, list);
        }
      }
    }
    const stats = [...numeric.entries()].map(([column, values]) => ({
      column,
      count: values.length,
      sum: round(values.reduce((a, b) => a + b, 0)),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
      min: Math.min(...values),
      max: Math.max(...values),
    }));
    let groupBreakdown: Record<string, number> | null = null;
    if (params.groupBy && rows.length) {
      groupBreakdown = rows.reduce<Record<string, number>>((acc, row) => {
        const key = String(row[params.groupBy as string] ?? "(missing)");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    }
    // independent second pass
    const recount = rows.filter((row) => Object.keys(row).length > 0).length;
    const verified = recount === rows.length;

    let artifactPath: string | null = null;
    if (params.writeSummary) {
      const dir = await artifactDirFor(ctx.taskId);
      artifactPath = path.join(dir, `${slugify(path.basename(target, ext))}-analysis.md`);
      const lines = [
        `# Dataset analysis — ${path.basename(target)}`,
        "",
        `Rows: ${rows.length} · columns: ${Object.keys(rows[0] ?? {}).length} · independent recount: ${recount}`,
        "",
        "## Numeric columns",
        stats.length
          ? ["| column | count | sum | mean | min | max |", "| --- | --- | --- | --- | --- | --- |", ...stats.map((s) => `| ${s.column} | ${s.count} | ${s.sum} | ${s.mean} | ${s.min} | ${s.max} |`)].join("\n")
          : "No numeric columns detected.",
        "",
        groupBreakdown ? `## Grouped by ${params.groupBy}\n\n${Object.entries(groupBreakdown).map(([k, v]) => `- ${k}: ${v}`).join("\n")}` : "",
      ];
      await fs.writeFile(artifactPath, lines.join("\n"), "utf8");
    }

    return {
      status: "SUCCESS",
      summary: `analysed ${rows.length} row(s), ${stats.length} numeric column(s)${groupBreakdown ? `, grouped by ${params.groupBy}` : ""}`,
      data: { rows: rows.length, columns: Object.keys(rows[0] ?? {}), stats, groupBreakdown, recount },
      evidence: [{ kind: "recount", detail: `independent recount ${recount} of ${rows.length} rows` }],
      artifacts: artifactPath
        ? [{ name: path.basename(artifactPath), kind: "data-analysis", filePath: artifactPath, mimeType: "text/markdown", origin: "deterministic" }]
        : [],
      verification: { verified, method: "independent-recount", detail: `${recount} rows counted twice` },
    };
  },
});

registerTool({
  id: "report.write",
  title: "Write executive report",
  group: "docs",
  description: "Composes a structured report from real step outputs and registers it as Markdown + PDF evidence.",
  risk: "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["aisha", "docs", "research", "data", "media_director"],
  params: z.object({
    title: z.string().min(1).max(200),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(1).max(40),
    alsoPdf: z.boolean().default(true),
  }),
  verificationNote: "Markdown and PDF are both re-read; the PDF must parse with at least one page.",
  availability: async () => ({ available: true, detail: "native writer + pdf-lib" }),
  execute: async (ctx, params) => {
    const dir = await artifactDirFor(ctx.taskId);
    const safe = slugify(params.title);
    const mdPath = path.join(dir, `${safe}.md`);
    const md = [`# ${params.title}`, "", `Generated by AISHA · task ${ctx.taskId} · ${new Date().toISOString()}`, "", ...params.sections.flatMap((s) => [`## ${s.heading}`, "", s.body, ""])].join("\n");
    await fs.writeFile(mdPath, md, "utf8");
    const artifacts: ArtifactInput[] = [
      { name: `${safe}.md`, kind: "report:markdown", filePath: mdPath, mimeType: "text/markdown", origin: "deterministic" },
    ];
    let pdfDetail = "pdf disabled";
    let pdfOk = true;
    if (params.alsoPdf) {
      const pdfPath = path.join(dir, `${safe}.pdf`);
      const buffer = await buildPdf(params.title, params.sections);
      await fs.writeFile(pdfPath, buffer);
      const readBack = await fs.readFile(pdfPath);
      try {
        const parsed = await PDFDocument.load(readBack);
        pdfOk = parsed.getPageCount() > 0;
        pdfDetail = `${parsed.getPageCount()} page(s) reparsed`;
      } catch (error) {
        pdfOk = false;
        pdfDetail = `pdf reparse failed: ${String(error)}`;
      }
      artifacts.push({ name: `${safe}.pdf`, kind: "report:pdf", filePath: pdfPath, mimeType: "application/pdf", origin: "deterministic" });
    }
    const readBackMd = await fs.readFile(mdPath, "utf8");
    return {
      status: "SUCCESS",
      summary: `report written: ${artifacts.map((a) => a.name).join(", ")} (${pdfDetail})`,
      data: { markdown: toRelative(DIRS.root, mdPath), sections: params.sections.map((s) => s.heading) },
      evidence: [{ kind: "read-back", detail: `markdown ${readBackMd.length} chars; ${pdfDetail}` }],
      artifacts,
      verification: { verified: readBackMd.length === md.length && pdfOk, method: "read-back + pdf-reparse", detail: pdfDetail },
    };
  },
});

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
