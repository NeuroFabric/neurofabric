/**
 * ARCHIFY — THE ARCHITECTURE SCANNER'S RULEBOOK.
 *
 * === WHAT THIS IS FOR ===
 *
 * Two boundaries in this repository are load-bearing security properties, and both
 * of them are the KIND that survive review and then rot: a layer boundary that
 * holds until the day somebody adds one import for convenience. ADR-010 §A5 and the
 * composition-root commit are prose arguments for those boundaries. This file turns
 * them into something a machine fails a build on, which is the only kind of
 * statement that is still true next quarter.
 *
 * A rule here is not style. Every one of them encodes a decision that is expensive to
 * reverse and invisible in review:
 *
 *   1. VAULT ISOLATION — the MCP embassy must reach credential storage through ONE
 *      module, so there is exactly one place where the whole dependency set of the
 *      vault becomes reachable. "Only server.ts imports the vault" is checkable.
 *      "Everyone remembers not to import the vault directly" is not.
 *
 *   2. AUDIT ENCLOSURE — application logic must not reach into the SQLite ledger.
 *      Every read and every write is supposed to go through the ledger's own port, so
 *      that a row can be made durable BEFORE the thing it describes is reported as
 *      done. A stray `import { MemoryStore }` from a route handler or a tool is a
 *      transaction that never happened.
 *
 * === HOW TO READ A FAILURE ===
 *
 * A violation is not a bug report; it is evidence that a boundary was crossed. The
 * fix is normally to add a parameter and invert the dependency, NOT to add the
 * offender to `pathNot` below. `pathNot` entries in this file are exemptions that
 * were reasoned about — if you are adding one, write the reason in the comment next
 * to it, in the same commit.
 *
 * === TESTS ===
 *
 * Test files are exempt from both boundary rules and are excluded from the graph
 * (`doNotFollow` / `exclude` at the bottom). They legitimately reach across
 * boundaries — a test's whole job is to hold both ends of one at once — and letting
 * them into the rule set would mean the rules describe nothing, because the graph
 * would be permanently red.
 */

/** The ONE module in the embassy allowed to see the vault. See `server.ts`. */
const COMPOSITION_ROOT = "^platform/embassy/server\\.ts$";

/** The ledger's own module. It is the thing being protected, not a client of it. */
const LEDGER_HOME = "^platform/memory/";

export default {
  forbidden: [
    /**
     * === RULE 1: VAULT ISOLATION ===
     *
     * Nothing under `platform/embassy/` may import `platform/vault/` except the
     * composition root. The embassy is an MCP SERVER: `callTool` invokes a handler
     * directly and `callCore` reaches the portal with a credential, so there is no
     * kernel precheck standing between it and a secret. A second module that can
     * import the store is a second module that can read a tenant's credentials with
     * no approval recorded — which is exactly the weaker capability that
     * `store.ts`'s file header says this vault was built to avoid enabling.
     *
     * Exemption: `server.ts`, which is the composition root. It is exempted BY PATH,
     * not by "is called something like a root", so renaming the file breaks the rule
     * loudly instead of silently widening it.
     */
    {
      name: "vault-isolation",
      severity: "error",
      comment:
        "Only the embassy composition root (platform/embassy/server.ts) may import platform/vault/. " +
        "Any other module that can reach the store can read a tenant credential with no approval recorded.",
      from: { path: "^platform/embassy/", pathNot: "\\.(test|spec)\\.ts$|^platform/embassy/server\\.ts$" },
      to: { path: "^platform/vault/" },
      // The composition root is allowed in, and nothing else is. Implemented as a
      // `pathNot` on the *from* side so the exemption is one path, visible above.
      // dependency-cruiser has no "allow this one file" clause, so the allowed
      // importer is carved out here and re-asserted by the `vault-isolation-root-is-the-only-one`
      // rule below — so removing this carve-out turns that rule red instead of
      // turning this one silently green.
    },

    /**
     * === RULE 1b: THE EXEMPTION IS EXACTLY ONE FILE ===
     *
     * This is the rule that keeps rule 1 honest. Rule 1 carves the composition root
     * out of its own match, and a carve-out is a hole shaped exactly like whatever
     * you most want to allow. So the hole is asserted: `platform/embassy/server.ts`
     * is permitted to reach the vault, and NOTHING ELSE ANYWHERE is.
     *
     * If somebody adds `platform/embassy/vault-tools.ts` and gives it a pathNot
     * entry above, this rule still fires. Two edits are needed to widen the vault,
     * and the second one is the one that shows up in the diff review.
     */
    {
      name: "vault-isolation-root-is-the-only-one",
      severity: "error",
      comment:
        "platform/embassy/server.ts is the single composition root permitted to reach platform/vault/. " +
        "No other file in platform/ may import it. The vault's own internals are exempt -- a module " +
        "importing its own siblings is not 'reaching the vault', it is the vault.",
      from: { path: "^platform/", pathNot: "^platform/vault/|" + COMPOSITION_ROOT },
      to: { path: "^platform/vault/" },
    },

    /**
     * === RULE 2: AUDIT ENCLOSMENT ===
     *
     * Application logic must not import the SQLite ledger directly. The ledger
     * exposes a port (`memory-routes.ts` / the store's append-only API); logic that
     * opens its own handle to the database is logic that can report success for a
     * row nobody committed.
     *
     * Exempt: `platform/memory/**` (the ledger itself, and its own tests) and the
     * two composition roots that are responsible for wiring it — `embassy/server.ts`
     * and `web/server.ts`. A composition root is allowed to know which ledger it is
     * opening; a handler is not, and that asymmetry is the entire point of a
     * composition root.
     */
    {
      name: "audit-enclosure",
      severity: "error",
      comment:
        "Application logic must not open its own handle to the SQLite ledger. " +
        "Go through the ledger's port so the row is committed before the work is reported done.",
      from: {
        path: "^platform/",
        pathNot: "\\.(test|spec)\\.ts$|" + LEDGER_HOME + "|^platform/embassy/server\\.ts$|^platform/web/server\\.ts$",
      },
      to: { path: "^platform/memory/store\\.ts$" },
    },
  ],

  options: {
    /**
     * `.pi/` is a separate deployment surface (the Pi extension) and `verification/`
     * is proof harnesses. Both are real code, and neither is covered by the two
     * boundaries above, which are stated about `platform/`. They are graphed (they
     * appear in the report) but not rule-checked, so the rulebook says only what it
     * can actually enforce.
     */
    includeOnly: "^(platform|scripts|verification|\\.pi)",

    /**
     * Tests are NODES in the graph (their imports are real and worth seeing) but they
     * are deliberately not SUBJECTS of the boundary rules, per the file header.
     * `exclude` removes them from traversal; `doNotFollow` alone would still leave
     * them as rule subjects.
     */
    exclude: "(^|/)node_modules/|(^|/)venv/|\\.(test|spec)\\.[cm]?[jt]sx?$|(^|/)builds/|(^|/)\\.scratch/|\\.min\\.js$|(^|/)ui-workspace/|(^|/)frontend/|(^|/)skills/",
    doNotFollow: {
      path: "node_modules",
    },

    /** Dot output is what `npm run archify` renders; keep it oriented bottom-up. */
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "tsconfig.json" },

    reporterOptions: {
      dot: {
        // Group by folder so the picture is the ARCHITECTURE and not a hairball of
        // filenames. `-S 2` at the call site can go deeper when a folder needs it.
        collapsePattern: "^(platform|scripts|verification|\\.pi)/[^/]+/",
      },
    },

    /** Metrics power the stability column in the report; cheap enough to always have. */
    metrics: true,
    cache: false,
  },
};