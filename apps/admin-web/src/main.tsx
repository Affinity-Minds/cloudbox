import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <strong>CloudBox</strong>
          <span className="environment">Foundation build</span>
        </div>
        <span className="status">Control plane bootstrap</span>
      </header>
      <section className="content" aria-labelledby="page-title">
        <p className="eyebrow">OPERATIONS CONSOLE</p>
        <h1 id="page-title">CloudBox control plane is being assembled.</h1>
        <p className="lede">
          This first slice establishes the versioned API, deployment pipeline, repository contract,
          and production origin. Tenant, fleet, licensing, backup, and update workflows arrive as
          closed vertical slices.
        </p>
        <dl className="facts">
          <div>
            <dt>Production</dt>
            <dd>box.affinityminds.in</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd>/api/v1</dd>
          </div>
          <div>
            <dt>Phase</dt>
            <dd>0 · Foundation</dd>
          </div>
        </dl>
      </section>
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
