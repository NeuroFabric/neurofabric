export function renderShell(activePage: string, pageContent: string): string {
  const navItems = [
    { id: '', label: 'Situation Room', icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' },
    { id: 'alerts', label: 'Live Alerts', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
    { id: 'patches', label: 'Patch Review', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
    { id: 'circuits', label: 'Circuit Breakers', icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
    { id: 'ledger', label: 'Audit Ledger', icon: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>' },
    { id: 'telemetry', label: 'Telemetry Explorer', icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
    { id: 'reports', label: 'Reports', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
    { id: 'topology', label: 'System Topology', icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' }
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NeuroFabric // 2AM Console</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/shell.css">
</head>
<body>
  <a href="#viewport" class="skip-to-content">Skip to content [Tab]</a>
  <div id="app-shell">
    
    <!-- Left Navigation Rail -->
    <aside id="rail" aria-label="Main Navigation">
      <div class="rail-brand">
        <a href="/" class="rail-brand-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>
          <span class="rail-brand-text">NeuroFabric</span>
        </a>
        <button id="rail-collapse-btn" class="rail-collapse-btn" title="Toggle Rail ([)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Pinned Active Incident Section -->
      <a id="pinned-incident-rail" href="/alerts">
        <div class="incident-badge-title">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent-red);"></span>
          <span>ACTIVE INCIDENT</span>
        </div>
      </a>

      <!-- Navigation Items -->
      <nav class="rail-nav">
        ${navItems.map(item => `
          <a href="/${item.id}" class="nav-item ${activePage === item.id ? 'active' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${item.icon}</svg>
            <span>${item.label}</span>
          </a>
        `).join('')}
      </nav>
    </aside>

    <!-- Main Content Pane -->
    <div id="content-pane">
      <header id="topbar">
        <div class="topbar-left">
          <span class="build-hash">rev.170f922</span>
          <div id="status-pill" class="all-clear">ALL CLEAR</div>
        </div>

        <div class="topbar-right">
          <div id="sse-indicator">
            <span id="sse-pulse-dot" class="pulse-dot"></span>
            <span id="sse-label">CONNECTING</span>
          </div>

          <div id="utc-clock" class="clock-chip" title="Click to toggle Local/UTC">--:--:-- UTC</div>

          <div style="display:flex; align-items:center; gap:var(--space-2); color:var(--fg-1);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="mono" style="font-size:11px;">Alex Vance [LEVEL 5]</span>
          </div>

          <button class="k-trigger-btn" onclick="document.getElementById('command-palette').classList.add('open')">
            <span>Quick Find</span>
            <kbd class="kbd-badge">⌘K</kbd>
          </button>
        </div>
      </header>

      <main id="viewport" tabindex="-1">
        ${pageContent}
      </main>
    </div>
  </div>

  <!-- Command Palette Modal Overlay -->
  <div id="command-palette" class="glass-overlay">
    <div class="cmd-box">
      <div style="display:flex; align-items:center; padding-left:var(--space-4);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-2)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="cmd-input" class="cmd-input" type="text" placeholder="Search alerts, patch proposals, or Merkle hashes...">
      </div>
      <div style="padding:var(--space-2); color:var(--fg-2); font-size:11px; font-family:var(--font-mono);">
        <div style="padding:var(--space-2) var(--space-3); cursor:pointer;" onclick="location.href='/'">Jump to: Situation Room</div>
        <div style="padding:var(--space-2) var(--space-3); cursor:pointer;" onclick="location.href='/alerts'">Jump to: Live Alerts</div>
      </div>
    </div>
  </div>

  <script src="/shell.js"></script>
</body>
</html>`;
}
