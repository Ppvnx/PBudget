"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/context";

// Every background job of the signed-in user (lib/jobs.ts) in the bottom-left corner, on
// every page: what it is, its stage and a bar (a real count when the job has one). Polls
// /api/jobs every 2 s while something shows, every 30 s otherwise; a button that queues a
// job calls jobsChanged() so its card appears at once. When a job this page saw running
// ends, the page's server data refreshes and JOB_DONE fires for client-fetched views.
type Job = {
  id: string;
  kind: string;
  label: string;
  state: string;
  stage: string;
  done: number;
  total: number;
  result: any;
  error: { error?: string; errorType?: string | null; errorCode?: string | null; requestId?: string | null } | null;
};

const POKE = "pbudget:jobs";
export const JOB_DONE = "pbudget:job-done";
export const jobsChanged = () => window.dispatchEvent(new Event(POKE));
const active = (j: Job) => j.state === "queued" || j.state === "running";

export default function JobsPanel() {
  const t = useT();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const seen = useRef(new Set<string>()); // ids this page saw queued/running
  const shownAt = useRef(new Map<string, number>()); // done ids → when their ✓ first showed

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const poll = async () => {
      clearTimeout(timer);
      const list: Job[] | null = await fetch("/api/jobs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.jobs ?? null)
        .catch(() => null);
      if (!alive) return;
      if (list) {
        let ended = false;
        for (const j of list) {
          if (active(j)) seen.current.add(j.id);
          else if (seen.current.delete(j.id)) {
            ended = true;
            window.dispatchEvent(new CustomEvent(JOB_DONE, { detail: j }));
          }
        }
        if (ended) router.refresh();
        const now = Date.now();
        setJobs(
          list.filter((j) => {
            if (j.state !== "done") return true;
            if (!shownAt.current.has(j.id)) shownAt.current.set(j.id, now);
            return now - shownAt.current.get(j.id)! < 5000;
          })
        );
      }
      timer = setTimeout(poll, list?.some((j) => j.state !== "failed") ? 2000 : 30000);
    };
    void poll();
    window.addEventListener(POKE, poll);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener(POKE, poll);
    };
  }, [router]);

  const dismiss = (id: string) => {
    setJobs((js) => js.filter((j) => j.id !== id));
    void fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dismiss: id }) });
  };

  const doneText = (j: Job) => {
    if (j.kind === "sync" && j.result?.transactions != null) return t("accounts.syncDone", { n: j.result.transactions });
    if (j.kind === "analyze" && j.result) return t("review.analyzeDone", { groups: j.result.pendingGroups, flags: j.result.openFlags });
    if (j.kind === "rematch") return t("accounts.rematchDone");
    if (j.kind === "screenshot" && j.result?.rows != null) return t("jobs.screenshotDone", { n: j.result.rows });
    return t("jobs.done");
  };

  if (!jobs.length) return null;
  return (
    <div className="jobs-panel" role="status" aria-live="polite">
      {jobs.map((j) => (
        <div className="job-card" key={j.id}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "nowrap" }}>
            <strong>{t(`jobs.${j.kind}`, { name: j.label || t("jobs.newBank") })}</strong>
            {j.state === "failed" && (
              <button className="btn btn-sm btn-ghost" onClick={() => dismiss(j.id)} aria-label={t("common.close")}>
                ✕
              </button>
            )}
          </div>

          {active(j) && (
            <>
              <div className="muted job-stage">
                {t(j.state === "queued" ? "jobs.stage.queued" : `jobs.stage.${j.stage || "running"}`, { done: j.done, total: j.total })}
              </div>
              {j.total > 0 ? (
                <div className="progress-bar" role="progressbar" aria-valuenow={j.done} aria-valuemax={j.total}>
                  <span style={{ width: `${Math.min(100, (100 * j.done) / j.total)}%` }} />
                </div>
              ) : (
                <div className="progress" role="progressbar" />
              )}
            </>
          )}

          {j.state === "done" && <div className="job-stage">✓ {doneText(j)}</div>}

          {j.state === "failed" && (
            <>
              <div className="job-stage" style={{ color: "var(--danger)" }}>✗ {t("jobs.failed")}</div>
              <div className="job-error">
                {j.error?.errorType && <div><strong>{t("accounts.sync.errorType")}:</strong> {j.error.errorType}</div>}
                {j.error?.errorCode && <div><strong>{t("accounts.sync.errorCode")}:</strong> {j.error.errorCode}</div>}
                <div>{j.error?.error || t("common.genericError")}</div>
                {j.error?.requestId && <div className="muted">{t("accounts.sync.requestId")}: {j.error.requestId}</div>}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
