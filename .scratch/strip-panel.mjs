import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

/**
 * CHAT_SOURCE now carries ONLY the re-read helper.
 *
 * The sidebar ChatPanel and its invitation block were the layout the Owner
 * rejected, and the chat-first App has its own transcript and composer. Left in
 * place they would not be dead weight -- they would be SPLICE IN, adding ~90
 * lines of a second chat implementation to every live page, which is precisely
 * the "one implementation" property this codebase keeps being bitten by.
 *
 * What stays is refreshFromServer, which the new transcript calls after a
 * correction so the charts redraw.
 */

const chatStart = src.indexOf("const CHAT_SOURCE = String.raw`");
const chatEnd = src.indexOf("\n`;", chatStart);
if (chatStart < 0 || chatEnd < 0) throw new Error("CHAT_SOURCE bounds not found");

const bodyStart = src.indexOf("`", chatStart) + 1;
const body = src.slice(bodyStart, chatEnd);

// Everything from the invitation block to the end of ChatPanel goes.
const keepFrom = body.indexOf("/**\n * RE-READ THE ANALYSIS");
if (keepFrom < 0) throw new Error("refreshFromServer not found in CHAT_SOURCE");

const kept = body.slice(keepFrom).replace(
  /\n\/\*\*\n \* THE INVITATION[\s\S]*$/,
  "\n",
);

src = src.slice(0, bodyStart) + "\n" + kept + src.slice(chatEnd);

// The file still needs a comment explaining what CHAT_SOURCE is now for.
src = src.replace(
  " * THE CHAT SOURCE, held separately so it can be spliced in ONLY for a live page.",
  " * THE RE-READ HELPER, spliced in ONLY for a live page.",
);

writeFileSync(FILE, src, "utf8");
console.log("CHAT_SOURCE reduced to the re-read helper");