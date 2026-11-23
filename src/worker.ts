// A pbudget-worker pod (Setups config/k8s/pbudget): takes jobs off RabbitMQ (lib/jobs.ts)
// until it's told to stop; KEDA runs as many as the queue needs. The image runs it with
// tsx (`node_modules/.bin/tsx src/worker.ts`), so there is no separate build.
import { hostname } from "node:os";
import { consume, drain } from "@/lib/jobs";

void consume(Number(process.env.SLOTS || 1));
// A deploy or KEDA scaling in: finish the job in hand first (the pod's grace covers a sync).
process.on("SIGTERM", () => void drain().then(() => process.exit(0)));
console.log(`${hostname()}: taking jobs off "jobs"`);
