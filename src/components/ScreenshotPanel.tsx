"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { jobsChanged } from "./JobsPanel";
import { useT } from "@/lib/i18n/context";

// One account's screenshots (lib/screenshots.ts): add them, see what Gemini read from
// each, fix a row, read one again, or delete it. The account's screenshot transactions
// are recomputed from these after every change, so nothing here can duplicate them.

type Row = { date: string; description: string; amount: number; pending: boolean };
type Shot = { id: string; status: "reading" | "read" | "failed"; rows: Row[]; error: string | null; createdAt: string; hasImage: boolean };
// The editor keeps the amount as typed and the direction apart; amount sign = Plaid's (+ out).
type Draft = { date: string; description: string; amount: string; out: boolean; pending: boolean };

// A phone screenshot is shrunk to fit the 2000 px Gemini sees (and the upload limit); a
// long scrolling one is cut into overlapping slices instead, each its own screenshot —
// the overlap is fine, a row in two slices still counts once.
async function slices(file: File): Promise<Blob[]> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return [file]; // not decodable here: the server says what it is
  const scale = Math.min(1, 1000 / bmp.width, bmp.height <= bmp.width * 2.2 ? 2000 / bmp.height : 1);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const out: Blob[] = [];
  for (let top = 0; ; top += 1700) {
    const ch = Math.min(2000, h - top);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = ch;
    c.getContext("2d")!.drawImage(bmp, 0, top / scale, bmp.width, ch / scale, 0, 0, w, ch);
    let blob: Blob | null = null;
    for (const q of [0.9, 0.8, 0.7]) {
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));
      if (blob && blob.size < 900_000) break; // under the proxy's 1 MB body limit
    }
    if (blob) out.push(blob);
    if (top + ch >= h) return out;
  }
}

