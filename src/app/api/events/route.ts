import { eventsSince, latestEventId, subscribe, type ExecutiveEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time event stream (Server-Sent Events). The 3D office, task panel and
 * activity feed all consume this exact stream — there is no second, decorative
 * source of truth.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const taskFilter = url.searchParams.get("taskId") ?? undefined;
  let lastId = Number(url.searchParams.get("since") ?? 0);
  if (!Number.isFinite(lastId) || lastId <= 0) lastId = await latestEventId();

  const encoder = new TextEncoder();
  const pendingFromBus: ExecutiveEvent[] = [];
  const unsubscribe = subscribe((event) => {
    if (taskFilter && event.taskId !== taskFilter) return;
    pendingFromBus.push(event);
  });

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };
      send(`retry: 2000\n\n`);
      send(`event: ready\ndata: ${JSON.stringify({ since: lastId })}\n\n`);

      const deliver = (event: ExecutiveEvent) => {
        if (typeof event.id === "number") {
          if (event.id <= lastId) return;
          lastId = event.id;
        }
        send(`id: ${event.id ?? lastId}\nevent: executive\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const poll = async () => {
        try {
          const rows = await eventsSince(lastId, 100, taskFilter);
          for (const row of rows) deliver(row);
        } catch {
          /* database hiccup: try again on the next tick */
        }
      };

      const interval = setInterval(() => {
        if (closed) return;
        while (pendingFromBus.length > 0) {
          const event = pendingFromBus.shift();
          if (event) deliver(event);
        }
        void poll();
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 1000);

      await poll();

      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", abort);
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
