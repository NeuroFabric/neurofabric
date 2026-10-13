
export function renderDashboard(data: any): string {
  return `
  <link rel="stylesheet" href="/dashboard.css">
  <div class="bento-grid">
    
    <!-- ROW 1: Hero & Breakers -->
    <div class="bento-card col-8">
      <div class="card-header">
        <h2 class="card-title">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--accent-green)"></span>
          Situation Room
        </h2>
      </div>
      <div>
        <h1 class="hero-status green">ALL CLEAR</h1>
        <p style="color:var(--fg-1); font-size:15px; max-width:60ch;">
          No active incidents. Edge telemetry is flowing nominally and all circuit breakers are closed. 
          The Merkle ledger is sealing GitOps mutations correctly.
        </p>
      </div>
    </div>
    
    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Circuit Breaker Fleet
        </h2>
      </div>
      <div class="fleet-grid">
        <div class="fleet-box">
          <div class="val mono green">4</div>
          <div class="lbl">Closed</div>
        </div>
        <div class="fleet-box">
          <div class="val mono amber">0</div>
          <div class="lbl">Degraded</div>
        </div>
        <div class="fleet-box">
          <div class="val mono red">0</div>
          <div class="lbl">Tripped</div>
        </div>
      </div>
    </div>

    <!-- ROW 2: Telemetry & Dedup -->
    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Live Event Stream
        </h2>
      </div>
      <div id="live-stream" class="stream-preview">
        <div style="color:var(--fg-2); font-size:12px; font-style:italic; padding:var(--space-2);">
          Listening to EventBridge...
        </div>
      </div>
    </div>

    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">Dedup Suppression (60s)</h2>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div class="stat-value mono" style="color:var(--accent-cyan)">0<span style="font-size:16px; color:var(--fg-2); margin-left:4px;">evt</span></div>
        <div class="stat-label">Duplicate events collapsed at edge</div>
      </div>
    </div>

    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">Ingest Velocity</h2>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div class="stat-value mono">14.2<span style="font-size:16px; color:var(--fg-2); margin-left:4px;">evt/s</span></div>
        <div class="stat-label">Rolling 5-minute average</div>
      </div>
    </div>

    <!-- ROW 3: Ledger & Health -->
    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">Pending Patch Reviews</h2>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div class="stat-value mono">0</div>
        <div class="stat-label">HITL Queue Empty</div>
      </div>
    </div>

    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">Merkle Audit Ledger</h2>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div class="stat-value mono">${data.ledgerSize || 0}</div>
        <div class="stat-label">Cryptographic leaves appended</div>
      </div>
    </div>

    <div class="bento-card col-4">
      <div class="card-header">
        <h2 class="card-title">Process Health</h2>
      </div>
      <ul class="health-list">
        <li class="health-item">
          <div><span class="port">8080</span><span class="svc">Ingress Gateway</span></div>
          <span class="badge up">UP</span>
        </li>
        <li class="health-item">
          <div><span class="port">3000</span><span class="svc">Wedge UI</span></div>
          <span class="badge up">UP</span>
        </li>
        <li class="health-item">
          <div><span class="port">stdio</span><span class="svc">Embassy Agent</span></div>
          <span class="badge up">UP</span>
        </li>
      </ul>
    </div>

  </div>
  `;
}