export default function ScreenshotPanel({ accountId, currency }: { accountId: string; currency: string | null }) {
  const t = useT();
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [consent, setConsent] = useState(true);
  const [asking, setAsking] = useState<File[] | null>(null); // files waiting on the consent answer
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{ id: string; rows: Draft[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/accounts/screenshots?account_id=${encodeURIComponent(accountId)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error || t("accounts.browser.loadFailed"));
    setShots(d.screenshots);
    setConsent(d.consent);
  }, [accountId, t]);

  useEffect(() => {
    load();
  }, [load]);
  // While Gemini reads, look again every few seconds.
  const reading = shots?.some((s) => s.status === "reading");
  useEffect(() => {
    if (!reading) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [reading, load]);

  const call = async (url: string, init: RequestInit) => {
    const res = await fetch(url, init);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  };

  // `allowed`: the consent answer just given (the `consent` state isn't updated yet).
  const upload = async (files: File[], allowed = consent) => {
    if (!allowed) return setAsking(files);
    setError("");
    setNote("");
    let dup = 0;
    try {
      const blobs = (await Promise.all(files.map(slices))).flat();
      for (const [i, b] of blobs.entries()) {
        setBusy(t("shots.uploading", { done: i + 1, total: blobs.length }));
        const form = new FormData();
        form.set("account_id", accountId);
        form.set("file", b, "screenshot.jpg");
        const d = await call("/api/accounts/screenshots", { method: "POST", body: form });
        if (d.duplicate) dup++;
      }
      if (dup) setNote(t("shots.duplicate", { n: dup }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
      jobsChanged();
      load();
    }
  };

  const allow = async () => {
    const files = asking ?? [];
    setAsking(null);
    try {
      await call("/api/settings/ai-consent", { method: "POST" });
      setConsent(true);
      if (files.length) await upload(files, true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      jobsChanged();
      load();
    }
  };
  const remove = (id: string) => {
    if (confirm(t("shots.deleteConfirm"))) act(() => call(`/api/accounts/screenshots/${id}`, { method: "DELETE" }));
  };
  const reread = (id: string) => {
    if (confirm(t("shots.rereadConfirm"))) act(() => call(`/api/accounts/screenshots/${id}`, { method: "PATCH", body: JSON.stringify({ reread: true }), headers: { "content-type": "application/json" } }));
  };
  const edit = (s: Shot) =>
    setEditing({
      id: s.id,
      rows: s.rows.map((r) => ({ date: r.date, description: r.description, amount: Math.abs(r.amount).toFixed(2), out: r.amount > 0, pending: r.pending })),
    });
  const save = () => {
    if (!editing) return;
    const rows = editing.rows.map((r) => ({ date: r.date, description: r.description, amount: (r.out ? 1 : -1) * Number(r.amount), pending: r.pending }));
    act(async () => {
      await call(`/api/accounts/screenshots/${editing.id}`, { method: "PATCH", body: JSON.stringify({ rows }), headers: { "content-type": "application/json" } });
      setEditing(null);
    });
  };
  const setRow = (i: number, patch: Partial<Draft>) =>
    setEditing((e) => e && { ...e, rows: e.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const money = (amount: number) => `${amount > 0 ? "−" : "+"}${currency ? currency + " " : ""}${Math.abs(amount).toFixed(2)}`;

  return (
    <div style={{ padding: "8px 0" }}>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{t("shots.help")}</p>

      {asking && (
        <div className="banner">
          <strong>{t("shots.consentTitle")}</strong>
          <p style={{ margin: "6px 0" }}>{t("shots.consentBody")}</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-primary" onClick={allow}>{t("shots.consentAllow")}</button>
            <button className="btn btn-sm" onClick={() => setAsking(null)}>{t("shots.consentCancel")}</button>
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 8 }}>
        <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => input.current?.click()}>
          {t("shots.add")}
        </button>
        {busy && <span className="muted" style={{ fontSize: 12 }}>{busy}</span>}
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) upload(files);
          }}
        />
      </div>
      {error && <div className="error">{error}</div>}
      {note && <div className="banner">{note}</div>}
      {shots?.length === 0 && <p className="muted">{t("shots.empty")}</p>}

      {shots?.map((s) => (
        <div key={s.id} className="row wrap" style={{ gap: 12, alignItems: "flex-start", borderTop: "1px solid var(--border)", padding: "10px 0" }}>
          {s.hasImage ? (
            <a href={`/api/accounts/screenshots/${s.id}`} target="_blank" rel="noreferrer">
              <img src={`/api/accounts/screenshots/${s.id}`} alt="" style={{ width: 72, maxHeight: 140, objectFit: "cover", objectPosition: "top", borderRadius: 6, border: "1px solid var(--border)" }} />
            </a>
          ) : (
            <div className="muted" style={{ width: 72, fontSize: 11 }}>{t("shots.imageGone")}</div>
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12 }} className="muted">{new Date(s.createdAt).toLocaleString()}</div>
            {s.status === "reading" && <div>{t("shots.reading")}</div>}
            {s.status === "failed" && <div style={{ color: "var(--danger)" }}>{t("shots.failed", { error: s.error ?? "" })}</div>}
            {s.status === "read" && editing?.id !== s.id && (
              <>
                <div>{t("shots.read", { n: s.rows.filter((r) => !r.pending).length })}</div>
                <table style={{ fontSize: 12, marginTop: 4 }}>
                  <tbody>
                    {s.rows.map((r, i) => (
                      <tr key={i} style={r.pending ? { opacity: 0.5 } : undefined}>
                        <td style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                        <td>{r.description}{r.pending ? ` · ${t("shots.pending")}` : ""}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {editing?.id === s.id && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("shots.colDate")}</th>
                      <th>{t("shots.colDescription")}</th>
                      <th>{t("shots.colAmount")}</th>
                      <th></th>
                      <th>{t("shots.pending")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {editing.rows.map((r, i) => (
                      <tr key={i}>
                        <td><input type="date" value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} /></td>
                        <td><input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                        <td><input inputMode="decimal" style={{ width: 90 }} value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} /></td>
                        <td>
                          <select value={r.out ? "out" : "in"} onChange={(e) => setRow(i, { out: e.target.value === "out" })}>
                            <option value="out">{t("shots.out")}</option>
                            <option value="in">{t("shots.in")}</option>
                          </select>
                        </td>
                        <td><input type="checkbox" checked={r.pending} onChange={(e) => setRow(i, { pending: e.target.checked })} /></td>
                        <td>
                          <button className="btn btn-sm btn-ghost" aria-label={t("shots.removeRow")} onClick={() => setEditing((e) => e && { ...e, rows: e.rows.filter((_, j) => j !== i) })}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setEditing((e) => e && { ...e, rows: [...e.rows, { date: e.rows.at(-1)?.date ?? new Date().toISOString().slice(0, 10), description: "", amount: "", out: true, pending: false }] })
                    }
                  >
                    {t("shots.addRow")}
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={save}>{t("shots.save")}</button>
                  <button className="btn btn-sm" onClick={() => setEditing(null)}>{t("shots.cancel")}</button>
                </div>
              </div>
            )}
          </div>
          {editing?.id !== s.id && (
            <div className="row wrap" style={{ gap: 6 }}>
              {s.status !== "reading" && <button className="btn btn-sm" onClick={() => edit(s)}>{t("shots.edit")}</button>}
              {s.status !== "reading" && s.hasImage && <button className="btn btn-sm" onClick={() => reread(s.id)}>{t("shots.reread")}</button>}
              <button className="btn btn-sm btn-ghost" style={{ color: "var(--danger)" }} onClick={() => remove(s.id)}>{t("shots.delete")}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
