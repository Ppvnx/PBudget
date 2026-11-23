// A pbudget-worker pod (Setups config/k8s/pbudget): takes jobs off RabbitMQ (lib/jobs.ts)
// until it's told to stop; KEDA runs as many as the queue needs. The image runs it with
// tsx (`node_modules/.bin/tsx src/worker.ts`), so there is no separate build.
import { hostname } from "node:os";
import { prisma } from "@/lib/db";
import { consume, drain } from "@/lib/jobs";

// Warm up before taking jobs: Prisma's first connection and tsx compiling each kind's
// modules on first import made a fresh pod's first job wait ~11 s in "queued" and run
// ~17 s longer (seen on the first deploy). A failed warm-up just leaves that to the job.
void Promise.all([prisma.$connect(), import("@/lib/plaid"), import("@/lib/analysis/analyze"), import("@/lib/analysis/match")])
  .catch((e) => console.error("warm-up:", e))
  .then(() => consume(Number(process.env.SLOTS || 1)));
// A deploy or KEDA scaling in: finish the job in hand first (the pod's grace covers a sync).
process.on("SIGTERM", () => void drain().then(() => process.exit(0)));
console.log(`${hostname()}: taking jobs off "jobs"`);
