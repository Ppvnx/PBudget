"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/context";

type Call = { id: string; tool: string; args: string; error: string | null; at: string };

// The Agent page: the MCP token an AI agent (agent.ppvnx.com) connects with (lib/mcp.ts),
// then its last 7 days of tool calls. The token's plaintext exists only in the POST
// answer, so it's shown once. Times are formatted in the browser (local time zone).
export default function AgentAccess({ createdAt: initial, calls, capped }: { createdAt: string | null; calls: Call[]; capped: boolean }) {
  const t = useT();
  const [createdAt, setCreatedAt] = useState(initial);
  const [token, setToken] = useState("");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);

  const act = async (method: "POST" | "DELETE") => {
    if (createdAt && !window.confirm(t(method === "POST" ? "agent.replaceConfirm" : "agent.revokeConfirm"))) return;
    setError("");
    setCopied(false);
    const res = await fetch("/api/settings/mcp-token", { method });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error ?? t("common.genericError"));
    setToken(d.token ?? "");
    setCreatedAt(d.createdAt ?? null);
  };

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{t("agent.help")}</p>
      <div className="card">
        <div className="card-header">{t("agent.url")}</div>
        <code style={{ wordBreak: "break-all" }}>{origin}/api/mcp</code>
        <p className="muted" style={{ fontSize: 12 }}>{t("agent.auth")}</p>

        {token && (
          <div className="banner">
            <div>{t("agent.copyNow")}</div>
            <code style={{ display: "block", wordBreak: "break-all", margin: "8px 0", userSelect: "all" }}>{token}</code>
            <button
              className="btn btn-sm"
              onClick={() => navigator.clipboard.writeText(token).then(() => setCopied(true), () => {})}
            >
              {copied ? t("agent.copied") : t("agent.copy")}
            </button>
          </div>
        )}

        <p suppressHydrationWarning>{createdAt ? t("agent.created", { date: new Date(createdAt).toLocaleString() }) : t("agent.none")}</p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={() => act("POST")}>
            {createdAt ? t("agent.replace") : t("agent.create")}
          </button>
          {createdAt && (
            <button className="btn" style={{ color: "var(--danger)" }} onClick={() => act("DELETE")}>
              {t("agent.revoke")}
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <div className="card-header">{t("agent.historyTitle")}</div>
        <p className="muted" style={{ marginTop: 0 }}>
          {t("agent.historyHelp")}
          {capped && ` ${t("agent.historyCapped", { n: calls.length })}`}
        </p>
        {calls.length === 0 ? (
          <p className="muted">{t("agent.historyEmpty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("agent.colWhen")}</th>
                <th>{t("agent.colTool")}</th>
                <th>{t("agent.colArgs")}</th>
                <th>{t("agent.colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <time dateTime={c.at} suppressHydrationWarning>{new Date(c.at).toLocaleString()}</time>
                  </td>
                  <td><code>{c.tool}</code></td>
                  <td title={c.args}>
                    <code style={{ fontSize: 12, wordBreak: "break-all" }}>
                      {c.args === "{}" ? "" : c.args.length > 160 ? c.args.slice(0, 160) + "…" : c.args}
                    </code>
                  </td>
                  <td style={{ color: c.error ? "var(--danger)" : "var(--success)" }}>{c.error ? `✗ ${c.error}` : "✓"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
