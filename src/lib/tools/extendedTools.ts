import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { ensureDir, humanSize, relToRoot, uniqueFilename } from "@/lib/workspace";
import { fail, ok, type ToolContext, type ToolHandler } from "@/lib/tools/types";

/** Real PDF/DOCX export with an honest limitation report when the engine is absent. */
const reportExport: ToolHandler = async (ctx) => {
  let sourcePath = ctx.input.artifactPath ? String(ctx.input.artifactPath) : "";
  if (!sourcePath && ctx.input.artifactId) {
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, String(ctx.input.artifactId))).limit(1);
    if (row) sourcePath = ((row.meta ?? {}) as { absPath?: string }).absPath ?? row.relPath;
  }
  if (!sourcePath) {
    const reportPath = ctx.findings.reportPath as string | undefined;
    if (reportPath) sourcePath = reportPath;
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return fail(`No readable report to export (looked for artifactPath/artifactId/previous report). Nothing was generated.`, "NO_SOURCE_REPORT");
  }
  const format = String(ctx.input.format ?? "pdf") === "docx" ? "docx" : "pdf";
  const markdown = fs.readFileSync(sourcePath, "utf8");
  const title = String(ctx.input.title ?? path.basename(sourcePath).replace(/\.(md|txt)$/i, ""));
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath).replace(/\.(md|txt)$/i, "");

  if (format === "pdf") {
    let PDFDocument: unknown = null;
    try {
      const require_ = (await import("node:module")).createRequire(`${process.cwd()}/package.json`);
      PDFDocument = require_("pdfkit");
    } catch {
      PDFDocument = null;
    }
    if (!PDFDocument) {
      return fail(
        `PDF export requires the optional "pdfkit" package, which is not installed. The Markdown report at ${relToRoot(sourcePath)} is complete and readable; nothing was faked into a PDF.`,
        "PDF_ENGINE_NOT_CONFIGURED",
        { installPath: "npm install pdfkit", sourceReport: sourcePath },
      );
    }
    const name = uniqueFilename(dir, `${base}.pdf`);
    const outPath = path.join(dir, name);
    const Doc = PDFDocument as new (options: Record<string, unknown>) => {
      pipe: (stream: NodeJS.WritableStream) => void;
      font: (name: string) => unknown;
      fontSize: (size: number) => { text: (text: string, options?: Record<string, unknown>) => unknown };
      moveDown: (lines?: number) => void;
      addPage: () => void;
      end: () => void;
    };
    const doc = new Doc({ size: "A4", margin: 54 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    doc.fontSize(20).text(title, { underline: false });
    doc.moveDown(0.6);
    for (const line of markdown.split("\n")) {
      if (line.startsWith("# ")) continue;
      if (line.startsWith("## ")) {
        doc.moveDown(0.5);
        doc.fontSize(14).text(line.replace(/^##\s+/, ""));
        continue;
      }
      doc.fontSize(10.5).text(line.length > 0 ? line : " ");
    }
    doc.end();
    await new Promise<void>((resolve) => stream.on("finish", () => resolve()));
    const size = fs.statSync(outPath).size;
    return {
      ok: size > 500,
      summary: `Exported a real PDF (${humanSize(size)}) to ${relToRoot(outPath)} from ${relToRoot(sourcePath)}.`,
      agentMessage: `PDF written: ${name}.`,
      output: { path: outPath, bytes: size, source: sourcePath, format },
      artifacts: [{ kind: "report", name, absPath: outPath, mime: "application/pdf", meta: { source: relToRoot(sourcePath), engine: "pdfkit" }, validated: size > 500 }],
    };
  }

  // DOCX: emit a genuinely valid minimal OOXML package (Word can open it) via fflate.
  try {
    const { zipSync, strToU8 } = await import("fflate");
    const name = uniqueFilename(dir, `${base}.docx`);
    const outPath = path.join(dir, name);
    const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const paragraphs = markdown
      .split("\n")
      .map((line) => {
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
          const size = heading[1].length === 1 ? 36 : heading[1].length === 2 ? 28 : 24;
          return `<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(heading[2])}</w:t></w:r></w:p>`;
        }
        return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
      })
      .join("");
    const payload: Record<string, Uint8Array> = {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
      ),
    };
    fs.writeFileSync(outPath, Buffer.from(zipSync(payload, { level: 6 })));
    const size = fs.statSync(outPath).size;
    return {
      ok: size > 500,
      summary: `Exported a real DOCX (${humanSize(size)}) to ${relToRoot(outPath)} from ${relToRoot(sourcePath)}.`,
      agentMessage: `Word document written: ${name}.`,
      output: { path: outPath, bytes: size, source: sourcePath, format: "docx" },
      artifacts: [{ kind: "report", name, absPath: outPath, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", meta: { source: relToRoot(sourcePath), engine: "fflate-ooxml" }, validated: size > 500 }],
    };
  } catch (error) {
    return fail(`DOCX export failed: ${(error as Error).message}`, "DOCX_EXPORT_FAILED");
  }
};

/** Registers whatever the task actually produced, including the validation reports. */
const artifactRegisterFromFindings: ToolHandler = async (ctx) => {
  const dir = ensureDir(path.join(ctx.runDir, "validation"));
  const manifestPath = path.join(dir, "artifact_registration.json");
  const produced = ((ctx.findings.artifactPaths as Record<string, string> | undefined) ?? {}) as Record<string, string>;
  const entries: { path: string; bytes: number; sha256?: string }[] = [];
  for (const [, absPath] of Object.entries(produced)) {
    if (absPath && fs.existsSync(absPath)) entries.push({ path: relToRoot(absPath), bytes: fs.statSync(absPath).size });
  }
  const reportPath = ctx.findings.reportPath as string | undefined;
  const videoPath = ctx.findings.videoPath as string | undefined;
  for (const extra of [reportPath, videoPath]) {
    if (extra && fs.existsSync(extra) && !entries.some((entry) => entry.path === relToRoot(extra))) {
      entries.push({ path: relToRoot(extra), bytes: fs.statSync(extra).size });
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ taskId: ctx.taskId, runId: ctx.runId, registeredAt: new Date().toISOString(), entries }, null, 2), "utf8");
  return {
    ok: entries.length > 0,
    summary: entries.length > 0 ? `Registered ${entries.length} produced file(s) with byte sizes in the run manifest; every entry must exist on disk to be listed.` : "No artifacts were produced by this task yet, so nothing was registered.",
    agentMessage: entries.length > 0 ? `${entries.length} files are registered and linked to this task.` : "Nothing was produced to register.",
    output: { entries, manifestPath },
    artifacts: [{ kind: "manifest", name: "artifact_registration.json", absPath: manifestPath, mime: "application/json", meta: { entries: entries.length } }],
  };
};

export const EXTENDED_TOOLS: Record<string, ToolHandler> = {
  "report.export": reportExport,
  "artifact.register": artifactRegisterFromFindings,
};

export type { ToolContext };
