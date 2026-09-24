import { eventsAfter, recentEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * One authoritative event stream. `?stream=1` opens an SSE tail that polls the
 * persisted event table, so the UI, the task panel and the 3D office all read
 * exactly the same rows (no separate UI-only event simulation).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const after = Number(url.searchParams.get("after") ?? 0);
  const stream = url.searchParams.get("stream") === "1";

  if (!stream) {
    const rows = after > 0 ? await eventsAfter(after, limit) : await recentEvents(limit);
    return Response.json({ events: rows, lastId: rows.length ? rows[rows.length - 1].id : after });
  }

  const encoder = new TextEncoder();
  const latest = (await recentEvents(1)).at(0)?.id ?? 0;
  let cursor = after > 0 ? after : latest;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ type: "ready", cursor });
      const timer = setInterval(async () => {
        try {
          const rows = await eventsAfter(cursor, 200);
          if (rows.length) {
            cursor = rows[rows.length - 1].id;
            send({ type: "events", events: rows, lastId: cursor });
          } else {
            send({ type: "heartbeat", cursor, at: new Date().toISOString() });
          }
        } catch (error) {
          send({ type: "error", detail: String(error).slice(0, 200) });
        }
      }, 1000);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        controller.close();
      });
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
