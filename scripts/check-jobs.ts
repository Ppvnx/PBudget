// Gate for the background-job core (lib/jobs.ts), no broker: without AMQP_URL enqueue()
// runs each job in this process. Asserts a job runs to done with its result; a failure
// lands on the row and in the panel's list (until dismissed); an ended job delivered
// again isn't rerun; enqueue joins a waiting job; an analyze waits while the user's lock
// is held and takes over a stale one; a long-lost job reads as failed. Seeds a throwaway
// user in the dev SQLite DB.
// Run: npm run check:jobs
import assert from "assert";
import { prisma } from "../src/lib/db";
import { enqueue, run, userJobs, dismissJob, waitJob, progress } from "../src/lib/jobs";

const U = "jobs-test-user";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = async (id: string) => (await prisma.job.findUnique({ where: { id } }))?.state;

async function main(): Promise<void> {
  await prisma.jobLock.deleteMany({ where: { userId: U } });
  await prisma.user.deleteMany({ where: { id: U } });
  await prisma.user.create({ data: { id: U, email: `${U}@t.local`, passwordHash: "x" } });

  progress("fetch", 1, 2); // outside a job: a no-op, never a throw

  // A job runs to its end; its result lands on the row, its user lock is released.
  const a = await enqueue(U, "analyze");
  const ra = await waitJob(a.id, 30_000);
  assert.equal(ra?.state, "done", `analyze ends done (${JSON.stringify(ra)})`);
  assert.deepEqual(ra?.result, { pendingGroups: 0, openFlags: 0 }, "analyze answers with Review's counts");
  assert.equal(await prisma.jobLock.count({ where: { userId: U } }), 0, "the user lock is released");

  // A sync whose item is gone is skipped, not failed.
  const s = await enqueue(U, "sync", { key: "gone", label: "Bank", args: { itemId: "gone" } });
  assert.deepEqual((await waitJob(s.id, 10_000))?.result, { skipped: true }, "a sync for a removed item is skipped");

  // A failure is recorded and listed until it's dismissed.
  const bad = await prisma.job.create({ data: { userId: U, kind: "no-such-kind" } });
  await run(bad.id);
  const fb = await prisma.job.findUnique({ where: { id: bad.id } });
  assert.equal(fb?.state, "failed", "an unknown kind fails");
  assert.ok(JSON.parse(fb!.error!).error, "its error is on the row");
  assert.ok((await userJobs(U)).some((j) => j.id === bad.id), "the panel lists the failure");
  await dismissJob(U, bad.id);
  assert.ok(!(await userJobs(U)).some((j) => j.id === bad.id), "a dismissed failure leaves the panel");

  // An ended job delivered again isn't run again.
  await run(bad.id);
  assert.equal(await state(bad.id), "failed", "a redelivered ended job is skipped");

  // enqueue joins a waiting job of the same kind + key.
  const waiting = await prisma.job.create({ data: { userId: U, kind: "rematch" } });
  assert.equal((await enqueue(U, "rematch")).id, waiting.id, "a waiting rematch is joined");
  await run(waiting.id);
  assert.equal(await state(waiting.id), "done", "the joined rematch runs");

  // An analyze waits while another holds the user's lock, then runs.
  await prisma.jobLock.create({ data: { userId: U } });
  const w = await prisma.job.create({ data: { userId: U, kind: "analyze" } });
  const ran = run(w.id);
  await sleep(2500);
  const mid = await prisma.job.findUnique({ where: { id: w.id } });
  assert.equal(mid?.state, "running", "it is taken");
  assert.equal(mid?.stage, "waiting", "it waits while the user's lock is held");
  await prisma.jobLock.deleteMany({ where: { userId: U } });
  await ran;
  assert.equal(await state(w.id), "done", "it runs once the lock is free");

  // A lock a dead worker left is taken over once stale.
  await prisma.jobLock.create({ data: { userId: U, at: new Date(Date.now() - 16 * 60_000) } });
  const st = await prisma.job.create({ data: { userId: U, kind: "rematch" } });
  await run(st.id);
  assert.equal(await state(st.id), "done", "a stale lock is taken over");

  // A job still queued long after it was asked for is lost: the panel shows it failed.
  const lost = await prisma.job.create({ data: { userId: U, kind: "sync", createdAt: new Date(Date.now() - 31 * 60_000) } });
  assert.equal((await userJobs(U)).find((j) => j.id === lost.id)?.state, "failed", "a lost job reads as failed");

  await prisma.user.deleteMany({ where: { id: U } }); // jobs cascade
  console.log("\n  ✓ jobs: run, skip, failure + dismiss, redelivery, join, user lock + stale takeover, lost all pass\n");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.jobLock.deleteMany({ where: { userId: U } }).catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
