// Langfuse tracing (langfuse.ppvnx.com, project PBudget) for every model call: one
// generation span each, with the prompt, the answer, usage, latency and outcome.
// Off unless LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are all set (Vault
// secret/langfuse/pbudget). Never throws and never fails a call: a lost span costs a trace.
//
// The fleet's Langfuse (v4, events_only) takes traces ONLY as OTLP/JSON at
// /api/public/otel/v1/traces; its legacy /api/public/ingestion answers 207 while dropping
// every trace (TLDRadar providers/langfuse.ts traced nothing that way). v4 keys trace fields
// per observation, so trace name + user ride the span itself.
import { randomBytes } from "node:crypto";

export interface Generation {
  name: string; // the trace name, e.g. "screenshot.read"
  userId: string;
  model: string;
  input: string;
  output: string;
  usage?: { input: number; output: number; total: number };
  startMs: number;
  endMs: number;
  error?: string;
  metadata?: Record<string, string>;
}

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

export async function observe(g: Generation): Promise<void> {
  const host = process.env.LANGFUSE_HOST?.replace(/\/$/, "");
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!host || !pk || !sk) return;
  const attributes = [
    str("langfuse.observation.type", "generation"),
    str("langfuse.trace.name", g.name),
    str("user.id", g.userId),
    str("langfuse.observation.model.name", g.model),
    str("langfuse.observation.input", g.input),
    str("langfuse.observation.output", g.output),
    ...Object.entries(g.metadata ?? {}).map(([k, v]) => str(`langfuse.observation.metadata.${k}`, v)),
  ];
  if (g.usage) attributes.push(str("langfuse.observation.usage_details", JSON.stringify(g.usage)));
  const span = {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: g.name,
    kind: 1,
    startTimeUnixNano: nanos(g.startMs),
    endTimeUnixNano: nanos(g.endMs),
    attributes,
    status: g.error ? { code: 2, message: g.error.slice(0, 500) } : { code: 1 },
  };
  try {
    const res = await fetch(`${host}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}` },
      body: JSON.stringify({
        resourceSpans: [{ resource: { attributes: [str("service.name", "pbudget")] }, scopeSpans: [{ scope: { name: "pbudget" }, spans: [span] }] }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    // A 200 can still reject spans (OTLP partial success).
    const rejected = res.ok ? Number(JSON.parse(text || "{}")?.partialSuccess?.rejectedSpans ?? 0) : 0;
    if (!res.ok || rejected) console.error(`langfuse: ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    console.error("langfuse:", String(e).slice(0, 200));
  }
}
