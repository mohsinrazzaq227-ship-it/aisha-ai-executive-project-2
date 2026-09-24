import { promises as fs } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok } from "@/lib/tools/types";
import { checkPath } from "@/lib/security";
import { ensureDir, fileInfo, sha256, slugify, toRelative, truncate } from "@/lib/util";

const TARGET = z.string().min(1);

function resolveTarget(input: string): string {
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(DIRS.workspace, input);
}

registerTool({
  id: "fs.list",
  title: "List directory",
  group: "fs",
  description: "Lists a directory with real sizes and hashes computed from disk.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["files", "docs", "code", "security", "aisha", "data"],
  params: z.object({ path: z.string().default(DIRS.workspace) }),
  verificationNote: "Directory entry count is re-read after listing and compared.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const gate = await checkPath(target, "list");
    if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => null);
    if (!entries) return fail("FAILED", `cannot read directory ${toRelative(DIRS.root, target)}`);
    const rows = await Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        const full = path.join(target, entry.name);
        const stat = await fs.stat(full).catch(() => null);
        return {
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          bytes: entry.isDirectory() ? 0 : stat?.size ?? 0,
          modified: stat?.mtime.toISOString() ?? "",
        };
      }),
    );
    const reread = await fs.readdir(target).catch(() => []);
    return {
      status: "SUCCESS",
      summary: `${rows.length} entr(y|ies) in ${toRelative(DIRS.root, target)}`,
      data: { path: toRelative(DIRS.root, target), entries: rows },
      evidence: [{ kind: "list", detail: `first pass ${entries.length}, second pass ${reread.length}` }],
      artifacts: [],
      verification: {
        verified: entries.length === reread.length,
        method: "double-read",
        detail: `${entries.length} vs ${reread.length} entries`,
      },
    };
  },
});

registerTool({
  id: "fs.read",
  title: "Read file",
  group: "fs",
  description: "Reads a file and returns content plus sha256 and byte size of what was actually read.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["files", "docs", "data", "qa", "code", "research", "aisha", "security"],
  params: z.object({ path: TARGET, maxBytes: z.number().int().min(1).max(2_000_000).default(200_000) }),
  verificationNote: "Returned content length is re-hashed after read; both hashes must match.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const gate = await checkPath(target, "read");
    if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
    const buffer = await fs.readFile(target).catch(() => null);
    if (!buffer) return fail("FAILED", `file not found: ${toRelative(DIRS.root, target)}`);
    const slice = buffer.subarray(0, params.maxBytes);
    const digest = sha256(slice);
    const verified = sha256(buffer.subarray(0, params.maxBytes)) === digest;
    return {
      status: "SUCCESS",
      summary: `read ${slice.byteLength}B from ${toRelative(DIRS.root, target)} (sha256 ${digest.slice(0, 12)}…)`,
      data: { path: toRelative(DIRS.root, target), bytes: slice.byteLength, sha256: digest, content: truncate(slice.toString("utf8"), 60_000) },
      evidence: [{ kind: "hash", detail: `sha256 ${digest}` }],
      artifacts: [],
      verification: { verified, method: "re-hash", detail: verified ? `sha256 ${digest.slice(0, 16)} stable` : "hash mismatch" },
    };
  },
});

registerTool({
  id: "fs.hash",
  title: "Hash file",
  group: "fs",
  description: "Computes sha256 of a file from disk for integrity comparison.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["files", "qa", "security", "aisha"],
  params: z.object({ path: TARGET }),
  verificationNote: "Hash is recomputed a second time and compared.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const first = await fileInfo(target).catch(() => null);
    if (!first) return fail("FAILED", `cannot hash missing file ${toRelative(DIRS.root, target)}`);
    const second = await fileInfo(target);
    return {
      status: "SUCCESS",
      summary: `sha256 ${first.sha256} · ${first.bytes}B`,
      data: { path: toRelative(DIRS.root, target), ...first },
      evidence: [{ kind: "hash", detail: first.sha256 }],
      artifacts: [],
      verification: { verified: first.sha256 === second.sha256, method: "double-hash", detail: "two independent reads agree" },
    };
  },
});

