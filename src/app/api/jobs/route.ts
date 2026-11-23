import { NextResponse } from "next/server";
import { gate } from "@/lib/guard";
import { userJobs, dismissJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/jobs — the signed-in user's background jobs, for the jobs panel (lib/jobs.ts).
export async function GET() {
  const g = await gate();
  if (g.error) return g.error;
  return NextResponse.json({ jobs: await userJobs(g.user!.id) });
}

// POST /api/jobs {dismiss: id} — close a failed job's card.
export async function POST(req: Request) {
  const g = await gate();
  if (g.error) return g.error;
  const { dismiss } = await req.json().catch(() => ({}));
  if (typeof dismiss !== "string") return NextResponse.json({ error: "Missing dismiss" }, { status: 400 });
  await dismissJob(g.user!.id, dismiss);
  return NextResponse.json({ ok: true });
}
