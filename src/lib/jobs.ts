// Background jobs: everything slow runs off the request — a Plaid sync, a full analyze,
// a full re-match. Each is a Job row (state, stage, progress: what the jobs panel in the
// corner shows) plus a message carrying only its id on RabbitMQ (vhost pbudget, quorum
// queue "jobs"), consumed by the pbudget-worker pods (src/worker.ts) that KEDA scales on
// the queue's depth (Setups config/k8s/pbudget). A message is acked only when its job has
// ended, so a worker that dies mid-job hands it back and another runs it again: every
// kind is idempotent (upserts, the analyzer). Without AMQP_URL (local dev, the check
// scripts) a job runs at once in this process. Same shape as media.ppvnx.com's
// lib/work.ts, without its cancel / lanes / heartbeat machinery.
import { AsyncLocalStorage } from "node:async_hooks";
import amqp from "amqplib";
import { prisma } from "./db";

export type Kind = "sync" | "analyze" | "rematch";
export const ACTIVE = ["queued", "running"];
const QUEUE = "jobs";
const QUEUE_ARGS = { durable: true, arguments: { "x-queue-type": "quorum" } };
// ponytail: no heartbeat. A job still active this long after it was asked for is lost
// (its message never reached the broker, or nothing took it back) and reads as failed.
// A sync is ~3 min; add a beat if a kind ever legitimately runs longer.
const LOST_MS = 30 * 60_000;
const LOCK_STALE_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// Each kind's code is imported lazily: plaid.ts imports this file.
const RUN: Record<Kind, (userId: string, a: any) => Promise<unknown>> = {
  sync: async (userId, a) => (await import("./plaid")).syncJob(userId, a),
  analyze: (userId) =>
    userLock(userId, async () => {
      progress("analyze");
      await (await import("./analysis/analyze")).analyzeUser(userId);
      // What Review's Analysis button used to answer with; the panel shows it.
      const [pendingGroups, openFlags] = await Promise.all([
        prisma.mergeGroup.count({ where: { userId, status: "auto" } }),
        prisma.transactionFlag.count({ where: { userId, status: "open" } }),
      ]);
      return { pendingGroups, openFlags };
    }),
  rematch: (userId) =>
    userLock(userId, async () => {
      progress("rematch");
      await (await import("./analysis/match")).rematchUser(userId);
    }),
};

/** Queue a job and answer at once with its id. Asking again joins the same job while it
 * waits; a sync also while it runs (it is already fetching). A running analyze/rematch
 * is not joined: it may have read the data before the change that asked again.
 * ponytail: check-then-create, so two requests in the same instant can queue twice —
 * harmless, every kind is idempotent. */
export async function enqueue(
  userId: string,
  kind: Kind,
  o: { key?: string; label?: string; args?: object } = {}
): Promise<{ id: string }> {
  const key = o.key ?? "";
  const same = await prisma.job.findFirst({
    where: { userId, kind, key, state: { in: kind === "sync" ? ACTIVE : ["queued"] } },
    select: { id: true },
  });
  if (same) return same;
  const job = await prisma.job.create({
    data: { userId, kind, key, label: o.label ?? "", args: JSON.stringify(o.args ?? {}) },
    select: { id: true },
  });
  if (!process.env.AMQP_URL) {
    void run(job.id).catch((e) => console.error(`job ${job.id}:`, e)); // dev, check scripts: here and now
    return job;
  }
  try {
    const ch = await publisher();
    ch.sendToQueue(QUEUE, Buffer.from(job.id), { persistent: true });
    await ch.waitForConfirms();
  } catch (e: any) {
    // Not thrown: the panel shows the failed job, which says what happened.
    console.error(`job ${job.id}: couldn't queue it:`, e);
    await end(job.id, { state: "failed", error: JSON.stringify({ error: `Couldn't queue it: ${e?.message ?? e}` }) });
  }
  return job;
}

const CTX = new AsyncLocalStorage<{ id: string; stage: string; at: number }>();
let running = 0;

/** Run one job to its end (exported for scripts/check-jobs.ts). A job that already ended
 * (a message delivered again) is skipped; one interrupted mid-run runs again. */
export async function run(id: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job || !ACTIVE.includes(job.state)) return;
  await prisma.job.update({ where: { id }, data: { state: "running", startedAt: new Date(), stage: "", done: 0, total: 0 } });
  running++;
  try {
    const result = await CTX.run({ id, stage: "", at: 0 }, () => RUN[job.kind as Kind](job.userId, JSON.parse(job.args)));
    await end(id, { state: "done", result: JSON.stringify(result ?? null) });
  } catch (e: any) {
    console.error(`job ${id} (${job.kind}) failed:`, e);
    await end(id, { state: "failed", error: JSON.stringify(e?.detail ?? { error: e?.message ?? String(e) }) });
  } finally {
    running--;
  }
}

const end = (id: string, data: { state: string; result?: string; error?: string }) =>
  prisma.job.update({ where: { id }, data: { ...data, endedAt: new Date() } });

