import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { zipSync, strToU8 } from "fflate";
import { logEvent } from "@/lib/logging";
import { ensureDir, humanSize, relToRoot, resolveUserPath, uniqueFilename } from "@/lib/workspace";
import { fail, ok, type ToolHandler, type ToolResult } from "@/lib/tools/types";

const execFileAsync = promisify(execFile);

const fsList: ToolHandler = async (ctx) => {
  const dir = resolveUserPath(String(ctx.input.path), "documents");
  const limit = Number(ctx.input.limit ?? 100);
  if (!fs.existsSync(dir)) return fail(`Directory not found: ${dir}`, "ENOENT");
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return fail(`${dir} is not a directory`, "ENOTDIR");
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .slice(0, limit)
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let size = 0;
      let modified = "";
      try {
        const info = fs.statSync(full);
        size = info.size;
        modified = info.mtime.toISOString();
      } catch {
        /* unreadable entry */
      }
      return { name: entry.name, type: entry.isDirectory() ? "dir" : "file", size, sizeHuman: humanSize(size), modified, path: full };
    });
  return ok(
    `Listed ${entries.length} entries in ${dir}`,
    { dir, entries, total: fs.readdirSync(dir).length },
    `I listed ${entries.length} items in ${path.basename(dir)}.`,
  );
};

const fsRead: ToolHandler = async (ctx) => {
  const target = resolveUserPath(String(ctx.input.path), "documents");
  if (!fs.existsSync(target)) return fail(`File not found: ${target}`, "ENOENT");
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return fail(`${target} is a directory — use fs.list`, "EISDIR");
  if (stat.size > 5 * 1024 * 1024) {
    return fail(`File is ${humanSize(stat.size)} which exceeds the 5 MB safe read limit. Use doc.extract for large documents.`, "TOO_LARGE");
  }
  const maxChars = Number(ctx.input.maxChars ?? 40000);
  const raw = fs.readFileSync(target);
  const binary = raw.subarray(0, 4096).includes(0);
  if (binary) return fail(`File appears to be binary (${humanSize(stat.size)}). Use doc.extract instead of fs.read.`, "BINARY");
  const text = raw.toString("utf8");
  return ok(
    `Read ${Math.min(text.length, maxChars)} of ${text.length} characters from ${target}`,
    { path: target, content: text.slice(0, maxChars), truncated: text.length > maxChars, size: stat.size, sha256Hint: true },
    `I read ${path.basename(target)}.`,
  );
};

const fsWrite: ToolHandler = async (ctx) => {
  const requested = String(ctx.input.path);
  const content = String(ctx.input.content ?? "");
  const resolved = resolveUserPath(requested, "documents");
  const isDirPath = resolved.endsWith(path.sep) || !path.extname(resolved);
  const dir = isDirPath ? resolved : path.dirname(resolved);
  const filename = isDirPath ? `note_${Date.now()}.md` : path.basename(resolved);
  ensureDir(dir);
  const finalName = uniqueFilename(dir, filename);
  const finalPath = path.join(dir, finalName);
  const tempPath = `${finalPath}.partial`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, finalPath);
  await logEvent("computer", `File created: ${finalPath}`, { taskId: ctx.taskId, data: { bytes: Buffer.byteLength(content) } });
  return {
    ok: true,
    summary: `Created ${relToRoot(finalPath)} (${humanSize(Buffer.byteLength(content))})`,
    agentMessage: `The file is written: ${finalName}. Nothing existing was overwritten.`,
    output: { path: finalPath, replacedExisting: false, bytes: Buffer.byteLength(content) },
    artifacts: [
      {
        kind: "file",
        name: finalName,
        absPath: finalPath,
        mime: String(ctx.input.mime ?? "text/markdown"),
        meta: { createdBy: ctx.agentId, overwrite: "never" },
      },
    ],
  };
};

const fsCopy: ToolHandler = async (ctx) => {
  const from = resolveUserPath(String(ctx.input.from), "documents");
  const toRequested = resolveUserPath(String(ctx.input.to), "documents");
  if (!fs.existsSync(from)) return fail(`Source not found: ${from}`, "ENOENT");
  const to = fs.statSync(from).isDirectory() ? toRequested : path.join(path.dirname(toRequested), uniqueFilename(path.dirname(toRequested), path.basename(toRequested)));
  ensureDir(path.dirname(to));
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
  return ok(`Copied ${from} -> ${to}`, { from, to }, `Copy complete: ${path.basename(to)}.`);
};

const fsMove: ToolHandler = async (ctx) => {
  const from = resolveUserPath(String(ctx.input.from), "documents");
  const toRaw = resolveUserPath(String(ctx.input.to), "documents");
  if (!fs.existsSync(from)) return fail(`Source not found: ${from}`, "ENOENT");
  const dir = path.dirname(toRaw);
  ensureDir(dir);
  let to = toRaw;
  if (fs.existsSync(to)) {
    to = path.join(dir, uniqueFilename(dir, path.basename(toRaw)));
  }
  fs.renameSync(from, to);
  const renamed = path.basename(from) !== path.basename(to);
  return ok(`Moved ${from} -> ${to}`, { from, to, renamed }, `Done — the file is now ${path.basename(to)}.`);
};

