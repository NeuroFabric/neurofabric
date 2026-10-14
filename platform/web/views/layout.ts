
export function renderShell(activeId: string, pageContent: string): string {
  const nav = [
    { id: '', label: 'Situation Room', icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' },
    { id: 'alerts', label: 'Live Alerts', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
    { id: 'patches', label: 'Patch Review', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
    { id: 'circuits', label: 'Circuit Breakers', icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
    { id: 'ledger', label: 'Audit Ledger', icon: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>' },
    { id: 'telemetry', label: 'Telemetry Explorer', icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
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
  <div id="app-shell">
    
    <!-- Collapsible Left Rail -->
    <aside id="rail">
      <div class="rail-brand">
        <div style="display:flex; align-items:center; gap:var(--space-2); color:var(--fg-0); font-weight:700;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>
          <span class="rail-text">NeuroFabric</span>
        </div>
        <button id="rail-collapse-btn" style="background:none; border:none; color:var(--fg-2); cursor:pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <nav class="rail-nav">
        ${nav.map(n => `
          <a href="/${n.id}" class="nav-item ${activeId === n.id ? 'active' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${n.icon}</svg>
            <span class="rail-text">${n.label}</span>
          </a>
        `).join('')}
      </nav>
    </aside>

    <!-- Main Content Area -->
    <div id="content-pane">
      <header id="topbar">
        <div class="topbar-left">
          <span class="mono" style="color:var(--fg-2); font-size:11px;">rev.170f922</span>
          <div id="global-status-pill" class="status-pill nominal">
            <span style="width:6px; height:6px; border-radius:50%; background:currentColor"></span> ALL CLEAR
          </div>
        </div>
        <div class="topbar-right">
          <div id="sse-pulse">
            <span id="sse-pulse-dot" class="pulse-dot"></span>
            <span id="sse-label">CONNECTING</span>
          </div>
          <div id="utc-clock" class="mono" style="cursor:pointer; color:var(--fg-1); padding:0 var(--space-2);">--:--:-- UTC</div>
          <div style="display:flex; align-items:center; gap:var(--space-2); color:var(--fg-1);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="mono" style="font-size:11px;">Alex Vance</span>
          </div>
          <kbd class="mono" style="background:var(--bg-2); padding:2px 6px; border-radius:4px; border:1px solid var(--border); font-size:11px; cursor:pointer;" onclick="document.getElementById('command-palette').classList.add('open')">⌘K</kbd>
        </div>
      </header>
      <main id="viewport">${pageContent}</main>
    </div>
  </div>

  <!-- Command Palette Overlay -->
  <div id="command-palette" class="glass-overlay">
    <div class="cmd-box">
      <div style="display:flex; align-items:center; padding-left:var(--space-4);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-2)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="cmd-input" class="cmd-input" type="text" placeholder="Search alerts, patch proposals, or Merkle hashes...">
      </div>
      <div style="padding:var(--space-2); color:var(--fg-2); font-size:11px; font-family:var(--font-mono);">
        <div style="padding:var(--space-2) var(--space-3);">Use ↑↓ to navigate, ↵ to select</div>
      </div>
    </div>
  </div>
  <script src="/shell.js"></script>
</body>
</html>`;
}