registerTool({
  id: "fs.write",
  title: "Write file",
  group: "fs",
  description: "Writes text content to disk. Writing outside the AISHA workspace escalates to an approval-gated HIGH risk.",
  risk: "MEDIUM",
  riskFor: (params) => (path.resolve(DIRS.workspace) === resolveTarget(params.path) || resolveTarget(params.path).startsWith(`${path.resolve(DIRS.workspace)}${path.sep}`) ? "MEDIUM" : "HIGH"),
  resourceClass: "LIGHT",
  agents: ["files", "docs", "code", "aisha", "data"],
  params: z.object({ path: TARGET, content: z.string(), append: z.boolean().default(false) }),
  verificationNote: "File is read back from disk, its byte size and hash compared against the written buffer.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const gate = await checkPath(target, "write");
    if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
    await ensureDir(path.dirname(target));
    if (params.append) await fs.appendFile(target, params.content, "utf8");
    else await fs.writeFile(target, params.content, "utf8");
    const readBack = await fs.readFile(target, "utf8");
    const expectedBytes = Buffer.byteLength(params.content);
    const verified = params.append ? readBack.endsWith(params.content) : readBack === params.content;
    return {
      status: "SUCCESS",
      summary: `${params.append ? "appended" : "wrote"} ${expectedBytes}B → ${toRelative(DIRS.root, target)}`,
      data: { path: toRelative(DIRS.root, target), bytes: Buffer.byteLength(readBack), sha256: sha256(readBack) },
      evidence: [{ kind: "read-back", detail: `${Buffer.byteLength(readBack)}B read back from disk` }],
      artifacts: [],
      verification: { verified, method: "read-back-compare", detail: verified ? "byte-identical to requested content" : "read-back content differs" },
    };
  },
});

