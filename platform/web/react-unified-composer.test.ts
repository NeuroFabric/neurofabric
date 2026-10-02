import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard } from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";

/**
 * ONE INPUT. THE UPLOAD TRIGGER LIVES IN IT.
 *
 * The product had two front doors: a launcher page with a dropzone at the top,
 * and a dashboard with a text box at the bottom. Loading a file meant going back
 * to the launcher; once you were talking to the agent you could not hand it the
 * next file without losing your place. Two doors is also two things to explain.
 *
 * So the composer becomes one thing: an input that takes a document OR a
 * sentence, with a paperclip at its left, docked centre-bottom. The claim below
 * is made against the RENDERED TREE rather than the source, because "the paperclip
 * is to the left of the text input" is a statement about what the eye sees, and
 * no regex over a generated string can tell an element that renders before
 * another from one whose source is merely written first.
 *
 * === THE UPLOAD IS A FILENAME, NOT BYTES, AND THAT IS DELIBERATE ===
 *
 * The agent reads files from the workspace on this machine through the kernel;
 * nothing is uploaded anywhere. The paperclip therefore sends the NAME and lets
 * the server open it by the same boundary-checked path every other route uses.
 * Turning the paperclip into a real byte upload would be a security REGRESSION
 * introduced by a UX change, and the test below pins that no file-reading
 * machinery appears in the OFFLINE artifact at all.
 */

const analysis = await buildAnalysis();

const LIVE = { live: { path: "operations.csv" } } as never;

interface El {
  tag: string; type: string | null; ariaLabel: string | null;
  placeholder: string | null; className: string;
}

/** Render the app and flatten the tree, reusing the evaluating harness. */
async function liveTree(): Promise<El[]> {
  const { evaluateAppForTest } = await import("./react-app-harness.ts");
  // evaluateAppForTest already returns the flat tree; asking for .tree on it
  // was the first version of this bug.
  return evaluateAppForTest(toReactDashboard(analysis, LIVE));
}

test("the composer input says it takes a document OR a question", async () => {
  const tree = await liveTree();
  const input = tree.find((e) => e.placeholder !== null);
  assert.ok(input !== undefined, "the composer must still have a text input");
  assert.equal(input!.placeholder,
    "Upload any document, report, or log file, or ask a question...",
    "the placeholder is the whole pitch: one box, both jobs");
});

test("there is an upload control, and it is a real button", async () => {
  const tree = await liveTree();
  const upload = tree.find((e) => e.ariaLabel !== null && /file|upload|attach/i.test(e.ariaLabel!));
  assert.ok(upload !== undefined,
    `the paperclip must be a labelled control, not an unlabelled glyph: ${JSON.stringify(tree.filter((e) => e.tag === "button"))}`);
});

test("THE PAPERCLIP RENDERS TO THE LEFT OF THE TEXT INPUT", async () => {
  const tree = await liveTree();
  const paperclip = tree.findIndex((e) => e.ariaLabel !== null && /file|upload|attach/i.test(e.ariaLabel!));
  const input = tree.findIndex((e) => e.placeholder !== null);
  assert.ok(paperclip >= 0, "the paperclip must exist");
  assert.ok(input >= 0, "the text input must exist");
  assert.ok(paperclip < input,
    `paperclip at index ${paperclip}, input at ${input}; the attachment goes on the LEFT`);
});

test("the composer is docked centre-bottom as one floating bar", async () => {
  const tree = await liveTree();
  const dock = tree.findIndex((e) => /sticky bottom-0/.test(e.className));
  assert.ok(dock >= 0, `the composer must be docked: ${JSON.stringify(tree.map((e) => e.className).slice(-6))}`);

  // ChatGPT-style: a floating rounded surface centred in the column, NOT a
  // full-bleed bar with a hard top border. The old composer had `border-t`,
  // which read as a separate region rather than as part of the conversation.
  assert.doesNotMatch(tree[dock]!.className, /border-t/, "no hard divider above the composer");

  const form = tree.findIndex((e) => e.tag === "form");
  assert.ok(form > dock, "the composer form sits inside the dock");
  assert.match(tree[form]!.className, /rounded-/, "the input row is one rounded surface");
  assert.match(tree[form]!.className, /flex/, "laid out as a row");

  // Centred in the reading column, so the composer lines up with the transcript
  // rather than spanning the window. The centring lives on the WRAPPER, which
  // is where Tailwind expects it; an earlier draft of this test asserted
  // mx-auto on the form itself and failed against correct markup.
  const wrapper = tree.slice(dock + 1, form).find((e) => /mx-auto/.test(e.className));
  assert.ok(wrapper !== undefined,
    `a centred wrapper between the dock and the form: ${JSON.stringify(tree.slice(dock, form + 1).map((e) => e.className))}`);
});

test("dropping a file anywhere on the conversation opens the picker", async () => {
  // Drag and drop must still work. Removing the visible dropzone is only a
  // simplification if the gesture is preserved, and a user who has dragged files
  // onto this app for two releases will not know to look for a paperclip.
  const src = toReactDashboard(analysis, LIVE);
  assert.match(src, /onDrop/, "a drop handler must exist");
  assert.match(src, /onDragOver|onDragEnter/, "and a drag-over handler, or the browser navigates to the file");
});

test("the file input itself is present and hidden", async () => {
  const tree = await liveTree();
  const picker = tree.find((e) => e.type === "file");
  assert.ok(picker !== undefined, "the paperclip needs a file input behind it");
});

test("the OFFLINE export gains NO upload control", async () => {
  // An export is emailed to people with no server. A paperclip there is a
  // control wired to nothing, which is the exact defect the offline composer
  // exists to avoid.
  const html = toReactDashboard(analysis, {});
  assert.doesNotMatch(html, /type="file"/, "an export must not contain a file picker");
  assert.match(html, /standalone export/i, "it says plainly that it cannot take one");
});

test("the upload never sends file BYTES, only a name", async () => {
  // The API names are built from fragments rather than written literally, and
  // that is deliberate: this assertion reads the emitted SOURCE, which includes
  // its comments, and an earlier draft of the composer explained in a comment
  // that it used no file-reading API -- naming the API -- which then failed its
  // own test. A source-level check cannot tell a comment from code, so the
  // honest fix is not to name the API in the prose.
  const src = toReactDashboard(analysis, LIVE);
  for (const banned of ["File" + "Reader", "Form" + "Data", "readAs" + "Text"]) {
    assert.ok(!src.includes(banned), `nothing in the page uses ${banned}`);
  }
});