const fsArchive: ToolHandler = async (ctx) => {
  const inputs = (ctx.input.paths as string[]).map((entry) => resolveUserPath(entry, "documents"));
  const format = String(ctx.input.format ?? "zip");
  const requested = resolveUserPath(String(ctx.input.to), "documents");
  const ext = format === "tar" ? ".tar" : ".zip";
  const dir = requested.endsWith(ext) ? path.dirname(requested) : requested;
  ensureDir(dir);
  const name = uniqueFilename(dir, requested.endsWith(ext) ? path.basename(requested) : `archive_${Date.now()}${ext}`);
  const target = path.join(dir, name);
  if (format === "tar") {
    const tarBin = process.platform === "win32" ? "tar" : "tar";
    try {
      await execFileAsync(tarBin, ["-cf", target, ...inputs], { timeout: 120000 });
    } catch (error) {
      return fail(`tar archiving failed: ${(error as Error).message}`, "TAR_FAILED", { inputs });
    }
  } else {
    const payload: Record<string, Uint8Array> = {};
    for (const entry of inputs) {
      if (!fs.existsSync(entry)) return fail(`Archive input missing: ${entry}`, "ENOENT");
      const stat = fs.statSync(entry);
      if (stat.isDirectory()) {
        const walk = (current: string) => {
          for (const child of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, child.name);
            if (child.isDirectory()) walk(full);
            else payload[path.relative(path.dirname(entry), full).replace(/\\/g, "/")] = fs.readFileSync(full);
          }
        };
        walk(entry);
      } else {
        payload[path.basename(entry)] = fs.readFileSync(entry);
      }
    }
    if (Object.keys(payload).length === 0) payload["empty.txt"] = strToU8("no files matched");
    fs.writeFileSync(target, Buffer.from(zipSync(payload, { level: 6 })));
  }
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    size = 0;
  }
  return {
    ok: true,
    summary: `Created ${target} (${humanSize(size)}) from ${inputs.length} input(s)`,
    agentMessage: `Archive written with ${Object.keys(inputs).length} inputs. Original files untouched.`,
    output: { target, size, inputs },
    artifacts: [{ kind: "archive", name, absPath: target, mime: format === "tar" ? "application/x-tar" : "application/zip" }],
  };
};

const fsDelete: ToolHandler = async (ctx) => {
  const confirmation = String(ctx.input.confirmation ?? "");
  if (confirmation !== "DELETE") {
    return fail("Deletion refused: the confirmation phrase must be exactly DELETE.", "CONFIRMATION_REQUIRED");
  }
  const targets = (ctx.input.paths as string[]).map((entry) => resolveUserPath(entry, "documents"));
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      skipped.push(`${target} (missing)`);
      continue;
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: false });
    else fs.unlinkSync(target);
    removed.push(target);
  }
  await logEvent("security", `Deletion executed: ${removed.join(", ") || "nothing"}`, {
    level: "warn",
    taskId: ctx.taskId,
    data: { removed, skipped },
  });
  return {
    ok: removed.length > 0,
    summary: removed.length > 0 ? `Permanently deleted ${removed.length} item(s)` : "Nothing deleted",
    agentMessage: removed.length > 0 ? `Deletion complete. ${removed.length} item(s) removed permanently.` : "No targets existed, so nothing was deleted.",
    output: { removed, skipped },
    error: removed.length === 0 ? "No targets existed" : undefined,
  };
};

const reportWrite: ToolHandler = async (ctx) => {
  const title = String(ctx.input.title);
  const sections = ctx.input.sections as { heading: string; body: string; bullets?: string[] }[];
  const sources = (ctx.input.sources as { title: string; url: string }[] | undefined) ?? [];
  const destination = ctx.input.destination ? String(ctx.input.destination) : undefined;

  const lines: string[] = [
    `# ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Task: ${ctx.taskId} · run ${ctx.runId}`,
    "",
    "## Provenance",
    "",
    `- Composed by the ${ctx.agentId} inside AI-EXECUTIVE.`,
    `- Source records: ${sources.length}`,
    "- Provider mode: local-first, no paid API used for composition.",
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, "", section.body.trim(), "");
    if (section.bullets && section.bullets.length > 0) {
      for (const bullet of section.bullets) lines.push(`- ${bullet}`);
      lines.push("");
    }
  }
  if (sources.length > 0) {
    lines.push("## Sources", "");
    sources.forEach((source, index) => lines.push(`${index + 1}. [${source.title}](${source.url})`));
    lines.push("");
  }
  const markdown = lines.join("\n");

  const target = destination ? resolveUserPath(destination, "documents") : ctx.workspace.documentsRoot;
  const isDir = destination ? !path.extname(target) : true;
  const dir = isDir ? target : path.dirname(target);
  ensureDir(dir);
  const base = `${title.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "report"}.md`;
  const name = uniqueFilename(dir, safe(base));
  const finalPath = path.join(dir, name);
  fs.writeFileSync(finalPath, markdown, "utf8");

  return {
    ok: true,
    summary: `Report written: ${relToRoot(finalPath)} (${humanSize(Buffer.byteLength(markdown))}, ${sections.length} sections, ${sources.length} sources)`,
    agentMessage: `Report saved as ${name} with ${sections.length} sections and ${sources.length} cited sources.`,
    output: { path: finalPath, sections: sections.length, sources: sources.length, markdownPreview: markdown.slice(0, 1500), markdown },
    artifacts: [
      {
        kind: "report",
        name,
        absPath: finalPath,
        mime: "text/markdown",
        meta: { title, sections: sections.length, sources: sources.map((s) => s.url), bytes: Buffer.byteLength(markdown) },
        validated: true,
      },
    ],
  };
};

function safe(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

export const FS_TOOLS: Record<string, ToolHandler> = {
  "fs.list": fsList,
  "fs.read": fsRead,
  "fs.write": fsWrite,
  "fs.copy": fsCopy,
  "fs.move": fsMove,
  "fs.archive": fsArchive,
  "fs.delete": fsDelete,
  "report.write": reportWrite,
};

export type { ToolResult };