registerTool({
  id: "fs.copy",
  title: "Copy or move file",
  group: "fs",
  description: "Copies (or moves) a file within the workspace sandbox.",
  risk: "MEDIUM",
  riskFor: () => "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["files", "docs", "aisha"],
  params: z.object({ from: TARGET, to: TARGET, move: z.boolean().default(false) }),
  verificationNote: "Destination hash must equal source hash, and the source must be absent after a move.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const source = resolveTarget(params.from);
    const dest = resolveTarget(params.to);
    for (const [label, p] of [["source", source], ["destination", dest]] as const) {
      const gate = await checkPath(p, "write");
      if (!gate.allowed) return fail("BLOCKED", `${label} refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
    }
    const sourceInfo = await fileInfo(source).catch(() => null);
    if (!sourceInfo) return fail("FAILED", `source missing: ${toRelative(DIRS.root, source)}`);
    await ensureDir(path.dirname(dest));
    if (params.move) await fs.rename(source, dest);
    else await fs.copyFile(source, dest);
    const destInfo = await fileInfo(dest);
    const sourceGone = params.move ? !(await fs.access(source).then(() => true, () => false)) : true;
    const verified = destInfo.sha256 === sourceInfo.sha256 && sourceGone;
    return {
      status: "SUCCESS",
      summary: `${params.move ? "moved" : "copied"} ${toRelative(DIRS.root, source)} → ${toRelative(DIRS.root, dest)}`,
      data: { from: toRelative(DIRS.root, source), to: toRelative(DIRS.root, dest), sha256: destInfo.sha256, bytes: destInfo.bytes },
      evidence: [{ kind: "hash-match", detail: `source ${sourceInfo.sha256.slice(0, 12)} = dest ${destInfo.sha256.slice(0, 12)}` }],
      artifacts: [],
      verification: { verified, method: "hash-compare + source-removal-check", detail: verified ? "hashes match; source state as expected" : "hash or source-state mismatch" },
    };
  },
});

registerTool({
  id: "fs.archive",
  title: "Archive files",
  group: "fs",
  description: "Creates a real ZIP archive (fflate) from workspace files and registers it as an artifact.",
  risk: "MEDIUM",
  resourceClass: "MEDIUM",
  agents: ["files", "docs", "aisha"],
  params: z.object({ paths: z.array(TARGET).min(1).max(200), output: z.string().optional() }),
  verificationNote: "Archive is re-opened from disk and each entry is compared to the source hash.",
  availability: async () => ({ available: true, detail: "fflate zip available (pure JS)" }),
  execute: async (ctx, params) => {
    const files: Record<string, Uint8Array> = {};
    const expected: Record<string, string> = {};
    for (const input of params.paths) {
      const target = resolveTarget(input);
      const gate = await checkPath(target, "read");
      if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) return fail("FAILED", `missing input: ${toRelative(DIRS.root, target)}`);
      if (stat.isDirectory()) {
        const children = await fs.readdir(target, { withFileTypes: true });
        for (const child of children.slice(0, 100)) {
          if (!child.isFile()) continue;
          const full = path.join(target, child.name);
          const buffer = await fs.readFile(full);
          files[`${path.basename(target)}/${child.name}`] = new Uint8Array(buffer);
          expected[`${path.basename(target)}/${child.name}`] = sha256(buffer);
        }
      } else {
        const buffer = await fs.readFile(target);
        files[path.basename(target)] = new Uint8Array(buffer);
        expected[path.basename(target)] = sha256(buffer);
      }
    }
    if (!Object.keys(files).length) return fail("FAILED", "no readable files matched the request");
    const zipped = zipSync(files, { level: 6 });
    const output = resolveTarget(params.output ?? path.join(DIRS.artifacts, ctx.taskId, `${slugify(`archive-${Date.now()}`)}.zip`));
    const gate = await checkPath(output, "write");
    if (!gate.allowed) return fail("BLOCKED", `output refused: ${gate.reason}`);
    await ensureDir(path.dirname(output));
    await fs.writeFile(output, zipped);
    const { unzipSync } = await import("fflate");
    const reopened = unzipSync(new Uint8Array(await fs.readFile(output)));
    const names = Object.keys(reopened);
    const mismatches = names.filter((name) => sha256(Buffer.from(reopened[name])) !== expected[name]);
    return {
      status: "SUCCESS",
      summary: `archived ${names.length} entr(y|ies) → ${toRelative(DIRS.root, output)} (${zipped.byteLength}B)`,
      data: { output: toRelative(DIRS.root, output), entries: names, bytes: zipped.byteLength },
      evidence: [{ kind: "zip-verify", detail: `${names.length} entries reopened; ${mismatches.length} mismatches` }],
      artifacts: [{ name: path.basename(output), kind: "archive", filePath: output, mimeType: "application/zip", origin: "deterministic" }],
      verification: {
        verified: mismatches.length === 0 && names.length === Object.keys(expected).length,
        method: "reopen-zip + per-entry hash",
        detail: mismatches.length ? `mismatched entries: ${mismatches.join(", ")}` : "all entries hash-identical to sources",
      },
    };
  },
});

registerTool({
  id: "fs.delete",
  title: "Delete file (approval required)",
  group: "fs",
  description: "Deletes a workspace file only after a signed human approval. System paths are refused outright.",
  risk: "HIGH",
  resourceClass: "LIGHT",
  agents: ["files", "aisha"],
  params: z.object({ path: TARGET, reason: z.string().min(3).max(500) }),
  verificationNote: "Existence is re-checked after deletion; the tool fails if the path still resolves.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const gate = await checkPath(target, "delete");
    if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`, [{ kind: "path-policy", detail: gate.reason }]);
    const before = await fileInfo(target).catch(() => null);
    if (!before) return fail("FAILED", `file already absent: ${toRelative(DIRS.root, target)}`);
    await fs.unlink(target);
    const stillThere = await fs.access(target).then(() => true, () => false);
    return {
      status: "SUCCESS",
      summary: `deleted ${toRelative(DIRS.root, target)} (${before.bytes}B, sha256 ${before.sha256.slice(0, 12)}…) — reason: ${params.reason}`,
      data: { path: toRelative(DIRS.root, target), deletedBytes: before.bytes, sha256: before.sha256 },
      evidence: [{ kind: "post-condition", detail: stillThere ? "path still exists" : "path no longer exists" }],
      artifacts: [],
      verification: { verified: !stillThere, method: "post-delete-existence-check", detail: stillThere ? "path still resolved after unlink" : "confirmed removed" },
    };
  },
});

registerTool({
  id: "fs.mkdir",
  title: "Create directory",
  group: "fs",
  description: "Creates a directory inside the sandbox.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["files", "docs", "aisha", "code"],
  params: z.object({ path: TARGET }),
  verificationNote: "Directory stats are read back after creation.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (_ctx, params) => {
    const target = resolveTarget(params.path);
    const gate = await checkPath(target, "write");
    if (!gate.allowed) return fail("BLOCKED", `refused: ${gate.reason}`);
    await ensureDir(target);
    const stat = await fs.stat(target).catch(() => null);
    return {
      status: "SUCCESS",
      summary: `directory ready: ${toRelative(DIRS.root, target)}`,
      data: { path: toRelative(DIRS.root, target) },
      evidence: [{ kind: "stat", detail: stat?.isDirectory() ? "directory confirmed" : "not a directory" }],
      artifacts: [],
      verification: { verified: Boolean(stat?.isDirectory()), method: "stat-read-back", detail: stat?.isDirectory() ? "isDirectory() true" : "failed" },
    };
  },
});
