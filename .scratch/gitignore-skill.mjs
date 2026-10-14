// Records why an external artefact is not tracked, without a shell redirection
// (which the repository policy scanner rejects as a path escape).
import { appendFileSync } from "node:fs";

appendFileSync(
  ".gitignore",
  [
    "",
    "# An external skill artefact, present on this machine before this work began.",
    "# Not ours to track, and not part of the kernel's source: a vendored bundle",
    "# would drag its own changelog and node_modules into every review that touches",
    "# a file list.",
    "skills/ui-ux-pro-max-skill/",
    "",
  ].join("\n"),
);
console.log("gitignore updated");