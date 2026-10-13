
export function renderAlerts(): string {
  return `
  <link rel="stylesheet" href="/alerts.css">
  <div class="alerts-layout">
    
    <!-- Header & Filters -->
    <div>
      <h1 style="font-size: 20px; font-weight: 800; letter-spacing:-0.02em; color:var(--fg-0); margin-bottom: 4px;">Live Alerts</h1>
      <p style="color:var(--fg-1); font-size:13px;">Continuous telemetry stream from the EventBridge. Evaluated prior to AST gating.</p>
    </div>

    <div class="alerts-toolbar">
      <div class="filter-group" style="padding-right: var(--space-4); border-right: 1px solid var(--border);">
        <span class="filter-label">Severity</span>
        <button class="severity-toggle active info" data-sev="INFO">INFO</button>
        <button class="severity-toggle active warning" data-sev="WARNING">WARNING</button>
        <button class="severity-toggle active critical" data-sev="CRITICAL">CRITICAL</button>
      </div>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-2)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="search-input" placeholder="Filter by service or message content...">
      </div>
    </div>

    <!-- Virtualized Stream -->
    <div id="alerts-container" class="alerts-stream-container">
      <div id="pause-pill" class="pause-pill">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        <span><span id="unread-count">0</span> new events</span>
      </div>
      <div id="alerts-list" class="alerts-list">
        <!-- JS populates rows here -->
        <div style="padding:var(--space-6); text-align:center; color:var(--fg-2); font-style:italic;">Waiting for edge telemetry stream...</div>
      </div>
    </div>

  </div>
  <script src="/alerts.js"></script>
  `;
}
