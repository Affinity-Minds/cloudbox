import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type AuditRecord = {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string;
  action: string;
  createdAt: string;
};

type FoundationPayload = {
  version: { gitSha: string; builtAt: string };
  release: { status: string; sha: string } | null;
  audit: AuditRecord[];
};

function shortSha(value?: string) {
  if (!value) return "unknown";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function App() {
  const [data, setData] = useState<FoundationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/v1/foundation", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as FoundationPayload;
      })
      .then(setData)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Unknown loader failure");
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CloudBox</div>
        <div className="topbar-meta">
          <span>Phase 0</span>
          <span className={error ? "health health-bad" : "health"}>
            {error ? "Foundation unavailable" : data ? "Foundation healthy" : "Loading"}
          </span>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="CloudBox sections">
          <div className="nav-group-label">CONTROL PLANE</div>
          <div className="nav-item nav-item-active">Foundation</div>
          <div className="nav-item nav-item-disabled">Tenants</div>
          <div className="nav-item nav-item-disabled">Fleet</div>
          <div className="nav-item nav-item-disabled">Releases</div>
          <div className="nav-item nav-item-disabled">Audit</div>
        </aside>

        <section className="content" aria-labelledby="page-title">
          <div className="page-heading">
            <div>
              <p className="eyebrow">FOUNDATION</p>
              <h1 id="page-title">Control plane status</h1>
            </div>
            <span className="environment">box.affinityminds.in</span>
          </div>

          <section className="status-grid" aria-label="Deployment status">
            <div className="metric">
              <span className="metric-label">Release</span>
              <strong>{data?.release?.status ?? (error ? "Unavailable" : "Loading")}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Build</span>
              <strong className="mono">{shortSha(data?.version.gitSha)}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Audited SHA</span>
              <strong className="mono">{shortSha(data?.release?.sha)}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">API</span>
              <strong>/api/v1</strong>
            </div>
          </div>

          <section className="panel" aria-labelledby="audit-heading">
            <div className="panel-header">
              <div>
                <h2 id="audit-heading">Foundation audit</h2>
                <p>Real append-only records from the CloudBox control-plane database.</p>
              </div>
              <span className="record-count">{data?.audit.length ?? 0} records</span>
            </div>

            {error ? (
              <div className="inline-error">
                Foundation data could not be loaded. Static console and health endpoints remain
                available. <span className="mono">{error}</span>
              </div>
            ) : !data ? (
              <div className="table-placeholder">Loading foundation records…</div>
            ) : data.audit.length === 0 ? (
              <div className="table-placeholder">
                No foundation audit events yet. The deployment verifier will create the first
                audited release record.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.audit.map((record) => (
                      <tr key={record.id}>
                        <td className="mono">{record.eventType}</td>
                        <td>{record.actorId}</td>
                        <td>{record.action}</td>
                        <td className="mono">{record.createdAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
