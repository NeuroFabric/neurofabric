
document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("alerts-container");
  const list = document.getElementById("alerts-list");
  const pausePill = document.getElementById("pause-pill");
  const unreadCount = document.getElementById("unread-count");
  const searchInput = document.getElementById("search-input");
  const toggles = document.querySelectorAll(".severity-toggle");
  
  let isPaused = false;
  let missedEvents = 0;
  let activeSeverities = new Set(["INFO", "WARNING", "CRITICAL"]);
  let searchQuery = "";
  const MAX_DOM_NODES = 200;

  // Filter UI
  toggles.forEach(t => {
    t.addEventListener("click", () => {
      t.classList.toggle("active");
      const sev = t.dataset.sev;
      if (t.classList.contains("active")) activeSeverities.add(sev);
      else activeSeverities.delete(sev);
      applyFilters();
    });
  });

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase();
    applyFilters();
  });

  function applyFilters() {
    Array.from(list.children).forEach(row => {
      const sev = row.dataset.sev;
      const text = row.dataset.text;
      const matchesSev = activeSeverities.has(sev);
      const matchesSearch = text.includes(searchQuery);
      row.style.display = (matchesSev && matchesSearch) ? "flex" : "none";
    });
  }

  // Scroll detection for auto-pause
  container.addEventListener("scroll", () => {
    if (container.scrollTop > 50) {
      isPaused = true;
    } else if (container.scrollTop === 0) {
      isPaused = false;
      missedEvents = 0;
      pausePill.classList.remove("visible");
    }
  });

  pausePill.addEventListener("click", () => {
    container.scrollTop = 0; // Triggers scroll event to unpause
  });

  function highlightJSON(json) {
    if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
    return json.replace(/("(\u[a-zA-Z0-9]{4}|\[^u]|[^\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) cls = 'json-key';
        else cls = 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-string';
      } else if (/null/.test(match)) {
        cls = 'json-key';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    });
  }

  function formatMessageWithDLP(msg) {
    if (!msg) return "";
    return msg.replace(/(\[DLP:[^\]]+\])/g, '<span class="dlp-chip">$1</span>');
  }

  // Listen to Global SSE Bridge
  window.addEventListener("neurofabric:event", (e) => {
    const evt = e.detail;
    if (!evt || !evt.severity) return;

    if (isPaused) {
      missedEvents++;
      unreadCount.textContent = missedEvents;
      pausePill.classList.add("visible");
    }

    const row = document.createElement("div");
    row.className = "alert-row";
    row.dataset.sev = evt.severity;
    row.dataset.text = (evt.service + " " + evt.message).toLowerCase();
    
    const timeStr = new Date().toLocaleTimeString("en-US", {hour12: false});
    const sevClass = evt.severity.toLowerCase();

    row.innerHTML = `
      <div class="alert-summary">
        <div class="alert-time">${timeStr}</div>
        <div class="alert-sev-chip ${sevClass}">${evt.severity}</div>
        <div class="alert-service">${evt.service || 'system'}</div>
        <div class="alert-message">${formatMessageWithDLP(evt.message)}</div>
      </div>
      <div class="alert-details">
        <div style="font-size:11px; color:var(--fg-1); margin-top:8px;">RAW PAYLOAD</div>
        <div class="json-viewer">${highlightJSON(evt)}</div>
      </div>
    `;

    row.addEventListener("click", () => row.classList.toggle("expanded"));

    // Respect filters immediately on arrival
    if (!activeSeverities.has(evt.severity) || !row.dataset.text.includes(searchQuery)) {
      row.style.display = "none";
    }

    // Prepend to list (always kept at top)
    list.prepend(row);

    // DOM Capping
    if (list.children.length > MAX_DOM_NODES) {
      list.lastChild.remove();
    }
  });
});
