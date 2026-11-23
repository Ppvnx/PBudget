import { redirect } from "next/navigation";
import { requireUser, MCP_HISTORY_MS } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getLocale } from "@/lib/i18n/server";
import { t } from "@/lib/i18n";
import AgentAccess from "@/components/AgentAccess";

export const dynamic = "force-dynamic";

// ponytail: newest 500 only; page it if an agent ever does more than that in a week.
const SHOWN = 500;

// The Agent page: the MCP token an AI agent connects with (lib/mcp.ts) and every tool it
// called in the last 7 days (McpCall rows, written and pruned by lib/mcp.ts).
export default async function AgentPage() {
  const user = await requireUser();
  if (!user.emailVerified) redirect("/verify");
  const locale = await getLocale(user);
  const calls = await prisma.mcpCall.findMany({
    where: { userId: user.id, createdAt: { gte: new Date(Date.now() - MCP_HISTORY_MS) } },
    orderBy: { createdAt: "desc" },
    take: SHOWN,
  });
  return (
    <div>
      <h1>{t(locale, "nav.agent")}</h1>
      <AgentAccess
        createdAt={user.mcpTokenCreatedAt?.toISOString() ?? null}
        calls={calls.map((c) => ({ id: c.id, tool: c.tool, args: c.args, error: c.error, at: c.createdAt.toISOString() }))}
        capped={calls.length === SHOWN}
      />
    </div>
  );
}