/** The running job's stage (jobs.stage.<stage>) and count for its bar; total 0 = no count.
 * No-op outside a job. A count writes at most once a second; a new stage and the last
 * count at once. */
export function progress(stage: string, done = 0, total = 0): void {
  const c = CTX.getStore();
  if (!c) return;
  const now = Date.now();
  if (stage === c.stage && done < total && now - c.at < 1000) return;
  c.stage = stage;
  c.at = now;
  void prisma.job.update({ where: { id: c.id }, data: { stage, done, total } }).catch(() => {});
}

/** One analyze/rematch per user at a time: both rewrite the user's matches, groups and
 * flags, and two at once race on the same rows (two banks' syncs ending together each
 * queue an analyze, and two workers take them). A JobLock row is the lock; one a dead
 * worker left is taken over once LOCK_STALE_MS old. */
async function userLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      await prisma.jobLock.create({ data: { userId } });
      break;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
      const stale = await prisma.jobLock.updateMany({
        where: { userId, at: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
        data: { at: new Date() },
      });
      if (stale.count) break;
      progress("waiting");
      await sleep(2000);
    }
  }
  try {
    return await fn();
  } finally {
    await prisma.jobLock.deleteMany({ where: { userId } }).catch(() => {});
  }
}

/** What the jobs panel shows: the user's jobs still going, a failed one until it's closed
 * (an hour at most), a done one for 30 s (the panel shows its ✓). */
export async function userJobs(userId: string) {
  const now = Date.now();
  await prisma.job.updateMany({
    where: { userId, state: { in: ACTIVE }, createdAt: { lt: new Date(now - LOST_MS) } },
    data: { state: "failed", error: JSON.stringify({ error: "Lost: no worker finished it. Try again." }), endedAt: new Date() },
  });
  const rows = await prisma.job.findMany({
    where: {
      userId,
      OR: [
        { state: { in: ACTIVE } },
        { state: "failed", dismissed: false, endedAt: { gt: new Date(now - 3600_000) } },
        { state: "done", endedAt: { gt: new Date(now - 30_000) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, label: true, state: true, stage: true, done: true, total: true, result: true, error: true },
  });
  return rows.map((r) => ({ ...r, result: parse(r.result), error: parse(r.error) }));
}

export const dismissJob = (userId: string, id: string) =>
  prisma.job.updateMany({ where: { id, userId }, data: { dismissed: true } });

/** Wait up to `ms` for a job to end (the MCP tools answer with its result). */
export async function waitJob(id: string, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const j = await prisma.job.findUnique({ where: { id }, select: { state: true, result: true, error: true } });
    if (!j || !ACTIVE.includes(j.state) || Date.now() > until) {
      return j && { job: id, state: j.state, result: parse(j.result), error: parse(j.error) };
    }
    await sleep(1000);
  }
}

// ---- RabbitMQ ------------------------------------------------------------------------

let ch: Promise<amqp.ConfirmChannel> | null = null;
function publisher() {
  return (ch ??= (async () => {
    const conn = await amqp.connect(process.env.AMQP_URL!);
    const c = await conn.createConfirmChannel();
    const reset = () => (ch = null);
    conn.on("close", reset);
    conn.on("error", reset);
    c.on("close", reset);
    c.on("error", () => {}); // it closes too: the next enqueue opens a new one
    await c.assertQueue(QUEUE, QUEUE_ARGS);
    return c;
  })().catch((e) => {
    ch = null;
    throw e;
  }));
}

let stopping = false;
let cancel: (() => Promise<unknown>) | null = null;

/** A worker pod's loop: take jobs off the queue `slots` at a time, reconnecting whenever
 * the broker goes away. */
export async function consume(slots: number): Promise<void> {
  while (!stopping) {
    try {
      const conn = await amqp.connect(process.env.AMQP_URL!);
      const c = await conn.createChannel();
      const closed = new Promise((r) => {
        for (const x of [conn, c]) {
          x.on("close", r);
          x.on("error", r);
        }
      });
      await c.assertQueue(QUEUE, QUEUE_ARGS);
      await c.prefetch(slots);
      const { consumerTag } = await c.consume(QUEUE, (msg) => {
        if (!msg) return;
        run(msg.content.toString()).then(
          () => {
            try {
              c.ack(msg);
            } catch {} // its channel is gone: the broker hands it back, and run() skips it
          },
          (e) => {
            console.error("job queue:", e); // the database, most likely: hand it back in a while
            setTimeout(() => {
              try {
                c.nack(msg);
              } catch {}
            }, 10_000);
          }
        );
      });
      cancel = () => c.cancel(consumerTag);
      await closed;
      await conn.close().catch(() => {});
    } catch (e) {
      console.error("job queue:", e);
    }
    if (!stopping) await sleep(5000);
  }
}

/** SIGTERM (a deploy, or KEDA scaling in): take nothing more, finish what's running. */
export async function drain(): Promise<void> {
  stopping = true;
  await cancel?.().catch(() => {});
  while (running) await sleep(1000);
}
