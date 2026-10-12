export const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NeuroFabric // 2 AM Incident Console</title>
  <style>
    :root {
      --bg: #090d16;
      --surface: #111827;
      --surface-border: #1f293d;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #3b82f6;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.5;
      padding: 20px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--surface-border);
      margin-bottom: 20px;
    }
    .brand { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
    .badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-live { background: rgba(16, 185, 129, 0.2); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-tripped { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.4); }

    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      padding: 16px;
      border-radius: 8px;
    }
    .kpi-label { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .kpi-val { font-size: 1.75rem; font-weight: 700; margin-top: 4px; font-family: var(--font-mono); }

    .grid-layout {
      display: grid;
      grid-template-columns: 1fr 1.2fr 1fr;
      gap: 20px;
      min-height: 600px;
    }
    @media (max-width: 1200px) { .grid-layout { grid-template-columns: 1fr; } }

    .panel {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel-header {
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--surface-border);
      font-size: 0.875rem;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-body {
      padding: 16px;
      flex: 1;
      overflow-y: auto;
      max-height: 580px;
    }

    .log-entry {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log-meta { display: flex; gap: 8px; font-weight: 600; }
    .severity-CRITICAL { color: var(--danger); }
    .severity-WARN { color: var(--warning); }
    .severity-INFO { color: var(--accent); }

    .diff-box {
      background: #050811;
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 12px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      white-space: pre-wrap;
      color: #cbd5e1;
      max-height: 280px;
      overflow-y: auto;
    }
    .diff-del { color: #f87171; background: rgba(239, 68, 68, 0.1); display: block; }
    .diff-add { color: #4ade80; background: rgba(16, 185, 129, 0.1); display: block; }

    .actions-bar {
      display: flex;
      gap: 12px;
      margin-top: 16px;
    }
    button {
      padding: 10px 16px;
      border-radius: 6px;
      border: none;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.875rem;
      transition: opacity 0.15s ease;
    }
    button:hover { opacity: 0.9; }
    .btn-approve { background: var(--success); color: white; flex: 1; }
    .btn-reject { background: rgba(255,255,255,0.1); color: var(--text-muted); }
    .btn-reset { background: var(--danger); color: white; width: 100%; margin-top: 12px; }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <span>NEUROFABRIC</span>
      <span style="color: var(--text-muted);">//</span>
      <span>Autonomous SRE Control Plane</span>
      <span class="badge badge-live" id="stream-status">● SSE SYNCED</span>
    </div>
    <div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-muted);" id="clock">--:--:-- UTC</div>
  </header>

  <div class="kpis">
    <div class="kpi-card">
      <div class="kpi-label">Edge Ingestion</div>
      <div class="kpi-val" id="metric-throughput">1,420 <span style="font-size: 0.875rem; color: var(--text-muted);">eps</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Deduplicated Alerts</div>
      <div class="kpi-val" id="metric-suppressed" style="color: var(--accent);">0</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Secrets Scrubbed (DLP)</div>
      <div class="kpi-val" id="metric-scrubbed" style="color: var(--warning);">0</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Circuit Breakers</div>
      <div class="kpi-val" id="metric-circuits" style="color: var(--success);">NORMAL</div>
    </div>
  </div>

  <div class="grid-layout">
    <!-- Panel 1: Live Telemetry Stream -->
    <div class="panel">
      <div class="panel-header">
        <span>Live Telemetry & DLP Scrub Stream</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">Real-time</span>
      </div>
      <div class="panel-body" id="telemetry-list">
        <div class="log-entry" style="color: var(--text-muted);">Listening for edge events...</div>
      </div>
    </div>

    <!-- Panel 2: HITL Triage & AST Diff Gate -->
    <div class="panel">
      <div class="panel-header">
        <span>Active Proposal // AST Diff Verification</span>
        <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: var(--accent);" id="task-id-badge">IDLE</span>
      </div>
      <div class="panel-body">
        <div style="font-size: 0.85rem; margin-bottom: 12px;" id="proposal-meta">
          <strong>Target:</strong> <span id="prop-target">None</span><br>
          <strong>RCA Confidence:</strong> <span id="prop-confidence">--%</span> | <strong>Blast Radius:</strong> <span id="prop-blast">--</span>
        </div>
        <div class="diff-box" id="diff-content">No active remediation proposal under evaluation.</div>
        <div class="actions-bar" id="proposal-actions" style="display: none;">
          <button class="btn-approve" onclick="approveRemediation()">Authorize GitOps PR</button>
          <button class="btn-reject" onclick="rejectRemediation()">Decline</button>
        </div>
      </div>
    </div>

    <!-- Panel 3: Sovereign Controls & Circuit Overrides -->
    <div class="panel">
      <div class="panel-header">
        <span>Sovereign Circuit Locks</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">ADR-005 Enforced</span>
      </div>
      <div class="panel-body">
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px;">
          Services locked by the anti-flapping circuit breaker require verified operator overrides to resume mutations.
        </div>
        <div id="circuit-list">
          <div style="font-size: 0.8rem; color: var(--text-muted);">All systems nominal. 0 flapping services.</div>
        </div>
        <button class="btn-reset" onclick="resetCircuitBreaker()">Emergency Unlock: order-processing-node</button>
      </div>
    </div>
  </div>

  <script>
    // Live Clock
    setInterval(() => {
      document.getElementById('clock').innerText = new Date().toUTCString().split(' ')[4] + ' UTC';
    }, 1000);

    // Sync Telemetry and Metrics against Gateway
    async function syncState() {
      try {
        const [logsRes, metricsRes] = await Promise.all([
          fetch('http://127.0.0.1:8080/api/v1/workspace/recent-logs').then(r => r.json()).catch(() => []),
          fetch('http://127.0.0.1:8080/api/v1/metrics/ingestion').then(r => r.json()).catch(() => null)
        ]);

        if (metricsRes) {
          document.getElementById('metric-suppressed').innerText = metricsRes.suppressedAlerts || 0;
          document.getElementById('metric-scrubbed').innerText = metricsRes.secretsScrubbed || 0;
        }

        if (Array.isArray(logsRes) && logsRes.length > 0) {
          const container = document.getElementById('telemetry-list');
          container.innerHTML = logsRes.slice(0, 15).map(l => \`
            <div class="log-entry">
              <div class="log-meta">
                <span class="severity-\${l.severity}">[\${l.severity}]</span>
                <span>\${l.service}</span>
                \${l.dlpScrubbed ? '<span style="color: var(--warning); font-size: 0.7rem;">[DLP REDACTED]</span>' : ''}
              </div>
              <div style="color: var(--text-muted);">\${l.message}</div>
            </div>
          \`).join('');
        }
      } catch (e) {}
    }

    // Connect to Wedge SSE Stream for real-time IPC events
    const sse = new EventSource('/api/memory/alerts');
    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'circuit.strike') {
          document.getElementById('metric-circuits').innerText = data.data.tripped ? 'TRIPPED' : 'WARNING';
          document.getElementById('metric-circuits').style.color = 'var(--danger)';
          document.getElementById('circuit-list').innerHTML = \`
            <div style="padding: 10px; background: rgba(239,68,68,0.1); border-radius: 6px; border: 1px solid var(--danger);">
              <strong>\${data.data.service}</strong>: \${data.data.strikes} strikes recorded. Tripped: \${data.data.tripped}
            </div>
          \`;
        }
      } catch (e) {}
      syncState();
    };

    // Simulated Active HITL Task for initial view
    let activeTaskToken = 'task-2am-' + Math.random().toString(36).substring(7);
    function loadSampleProposal() {
      document.getElementById('task-id-badge').innerText = activeTaskToken;
      document.getElementById('prop-target').innerText = 'pool-allocator.yaml';
      document.getElementById('prop-confidence').innerText = '94%';
      document.getElementById('prop-blast').innerText = 'Low (1 node)';
      document.getElementById('diff-content').innerHTML =
        '<span class="diff-del">- max_connections: 50</span>' +
        '<span class="diff-add">+ max_connections: 120</span>' +
        '  connection_timeout_ms: 15000';
      document.getElementById('proposal-actions').style.display = 'flex';
    }
    loadSampleProposal();

    async function approveRemediation() {
      const res = await fetch('http://127.0.0.1:8080/api/v1/embassy/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: activeTaskToken,
          target: 'pool-allocator.yaml',
          diff: 'max_connections: 120'
        })
      });
      const data = await res.json();
      alert('Approved! GitOps PR Created: ' + data.gitops.branch);
      document.getElementById('proposal-actions').style.display = 'none';
      document.getElementById('diff-content').innerText = 'Remediation dispatched and under canary verification.';
    }

    function rejectRemediation() {
      document.getElementById('proposal-actions').style.display = 'none';
      document.getElementById('diff-content').innerText = 'Proposal rejected by Incident Commander.';
    }

    async function resetCircuitBreaker() {
      await fetch('http://127.0.0.1:8080/api/v1/embassy/reset-breaker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'order-processing-node' })
      });
      alert('Circuit reset for order-processing-node.');
      document.getElementById('metric-circuits').innerText = 'NORMAL';
      document.getElementById('metric-circuits').style.color = 'var(--success)';
      document.getElementById('circuit-list').innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted);">All systems nominal. 0 flapping services.</div>';
    }

    setInterval(syncState, 2000);
    syncState();
  </script>
</body>
</html>`;
