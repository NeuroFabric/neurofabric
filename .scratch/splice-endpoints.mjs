import { readFileSync, writeFileSync } from "node:fs";

// --- 1. Type narrowing in the export helper. ------------------------------
{
  const FILE = "platform/web/server.ts";
  let src = readFileSync(FILE, "utf8");
  const from = `    transcript: thread.map((turn) => ({
      role: turn.role,
      text: turn.text,
      widgets: [],
      suggestions: [],
    })),`;
  const to = `    // Narrowed to the union the payload declares. The filter above has
    // already rejected anything that is not one of the two roles, but the type
    // cannot see that, and widening it back to string would be worse.
    transcript: thread.map((turn) => ({
      role: turn.role === "user" ? "user" : "agent",
      text: turn.text,
      widgets: [],
      suggestions: [],
    })),`;
  if (!src.includes(from)) throw new Error("export transcript map not found");
  src = src.replace(from, to);
  writeFileSync(FILE, src, "utf8");
  console.log("1. export transcript roles narrowed");
}

// --- 2. The endpoints must not appear in an OFFLINE artifact. -------------
{
  const FILE = "platform/web/react-report.ts";
  let src = readFileSync(FILE, "utf8");

  // Replace the literal endpoint strings with markers.
  const pairs = [
    ['fetch("/api/feedback"', 'fetch("__FEEDBACK_URL__"'],
    ['fetch("/api/chat"', 'fetch("__CHAT_URL__"'],
    ['fetch("/api/dashboard?path="', 'fetch("__DASH_URL__?path="'],
  ];
  for (const [literal, marker] of pairs) {
    if (!src.includes(literal)) throw new Error("endpoint literal not found: " + literal);
    src = src.split(literal).join(marker);
  }

  // Substitute them back per mode, in the existing splice chain.
  const spliceAnchor = '.split("__CHAT__").join("null")';
  if (!src.includes(spliceAnchor)) throw new Error("splice anchor not found");
  src = src.replace(spliceAnchor, `${spliceAnchor}
    // THE ENDPOINTS ARE SPLICED, NOT HARD-CODED.
    //
    // An offline artifact -- and every export is one -- must not contain the
    // string "/api/feedback" at all. The handler is already unreachable there
    // (the composer is not rendered, and ask() returns on the live flag), and an
    // unreachable fetch is still a fetch: it is code that reads as a feature in
    // a document that has no server, and it is the thing a recipient would try
    // to use. Resolving the URLs at generation time makes "offline" mean the
    // network calls are absent from the source, not merely unreachable.
    .split("__FEEDBACK_URL__").join(live ? "/api/feedback" : "about:blank#offline")
    .split("__CHAT_URL__").join(live ? "/api/chat" : "about:blank#offline")
    .split("__DASH_URL__").join(live ? "/api/dashboard" : "about:blank#offline")`);

  writeFileSync(FILE, src, "utf8");
  console.log("2. endpoints spliced, absent from offline artifacts");
}