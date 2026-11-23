import { NextResponse } from "next/server";
import { gate } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { mintMcpToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The Agent page (/agent): the one MCP token (lib/mcp.ts). The page reads when it was made;
// POST = mint (replaces any old one; the plaintext is returned this once), DELETE = revoke.
export async function POST() {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  return NextResponse.json(await mintMcpToken(g.user!.id));
}

export async function DELETE() {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  await prisma.user.update({ where: { id: g.user!.id }, data: { mcpTokenHash: null, mcpTokenCreatedAt: null } });
  return NextResponse.json({ createdAt: null });
}
