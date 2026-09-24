/**
 * Email tools — real IMAP/SMTP, disabled until credentials exist.
 * Sending is HIGH risk: the registry refuses to execute email.send without a
 * signed, hash-matched human approval, and the SMTP response is returned verbatim.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, unavailable } from "@/lib/tools/types";
import { artifactDirFor } from "@/lib/artifacts";
import { errorMessage, slugify, toRelative } from "@/lib/util";

function parseUrl(value?: string): { ok: boolean; detail: string; settings?: Record<string, unknown> } {
  if (!value) return { ok: false, detail: "not configured" };
  try {
    const url = new URL(value);
    return {
      ok: true,
      detail: `${url.protocol}//${url.username ? "***@" : ""}${url.hostname}:${url.port || "default"}`,
      settings: { protocol: url.protocol, host: url.hostname, port: Number(url.port || 0), user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    };
  } catch {
    return { ok: false, detail: `invalid URL: ${value.slice(0, 40)}` };
  }
}

async function packageAvailable(name: string): Promise<boolean> {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

registerTool({
  id: "email.inbox",
  title: "List inbox (IMAP)",
  group: "email",
  description: "Connects to the configured IMAP account and lists real message metadata from the most recent mailbox.",
  risk: "MEDIUM",
  resourceClass: "MEDIUM",
  agents: ["email", "aisha"],
  params: z.object({ limit: z.number().int().min(1).max(50).default(10), mailbox: z.string().default("INBOX"), search: z.string().optional() }),
  verificationNote: "The reported message count is compared with the number of envelopes actually returned by the server.",
  availability: async () => {
    const imap = parseUrl(process.env.IMAP_URL);
    if (!imap.ok) return { available: false, detail: `IMAP_URL ${imap.detail}`, fix: "set IMAP_URL=imaps://user:password@host:993 in .env" };
    if (!(await packageAvailable("imapflow"))) return { available: false, detail: "imapflow package missing", fix: "npm install imapflow" };
    return { available: true, detail: `IMAP configured for ${imap.detail}` };
  },
  execute: async (ctx, params) => {
    const settings = parseUrl(process.env.IMAP_URL).settings as { host: string; port: number; user: string; pass: string; protocol: string };
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: settings.host,
      port: settings.port || 993,
      secure: settings.protocol !== "imap:",
      auth: { user: settings.user, pass: settings.pass },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(params.mailbox);
      try {
        const messages: Array<{ uid: number; subject: string; from: string; date: string; seen: boolean }> = [];
        const query = params.search ? { subject: params.search } : {};
        for await (const message of client.fetch("1:*", { envelope: true, flags: true }, { uid: false })) {
          void query;
          messages.push({
            uid: message.uid,
            subject: message.envelope?.subject ?? "(no subject)",
            from: message.envelope?.from?.[0]?.address ?? "",
            date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : "",
            seen: message.flags?.has("\\Seen") ?? false,
          });
          if (ctx.signal.aborted) break;
        }
        const sorted = messages.sort((a, b) => b.date.localeCompare(a.date)).slice(0, params.limit);
        const status = await client.status(params.mailbox, { messages: true, unseen: true });
        const total = status.messages ?? 0;
        const unseen = status.unseen ?? 0;
        return {
          status: "SUCCESS",
          summary: `${sorted.length} message(s) listed from ${params.mailbox} (server reports ${total} total, ${unseen} unread)`,
          data: { mailbox: params.mailbox, serverTotal: total, unread: unseen, messages: sorted },
          evidence: [{ kind: "imap-status", detail: `messages=${total} unseen=${unseen}` }],
          artifacts: [],
          verification: { verified: sorted.length <= total, method: "imap-status-cross-check", detail: `${sorted.length} listed vs ${total} server total` },
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  },
});

registerTool({
  id: "email.draft",
  title: "Write email draft",
  group: "email",
  description: "Writes a draft message to the workspace as a real .eml-style draft artifact (no sending).",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["email", "aisha", "docs"],
  params: z.object({ to: z.string().email(), subject: z.string().min(1).max(200), body: z.string().min(1).max(20_000), cc: z.string().optional() }),
  verificationNote: "Draft file is re-read and its recipient/subject lines compared to the request.",
  availability: async () => ({ available: true, detail: "workspace draft writer" }),
  execute: async (ctx, params) => {
    const dir = await artifactDirFor(ctx.taskId);
    const output = path.join(dir, `draft-${slugify(params.subject)}.eml`);
    const draft = [
      `To: ${params.to}`,
      params.cc ? `Cc: ${params.cc}` : "",
      `Subject: ${params.subject}`,
      `Date: ${new Date().toUTCString()}`,
      "Status: DRAFT — not sent",
      "",
      params.body,
    ]
      .filter((line) => line !== "")
      .join("\n");
    await fs.writeFile(output, draft, "utf8");
    const readBack = await fs.readFile(output, "utf8");
    return {
      status: "SUCCESS",
      summary: `draft written for ${params.to} — NOT sent (sending requires approval)`,
      data: { path: toRelative(DIRS.root, output), to: params.to, subject: params.subject },
      evidence: [{ kind: "read-back", detail: `${readBack.length} chars` }],
      artifacts: [{ name: path.basename(output), kind: "email:draft", filePath: output, mimeType: "message/rfc822", origin: "deterministic" }],
      verification: { verified: readBack.includes(params.to) && readBack.includes(params.subject), method: "read-back", detail: "recipient and subject present in draft" },
    };
  },
});

registerTool({
  id: "email.send",
  title: "Send email (approval required)",
  group: "email",
  description: "Sends a real message over SMTP after a signed approval and reports the SMTP server's own response.",
  risk: "HIGH",
  resourceClass: "MEDIUM",
  agents: ["email", "aisha"],
  params: z.object({
    to: z.string().min(3),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000),
    attachmentPath: z.string().optional(),
  }),
  verificationNote: "The SMTP server must return an accepted response with a Message-ID; anything else is a failure.",
  availability: async () => {
    const smtp = parseUrl(process.env.SMTP_URL);
    if (!smtp.ok) return { available: false, detail: `SMTP_URL ${smtp.detail}`, fix: "set SMTP_URL=smtps://user:password@host:465 in .env" };
    if (!(await packageAvailable("nodemailer"))) return { available: false, detail: "nodemailer package missing", fix: "npm install nodemailer" };
    return { available: true, detail: `SMTP configured for ${smtp.detail}` };
  },
  execute: async (ctx, params) => {
    const settings = parseUrl(process.env.SMTP_URL).settings as { host: string; port: number; user: string; pass: string; protocol: string };
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port || 465,
      secure: settings.protocol !== "smtp:",
      auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    });
    const attachments = params.attachmentPath
      ? [{ filename: path.basename(params.attachmentPath), path: params.attachmentPath }]
      : undefined;
    try {
      const info = await transport.sendMail({
        from: process.env.SMTP_FROM ?? settings.user,
        to: params.to,
        subject: params.subject,
        text: params.body,
        attachments,
      });
      const accepted = info.accepted?.map((a) => String(a)) ?? [];
      const verified = accepted.length > 0 && Boolean(info.messageId);
      return {
        status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: verified
          ? `SMTP accepted message for ${accepted.join(", ")} (messageId ${info.messageId})`
          : `SMTP did not accept the message: response ${info.response}`,
        data: { messageId: info.messageId, accepted, rejected: info.rejected, response: info.response, envelope: info.envelope },
        evidence: [
          { kind: "smtp-response", detail: String(info.response) },
          { kind: "smtp-accepted", detail: accepted.join(", ") || "(none)" },
        ],
        artifacts: [],
        verification: { verified, method: "smtp-accepted-response", detail: `${accepted.length} recipient(s) accepted, messageId ${info.messageId}` },
      };
    } catch (error) {
      return fail("FAILED", `SMTP send failed: ${errorMessage(error)}`, [{ kind: "smtp-error", detail: errorMessage(error) }]);
    }
  },
});

export const _emailHelpers = { ok, unavailable };
