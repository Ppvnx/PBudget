import { NextResponse } from "next/server";
import { gate } from "@/lib/guard";
import { enqueue } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// POST /api/review/analyze — queue the full analyzer (auto-match → vendor re-match →
// suspicion rules) without needing a Plaid sync: what sync runs after fetching, surfaced
// as the "Analysis" button on Review so config/data changes (e.g. a widened auto-merge
// rule) take effect. A job (lib/jobs.ts): the panel shows it and its fresh counts.
export async function POST() {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  return NextResponse.json({ job: await enqueue(g.user!.id, "analyze") });
}
