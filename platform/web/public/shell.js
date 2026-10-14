(function() {
  const STORAGE_KEY = 'nf_rail_collapsed';
  const rail = document.getElementById('rail');
  const collapseBtn = document.getElementById('rail-collapse-btn');
  const clockEl = document.getElementById('utc-clock');
  const statusPill = document.getElementById('status-pill');
  const ssePulse = document.getElementById('sse-pulse-dot');
  const sseLabel = document.getElementById('sse-label');
  const palette = document.getElementById('command-palette');
  const cmdInput = document.getElementById('cmd-input');

  // 1. Persisted Rail State
  if (localStorage.getItem(STORAGE_KEY) === 'true' && rail) {
    rail.classList.add('collapsed');
  }
  if (collapseBtn && rail) {
    collapseBtn.addEventListener('click', () => {
      rail.classList.toggle('collapsed');
      localStorage.setItem(STORAGE_KEY, rail.classList.contains('collapsed'));
    });
  }

  // 2. Dual UTC / Local Clock Ticker
  let showUTC = true;
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    clockEl.textContent = showUTC
      ? now.toISOString().slice(11, 19) + ' UTC'
      : now.toLocaleTimeString('en-US', { hour12: false }) + ' LOC';
  }
  if (clockEl) {
    clockEl.addEventListener('click', () => { showUTC = !showUTC; updateClock(); });
    setInterval(updateClock, 1000);
    updateClock();
  }

  // 3. Keyboard Shortcuts ([ for Rail, ⌘K for Command Palette)
  window.addEventListener('keydown', (e) => {
    if (e.key === '[' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
      e.preventDefault();
      collapseBtn?.click();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (palette) {
        palette.classList.toggle('open');
        if (palette.classList.contains('open') && cmdInput) cmdInput.focus();
      }
    }
    if (e.key === 'Escape' && palette) {
      palette.classList.remove('open');
    }
  });

  // 4. Native EventBridge SSE Subscription (<85ms Propagation)
  function initSSE() {
    const es = new EventSource('/events');
    es.onopen = () => {
      if (ssePulse) ssePulse.className = 'pulse-dot pulse';
      if (sseLabel) sseLabel.textContent = 'CONNECTED';
    };
    es.onerror = () => {
      if (ssePulse) ssePulse.className = 'pulse-dot disconnected';
      if (sseLabel) sseLabel.textContent = 'DISCONNECTED';
    };
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        window.dispatchEvent(new CustomEvent('neurofabric:event', { detail: payload }));
        if (payload.severity === 'CRITICAL') {
          if (statusPill) {
            statusPill.className = 'tripped';
            statusPill.textContent = 'CIRCUIT TRIPPED';
          }
          const pinned = document.getElementById('pinned-incident-rail');
          if (pinned) pinned.classList.add('active');
        }
      } catch (err) {}
    };
  }
  initSSE();
})();
