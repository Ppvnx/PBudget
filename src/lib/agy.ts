// Gemini through Google's own Antigravity CLI (`agy`) on the owner's Google AI subscription
// (Vault secret/ai/agy, shared with TLDRadar and the voice agent) — the fleet's way to call
// Gemini (TLDRadar providers/agy.ts). Print mode's stdin takes text only, so an image goes
// through `agy acp` (Agent Client Protocol, JSON-RPC over stdio), which takes image blocks.
//
// The screenshot is untrusted (any user, any picture) and this filesystem holds the pod's
// secrets, so agy is shut in, verified against agy 1.5.14 with prompts telling it to read
// /etc/hosts and the agent file, list files and run a shell command:
//  - a custom agent with no default components: no shell tool, ~3k fewer prompt tokens;
//  - every tool permission agy asks for is refused here (reading anything outside the
//    workspace asks; writing and commands ask) — fail closed, whatever the tool;
//  - the workspace holds nothing but the agent file, and agy gets none of this process's
//    environment (PATH and HOME only).
// Web search cannot be turned off; with files closed it can only see the screenshot itself,
// whose owner is the one who sees the answer.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENT = `---
name: reader
description: Reads the attached image and answers as text, from the prompt alone.
mainAgent: true
includeDefaultComponents: false
---

# System

You answer the prompt directly, in exactly the format it asks for. You have no tools.
`;

/** agy's home (its login, conversations) and the workspace holding the agent, made once. */
let prepared: { home: string; state: string; workspace: string } | null = null;
function prepare() {
  if (prepared) return prepared;
  const home = process.env.AGY_HOME ?? "/tmp/agy";
  const state = join(home, ".gemini/antigravity-cli");
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, ".agents/agents/reader"), { recursive: true });
  writeFileSync(join(workspace, ".agents/agents/reader/agent.md"), AGENT);
  mkdirSync(state, { recursive: true });
  // The login is one file rendered from Vault; agy refreshes it in place, so the rendered
  // copy only seeds it.
  const token = join(state, "antigravity-oauth-token");
  if (!existsSync(token) && process.env.AGY_TOKEN_FILE !== "") {
    copyFileSync(process.env.AGY_TOKEN_FILE ?? "/vault/secrets/agy", token);
  }
  return (prepared = { home, state, workspace });
}

export interface AgyImageAnswer {
  text: string;
  model: string;
  usage: { input: number; output: number; total: number };
}

/** One prompt + one image → the model's text. Gemini only (owner, 2026-11-22: agy's
 * Claude/GPT models share one small quota every agy user here drains). */
export function agyReadImage(o: { prompt: string; image: string; mime: string; model?: string; timeoutMs?: number }): Promise<AgyImageAnswer> {
  const model = o.model ?? process.env.AGY_MODEL ?? "gemini-3.8-flash-low";
  if (!/^gemini/i.test(model)) return Promise.reject(new Error(`agy: refused model ${model}: only Gemini runs through agy`));
  const { home, state, workspace } = prepare();
  const timeoutMs = o.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    const child = spawn("agy", ["acp", "--agent", "reader", "--log-file", "/dev/null", "--disable-telemetry"], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home } as unknown as NodeJS.ProcessEnv, // only these two (the type wants NODE_ENV)
    });
    let buf = "";
    let err = "";
    let text = "";
    let sessionId = "";
    let nextId = 0;
    let settled = false;
    const pending = new Map<number, (m: any) => void>();
    const write = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    const call = (method: string, params: object) =>
      new Promise<any>((res, rej) => {
        const id = ++nextId;
        pending.set(id, (m) => (m.error ? rej(new Error(`agy ${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : res(m.result)));
        write({ id, method, params });
      });
    const finish = (e: Error | null, v?: AgyImageAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      // agy keeps every conversation (~400 KB each); these are one-shot.
      if (sessionId) {
        rmSync(join(state, "conversations", `${sessionId}.db`), { force: true });
        rmSync(join(state, "brain", sessionId), { recursive: true, force: true });
      }
      if (e) reject(e);
      else resolve(v!);
    };
    const timer = setTimeout(() => finish(new Error(`agy: no answer within ${timeoutMs} ms`)), timeoutMs);

    child.stdout.on("data", (d) => {
      buf += d;
      for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id != null && !m.method) {
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        } else if (m.method === "session/request_permission") {
          // Refuse every tool, whatever it is.
          const opts: Array<{ optionId: string; kind?: string }> = m.params?.options ?? [];
          const no = opts.find((x) => x.kind?.startsWith("reject"));
          write({ id: m.id, result: { outcome: no ? { outcome: "selected", optionId: no.optionId } : { outcome: "cancelled" } } });
        } else if (m.method === "session/update") {
          const u = m.params?.update;
          if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") text += u.content.text;
        } else if (m.method && m.id != null) {
          write({ id: m.id, error: { code: -32601, message: "not offered" } }); // e.g. fs/*: we offer none
        }
      }
    });
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", (e) => finish(new Error(`agy did not start: ${e.message}`)));
    child.on("close", (code) => finish(new Error(`agy exited ${code}: ${err.trim().slice(-500)}`)));
    child.stdin.on("error", () => {}); // a child that died early: `close` says why

    (async () => {
      await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      sessionId = (await call("session/new", { cwd: workspace, mcpServers: [] })).sessionId;
      await call("session/set_model", { sessionId, modelId: model });
      const r = await call("session/prompt", {
        sessionId,
        prompt: [
          { type: "text", text: o.prompt },
          { type: "image", mimeType: o.mime, data: o.image },
        ],
      });
      if (r?.stopReason !== "end_turn") throw new Error(`agy stopped: ${r?.stopReason ?? "?"}`);
      const u = r.usage ?? {};
      const input = (u.inputTokens ?? 0) + (u.cachedReadTokens ?? 0);
      const output = (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0);
      finish(null, { text, model, usage: { input, output, total: u.totalTokens ?? input + output } });
    })().catch((e) => finish(e));
  });
}
