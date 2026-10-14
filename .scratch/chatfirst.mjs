import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

const start = src.indexOf("var h = React.createElement;");
const end = src.indexOf("ReactDOM.createRoot(document.getElementById(");
if (start < 0 || end < 0) throw new Error("App() bounds not found");

// The chat-first application. One centred column: a transcript that opens with
// what the engine knows about the file, widgets that appear INSIDE answers, and
// a composer pinned to the bottom.
const APP = String.raw`
/**
 * THE SURFACE. A conversation, not a dashboard.
 *
 * The Owner's verdict on the previous release was that the chat was "shoved into
 * a sidebar". That was correct, and it was not a styling complaint. A chat beside
 * a dashboard is a help widget; a chat as the primary surface is an agent. The
 * difference is which thing you are looking at when the page opens, and whether
 * the analysis arrives as an ANSWER or as a wall to navigate.
 *
 * So the layout is one centred reading column. The charts are not gone -- they
 * are inside the answers now, which is the only place a chart belongs in a
 * conversation: nobody asks for a histogram before asking what the file is.
 */
var h = React.createElement;

/* ---------------------------------------------------------------------------
 * CHARTS. Unchanged in substance, relocated in the product: a chart inside a
 * message rather than a section of a page.
 * ------------------------------------------------------------------------- */
function useChart(draw, version) {
  var ref = React.useRef(null);
  React.useEffect(function () {
    if (typeof Chart === "undefined" || ref.current === null) return;
    var chart = new Chart(ref.current.getContext("2d"), draw());
    return function () { chart.destroy(); };
    // One dependency, and the reason is written where it was written before:
    // an empty list means a re-read of the analysis repaints nothing, while a
    // list that changes on every render stacks one chart per render.
  }, [version]);
  return ref;
}

function ChartNote(props) {
  if (typeof Chart !== "undefined") return null;
  return h("div", { className: "chartoff" },
    h("p", { className: "font-semibold" },
      "Charts unavailable — the numbers below are still exact."),
    h("p", { className: "mt-1" },
      "The charting library did not load. Two causes look identical from inside the browser and both were real here: " +
      "the script was blocked by this page's Content-Security-Policy, or the CDN returned an error for that file. " +
      "Open the developer console and look for a CSP violation or a 404 on chart.umd.js."));
}

function BarChart(props) {
  var points = (props.payload && props.payload.points) || [];
  var ref = useChart(function () {
    return {
      type: "bar",
      data: {
        labels: points.map(function (r) { return r.key; }),
        datasets: [{
          label: "Rows",
          data: points.map(function (r) { return r.count; }),
          backgroundColor: "#3b5bdb",
          borderRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var p = points[ctx.dataIndex];
                if (!p) return "";
                return p.count.toLocaleString("en-US") + " rows, " +
                  Math.round((p.count / Math.max(1, D.totalRows)) * 100) + "% of the file";
              }
            }
          }
        },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    };
  }, props.version);
  return h("div", { className: "canvasbox" },
    h("canvas", { ref: ref, "aria-label": "Row count by category", role: "img" }));
}

function LineChart(props) {
  var hours = (props.payload && props.payload.points) || [];
  var ref = useChart(function () {
    return {
      type: "line",
      data: {
        labels: hours.map(function (x) { return x.hour; }),
        datasets: [{
          label: "Rows in the hour",
          data: hours.map(function (x) { return x.count; }),
          borderColor: "#3b5bdb",
          backgroundColor: "rgba(59,91,219,0.12)",
          fill: true,
          tension: 0.25,
          // The point colour carries the ENGINE'S verdict, not a visual guess.
          pointRadius: hours.map(function (x) { return x.spike ? 6 : 3; }),
          pointBackgroundColor: hours.map(function (x) { return x.spike ? "#d9480f" : "#3b5bdb"; })
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              title: function (items) {
                var x = hours[items[0].dataIndex];
                return x ? x.hour.replace("T", " ") + ":00" : "";
              },
              label: function (ctx) {
                var x = hours[ctx.dataIndex];
                if (!x) return "";
                var lines = [x.count.toLocaleString("en-US") + " rows in this hour"];
                if (x.multiple !== null && x.multiple !== undefined) {
                  lines.push(x.multiple.toFixed(1) + "x the mean hour");
                }
                lines.push(x.spike ? ("Flagged as a spike. " + (x.rule || "")) : "Within the usual range");
                return lines;
              }
            }
          }
        },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    };
  }, props.version);
  return h("div", { className: "canvasbox" },
    h("canvas", { ref: ref, "aria-label": "Rows per hour, with spikes flagged", role: "img" }));
}

/* ---------------------------------------------------------------------------
 * WIDGETS. Data in, elements out. The renderer owns every piece of markup,
 * which is what keeps an untrusted column name from ever becoming an element.
 * ------------------------------------------------------------------------- */
function WidgetCard(props) {
  return h("section", { className: "rounded-xl border border-slate-200 bg-white p-4 my-3" },
    h("h3", { className: "text-sm font-semibold" }, esc(props.title)),
    props.note ? h("p", { className: "text-xs text-slate-500 mt-0.5 mb-2" }, esc(props.note)) : null,
    props.children
  );
}

function renderWidget(w, version) {
  if (!w || !w.kind) return null;
  var p = w.payload || {};

  if (w.kind === "chart-bar") {
    return h(WidgetCard, { title: w.title, note: w.note },
      h(ChartNote),
      (p.points || []).length === 0
        ? h("p", { className: "text-sm text-slate-500" }, "Nothing to plot.")
        : h(BarChart, { payload: p, version: version })
    );
  }

  if (w.kind === "chart-line") {
    return h(WidgetCard, { title: w.title, note: w.note },
      h(ChartNote),
      (p.points || []).length === 0
        ? h("p", { className: "text-sm text-slate-500" }, "Nothing to plot.")
        : h(LineChart, { payload: p, version: version })
    );
  }

  if (w.kind === "findings") {
    var list = p.anomalies || [];
    if (list.length === 0) {
      return h(WidgetCard, { title: w.title },
        h("p", { className: "text-sm text-slate-500" }, "Nothing to flag."));
    }
    return h(WidgetCard, { title: w.title, note: w.note },
      h("ul", { className: "divide-y divide-slate-100" }, list.map(function (a, i) {
        return h("li", { key: a.column + a.kind + i, className: "flex items-start gap-3 py-2.5" },
          h("span", { className: "pill " + a.severity }, LABEL[a.severity] || a.severity),
          h("div", { className: "min-w-0" },
            h("div", { className: "text-sm font-medium" }, esc(a.column)),
            h("div", { className: "text-sm text-slate-600" },
              esc(a.kind + ": " + a.detail) + why(a.factor))
          )
        );
      }))
    );
  }

  if (w.kind === "columns") {
    var cols = p.columns || [];
    return h(WidgetCard, { title: w.title, note: w.note },
      h("div", { className: "overflow-x-auto" },
        h("table", { className: "w-full text-sm" },
          h("thead", null, h("tr", { className: "text-left text-xs uppercase tracking-wide text-slate-500" },
            h("th", { className: "py-1.5 pr-3 font-medium" }, "Column"),
            h("th", { className: "py-1.5 pr-3 font-medium" }, "Mean"),
            h("th", { className: "py-1.5 pr-3 font-medium" }, "Min"),
            h("th", { className: "py-1.5 pr-3 font-medium" }, "Max"),
            h("th", { className: "py-1.5 font-medium" }, "Measured")
          )),
          h("tbody", null, cols.map(function (c) {
            return h("tr", { key: c.name, className: "border-t border-slate-100" },
              h("td", { className: "py-1.5 pr-3 font-medium" }, esc(c.name)),
              h("td", { className: "py-1.5 pr-3 tabular-nums" }, num(c.mean)),
              h("td", { className: "py-1.5 pr-3 tabular-nums" }, num(c.min)),
              h("td", { className: "py-1.5 pr-3 tabular-nums" }, num(c.max)),
              h("td", { className: "py-1.5 tabular-nums" }, c.measured.toLocaleString("en-US"))
            );
          }))
        ))
    );
  }

  if (w.kind === "mappings") {
    var learned = p.learned || [];
    return h(WidgetCard, { title: w.title, note: w.note },
      h("ul", { className: "text-sm space-y-1" },
        learned.length === 0
          ? h("li", { className: "text-slate-500" }, "Nothing confirmed yet — every reading is inferred.")
          : learned.map(function (m) {
              return h("li", { key: m[0] },
                h("span", { className: "text-slate-500" }, esc(m[0])),
                h("span", { className: "mx-2 text-slate-300" }, "\\u2192"),
                h("span", { className: "font-medium" }, esc(m[1])));
            })
      )
    );
  }

  if (w.kind === "capabilities") {
    var caps = p.capabilities || [];
    return h(WidgetCard, { title: w.title },
      h("ul", { className: "text-sm space-y-1" },
        caps.map(function (c) { return h("li", { key: c.ask }, esc(c.label)); }))
    );
  }

  // An unknown kind renders as nothing rather than as a guess. A widget the
  // renderer does not understand is a hole in the conversation, not a reason to
  // invent something plausible.
  return null;
}

/* ---------------------------------------------------------------------------
 * THE TRANSCRIPT
 * ------------------------------------------------------------------------- */
function Message(props) {
  var m = props.message;
  var agent = m.role === "agent";
  return h("div", { className: "flex " + (agent ? "justify-start" : "justify-end") + " mb-4" },
    h("div", { className: agent ? "max-w-2xl" : "max-w-xl" },
      agent
        ? h("div", { className: "rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3" },
            h("p", { className: "text-sm leading-relaxed text-slate-800" }, esc(m.text)),
            (m.widgets || []).length > 0
              ? h("div", null, m.widgets.map(function (w, i) {
                  return h("div", { key: i }, renderWidget(w, props.version));
                }))
              : null
          )
        : h("div", { className: "rounded-2xl rounded-tr-sm bg-slate-900 px-4 py-2.5 text-white text-sm" },
            esc(m.text)),
      agent && m.suggestions && m.suggestions.length > 0
        ? h("div", { className: "mt-2 flex flex-wrap gap-2" }, m.suggestions.map(function (s) {
            return h("button", {
              key: s,
              onClick: function () { props.ask(s); },
              className: "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            }, esc(s));
          }))
        : null
    )
  );
}

function App() {
  var sThread = React.useState(function () {
    // The greeting is EMBEDDED, computed by the router's own greet() at
    // generation time. On screen with no network round trip, and the sentence
    // the user reads is the sentence this repository's tests assert on.
    return [{ role: "agent", text: D.greeting.text, widgets: D.greeting.widgets || [], suggestions: D.greeting.suggestions || [] }];
  });
  var thread = sThread[0], setThread = sThread[1];

  var sText = React.useState("");
  var text = sText[0], setText = sText[1];
  var sBusy = React.useState(false);
  var busy = sBusy[0], setBusy = sBusy[1];
  var sVersion = React.useState(0);
  var version = sVersion[0], setVersion = sVersion[1];
  var sLearned = React.useState(D.learned || {});
  var learned = sLearned[0], setLearned = sLearned[1];
  var endRef = React.useRef(null);

  React.useEffect(function () {
    if (endRef.current !== null) endRef.current.scrollIntoView({ block: "end" });
  }, [thread.length]);

  function push(messages) {
    setThread(function (t) { return t.concat(messages); });
  }

  function ask(sentence) {
    var said = String(sentence === undefined ? text : sentence).trim();
    if (said === "" || busy) return;
    setText("");
    push([{ role: "user", text: said }]);
    setBusy(true);

    // A CORRECTION IS HANDLED HERE, NOT SERVER-SIDE, because it has to change
    // the engine's memory -- and the router in conversation.ts is the single
    // implementation of "what does this sentence mean". It runs in the browser
    // exactly as the tests run it, and a correction never becomes a chat turn
    // whose answer is a refusal.
    var parsed = parseCorrection(said);
    if (parsed.ok) {
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: D.source, column: parsed.column, role: parsed.role })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        var fb = (r.body && r.body.feedback) || {};
        if (!r.ok) {
          setBusy(false);
          push([{ role: "agent", text: (r.body.failure && r.body.failure.reason) || "that correction was refused.", widgets: [], suggestions: [] }]);
          return;
        }
        setLearned(fb.roles || {});
        push([{
          role: "agent",
          text: fb.reason || (parsed.column + " is now the " + parsed.role) + ". Re-reading the file.",
          widgets: [], suggestions: []
        }]);
        refreshFromServer(setVersion, function (why) {
          setBusy(false);
          push([{ role: "agent", text: why, widgets: [], suggestions: [] }]);
        });
      }).catch(function (error) {
        setBusy(false);
        push([{ role: "agent", text: "the server did not answer: " + error.message, widgets: [], suggestions: [] }]);
      });
      return;
    }

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: D.source, message: said })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      setBusy(false);
      if (!r.ok) {
        push([{
          role: "agent",
          text: (r.body && r.body.failure && r.body.failure.reason) || "the server did not answer that.",
          widgets: [], suggestions: []
        }]);
        return;
      }
      push([{
        role: "agent",
        text: r.body.reply.text,
        widgets: r.body.reply.widgets || [],
        suggestions: r.body.reply.suggestions || []
      }]);
    }).catch(function (error) {
      setBusy(false);
      push([{ role: "agent", text: "the server did not answer: " + error.message, widgets: [], suggestions: [] }]);
    });
  }

  return h("div", { className: "min-h-screen bg-slate-50 text-slate-900" },
    h("header", { className: "border-b border-slate-200 bg-white" },
      h("div", { className: "mx-auto max-w-3xl px-4 py-3 flex items-baseline justify-between gap-4" },
        h("h1", { className: "text-sm font-semibold truncate" }, esc(D.title)),
        h("span", { className: "text-xs text-slate-500 shrink-0" },
          D.source ? esc(D.source) : D.totalRows.toLocaleString("en-US") + " rows")
      )
    ),

    h("main", { className: "mx-auto max-w-3xl px-4 py-6 pb-40" },
      thread.map(function (m, i) {
        return h(Message, { key: i, message: m, version: version, ask: ask });
      }),
      h("div", { ref: endRef }),

      h("details", { className: "mt-8 text-xs text-slate-500" },
        h("summary", { className: "cursor-pointer" }, "Data provenance"),
        h("p", { className: "mt-2" },
          D.totalRows.toLocaleString("en-US") + " rows read from " +
          (D.source ? esc(D.source) : "an uploaded file") + ". " +
          "Column readings marked as hypotheses were inferred from column names and a " +
          "statistical profile, not verified by a person. " +
          "Severity: a value past the 3x-IQR outer fence is critical, past 1.5x is a warning.")
      )
    ),

    // THE COMPOSER, where a composer belongs.
    h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },
      h("form", {
        className: "mx-auto max-w-3xl px-4 py-3 flex gap-2",
        onSubmit: function (e) { e.preventDefault(); ask(); }
      },
        h("input", {
          type: "text",
          value: text,
          placeholder: "Ask about this file, or say \\u201ccol_1 is the duration\\u201d",
          "aria-label": "Ask a question, or correct a column",
          onChange: function (e) { setText(e.target.value); }
        }),
        h("button", { type: "submit", disabled: busy },
          busy ? "..." : "Ask")
      )
    )
  );
}

`;

src = src.slice(0, start) + APP + src.slice(end);
writeFileSync(FILE, src, "utf8");
console.log("chat-first app written");