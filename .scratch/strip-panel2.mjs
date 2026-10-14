import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

// ChatPanel and everything after it inside CHAT_SOURCE goes. The chat-first App
// has its own transcript and composer; leaving the panel would splice a SECOND
// chat implementation into every live page, which is exactly the one-implementation
// property this codebase keeps being bitten by.
const cutAt = src.indexOf("/**\n * THE CONVERSATION. One sentence in, one honest answer out.");
if (cutAt < 0) throw new Error("ChatPanel doc not found");

const chatEnd = src.indexOf("\n`;", cutAt);
if (chatEnd < 0) throw new Error("CHAT_SOURCE close not found");

src = src.slice(0, cutAt).replace(/\s+$/, "\n") + src.slice(chatEnd);

// The old splice point no longer exists in the app tree; the live page still
// needs the re-read helper, so the splice stays but carries only that.
src = src.replace(
  '.split("__CHAT__").join(live ? `React.createElement(ChatPanel)` : "null")',
  '.split("__CHAT__").join("null")',
);

writeFileSync(FILE, src, "utf8");

const leftovers = (src.match(/ChatPanel|EXAMPLES|w-80 shrink-0/g) ?? []);
console.log("leftovers:", leftovers.length === 0 ? "none" : leftovers.join(", "));