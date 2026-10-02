/**
 * THE PAGE. One self-contained HTML string, no build step, no dependency.
 *
 * RENDERING THE REPORT SAFELY. The report is returned as Markdown in a JSON
 * response and rendered here. Two rules make that safe, and the order matters:
 *
 *   1. ESCAPE FIRST. Every character of the report is HTML-escaped before any
 *      Markdown transform runs. Nothing that came out of an uploaded file can
 *      therefore be markup, no matter which transform follows -- a file whose
 *      alert code is `<img src=x onerror=...>` is displayed as those characters.
 *   2. TRANSFORM SECOND. Only a fixed, small set of Markdown constructs is
 *      turned into elements: headings, tables, bold, code, blockquotes, rules
 *      and list items. There is no "pass through raw HTML" step, because that
 *      is the step every Markdown renderer eventually grows and every one of
 *      them has shipped a hole through.
 *
 * So a reader sees a report, and a hostile export sees a paragraph of text.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bottleneck report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #16181d; }
  main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .35rem; }
  .sub { color: #5b616e; margin: 0 0 1.5rem; font-size: .9rem; }
  #drop { border: 2px dashed #b9bfcc; border-radius: 10px; background: #fff; padding: 2.5rem 1.5rem; text-align: center; cursor: pointer; }
  #drop.hot { border-color: #16181d; background: #f0f2f6; }
  #drop strong { display: block; font-size: 1.05rem; margin-bottom: .3rem; }
  #drop span { color: #5b616e; font-size: .88rem; }
  #status { margin: 1rem 0 0; font-size: .9rem; color: #5b616e; }
  #status.error { color: #b23c17; }
  #status .tier { font-weight: 600; }
  article { background: #fff; border: 1px solid #e4e7ee; border-radius: 10px; padding: 1.5rem 1.75rem; margin-top: 1.5rem; }
  article h1 { font-size: 1.25rem; margin-top: 1.5rem; }
  article h2 { font-size: 1.02rem; margin: 1.75rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid #e4e7ee; }
  article table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .9rem; }
  article th, article td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f4; }
  article th { font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; color: #5b616e; }
  article blockquote { border-left: 3px solid #16181d; margin: .75rem 0; padding: .35rem 0 .35rem .8rem; }
  article code { background: #f0f2f6; padding: .05rem .3rem; border-radius: 3px; font-size: .88em; }
  article li { margin: .2rem 0; }
  .hint { color: #5b616e; font-size: .82rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>Bottleneck report</h1>
  <p class="sub">Drop a CSV export. It is read through the governed kernel pipeline, and every refusal you see below is the kernel&rsquo;s own.</p>

  <div id="drop" tabindex="0" role="button" aria-label="Drop a CSV file or press Enter to choose one">
    <strong>Drop a CSV file here</strong>
    <span>or click to choose one &middot; the file must already be in the workspace folder</span>
  </div>
  <input id="picker" type="file" accept=".csv,text/csv" hidden>
  <p id="status" role="status" aria-live="polite"></p>

  <article id="report" hidden></article>

  <p class="hint">The file is not uploaded anywhere. It is read from the workspace folder on this machine, and every path is checked by the kernel before it is opened.</p>
</main>
<script>
(function () {
  var drop = document.getElementById("drop");
  var picker = document.getElementById("picker");
  var status = document.getElementById("status");
  var report = document.getElementById("report");

  // RULE 1. Escape everything, always, before any transform. The only string
  // this function ever returns is inert text.
  function esc(text) {
    return String(text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // The small set of inline marks, applied to ALREADY ESCAPED text. A backslash
  // escape written by the renderer is consumed here and never reaches the DOM.
  function inline(escaped) {
    return escaped
      .replace(/\\\\([\\\`*_{}\\[\\]()#+\\-.!|])/g, "$1")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>")
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  }
  // RULE 2. Only these block shapes become elements. There is no raw-HTML path.
  function render(markdown) {
    var lines = esc(markdown).split(/\\r?\\n/);
    var out = [], i = 0;
    function flushList(items) { if (items.length) { out.push("<ul>" + items.map(function (t) { return "<li>" + inline(t) + "</li>"; }).join("") + "</ul>"); } }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\\s*$/.test(line)) { i++; continue; }
      if (/^\\|/.test(line) && i + 1 < lines.length && /^\\|[\\s:|-]+\\|$/.test(lines[i + 1])) {
        var head = line.split("|").slice(1, -1).map(function (c) { return inline(c.trim()); });
        out.push("<table><thead><tr>" + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead><tbody>");
        i += 2;
        while (i < lines.length && /^\\|/.test(lines[i])) {
          var cells = lines[i].split("|").slice(1, -1).map(function (c) { return "<td>" + inline(c.trim()) + "</td>"; });
          out.push("<tr>" + cells.join("") + "</tr>");
          i++;
        }
        out.push("</tbody></table>");
        continue;
      }
      if (/^#{1,3} /.test(line)) { out.push("<h2>" + inline(line.replace(/^#{1,3} /, "")) + "</h2>"); i++; continue; }
      if (/^> /.test(line)) { out.push("<blockquote>" + inline(line.replace(/^> /, "")) + "</blockquote>"); i++; continue; }
      if (/^[-*] /.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].replace(/^[-*] /, "")); i++; }
        flushList(items);
        continue;
      }
      out.push("<p>" + inline(line) + "</p>");
      i++;
    }
    return out.join("");
  }

  function say(text, isError) {
    status.textContent = text;
    status.className = isError ? "error" : "";
  }

  function send(path) {
    say("Reading " + path + " through the kernel\\u2026");
    report.hidden = true;
    fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path })
    }).then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; });
    }).then(function (result) {
      var body = result.body || {};
      if (body.status === "DELIVERED" && body.markdown) {
        // GO TO THE DASHBOARD. This line is the product.
        //
        // The dropzone used to render the Markdown into this page, and the
        // dashboard -- every chart, the tooltips, the whole conversational UI --
        // was served by '/api/dashboard' and reached by nobody. The Owner
        // dropped a file, saw a wall of table rows, and correctly concluded the
        // product had no charts and no chatbot. Both were built, tested,
        // type-checked and parsed. None of it was ever shown to a human.
        //
        // So the success branch navigates. It does NOT render both, and that is
        // deliberate: the markdown generator emits a table per column and the
        // Owner was scrolling past a hundred rows of it. The Markdown remains
        // what '/api/report' returns -- it is the report of record, it is what
        // gets written to disk, and it is what every other consumer reads. This
        // is only about which document the USER is shown.
        //
        // The refusal branch below deliberately does NOT navigate. Throwing away
        // the kernel's "no" to make a page look busier is the exact failure this
        // product exists to avoid.
        //
        // encodeURIComponent, because a real filename contains spaces and the
        // raw form resolves as two query parameters: the server would read the
        // file 'my', tell the user it does not exist, and be believed.
        window.location.href = "/api/dashboard?path=" + encodeURIComponent(path);
        return;
      }
      // The refusal is the kernel's, and it is shown with the kernel's tier.
      var failure = body.failure || {};
      var tier = failure.kernelReasonCode ? failure.kernelReasonCode + ": " : "";
      say(tier + (failure.reason || "the run did not deliver"), true);
    }).catch(function (error) {
      say("The server did not answer: " + error.message, true);
    });
  }

  drop.addEventListener("click", function () { picker.click(); });
  drop.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); picker.click(); } });
  picker.addEventListener("change", function () { if (picker.files && picker.files[0]) { send(picker.files[0].name); } });
  ["dragenter", "dragover"].forEach(function (name) {
    drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.add("hot"); });
  });
  ["dragleave", "drop"].forEach(function (name) {
    drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.remove("hot"); });
  });
  drop.addEventListener("drop", function (event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files[0]) { send(files[0].name); }
  });
})();
</script>
</body>
</html>
`;
