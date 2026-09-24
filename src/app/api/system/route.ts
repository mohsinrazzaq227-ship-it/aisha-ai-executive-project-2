import { desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, capabilitySnapshots, resourceSamples } from "@/db/schema";
import { runDoctor } from "@/lib/doctor";
import { snapshot } from "@/lib/resources";
import { listTools } from "@/lib/tools";
import { agentsForOffice, officeLayout } from "@/lib/office";
import { appConfig, providersConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const section = new URL(request.url).searchParams.get("section") ?? "all";

  if (section === "resources") {
    return Response.json({ resources: await snapshot(true), samples: await db.select().from(resourceSamples).orderBy(desc(resourceSamples.at)).limit(60) });
  }
  if (section === "audit") {
    const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.at)).limit(200);
    return Response.json({ audit: logs });
  }
  if (section === "tools") {
    return Response.json({
      tools: listTools().map((tool) => ({
        id: tool.id,
        title: tool.title,
        group: tool.group,
        risk: tool.risk,
        resourceClass: tool.resourceClass,
        agents: tool.agents,
        description: tool.description,
        verificationNote: tool.verificationNote,
      })),
    });
  }
  if (section === "office") {
    return Response.json({ layout: officeLayout(), agents: await agentsForOffice() });
  }

  const [doctor, resources, providers, config, capabilities] = await Promise.all([
    runDoctor(),
    snapshot(true),
    providersConfig(),
    appConfig(),
    db.select().from(capabilitySnapshots).orderBy(desc(capabilitySnapshots.at)).limit(1),
  ]);

  await db.insert(capabilitySnapshots).values({ payload: doctor as unknown as Record<string, unknown>, summary: doctor.summary }).catch(() => undefined);

  return Response.json({
    doctor,
    resources,
    providers,
    config,
    lastSnapshot: capabilities[0]?.at ?? null,
    tools: listTools().length,
  });
}
