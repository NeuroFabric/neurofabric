import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { issueToken, proveTenant, staticVault, CREDENTIAL_HEADER, type VaultProvider } from "./edge-security.ts";

/**
 * ONE DOOR. Asserted, not asserted-about.
 *
 * === THE DEFECT THIS EXISTS FOR ===
 *
 * Three routers each wrote the same four lines -- load the vault, build an
 * `EdgeRequest`, run `guard`, take `tokenId` -- and each wrote them slightly
 * differently. `portal-routes` refused on an undefined `tokenId`; `memory-routes`
 * grew its own local `prove()`; and **`ui-routes.ts` proved the caller and then
 * ignored the tenant entirely.**
 *
 * That last one was correct at the time, because nothing `ui-routes` serves is
 * scoped by a tenant. It is also exactly the shape of a bug waiting for the first
 * route there that IS scoped: at which point an author has to decide where the
 * tenancy boundary sits, in a file that has never had one. This is the third
 * instance of that class in this repository, after the unreachable `App.tsx`
 * block and the `StoreStatus` union drift.
 *
 * === WHY A TEXT-SCAN AND NOT A TYPE ===
 *
 * A type cannot say "you may not call `guard` directly here" -- it can only say
 * what you may call. And the failure mode is a *deletion*: a router that stops
 * using the door and nobody notices, because the router still compiles, still
 * authenticates, and every existing test still passes. That is precisely what
 * happened in `ui-routes` and precisely what a test has to catch.
 *
 * So the rule is mechanical: `guard(` and `loadTokens(` may appear in the edge
 * module itself and NOWHERE ELSE. One door means one file that knows how to open
 * it.
 */

const EDGE = "omniroute/edge-security.ts";

/**
 * THE TWO PLACES THAT MAY CALL `guard` DIRECTLY, and neither is a router.
 *
 * This is an allowlist, so each entry is a decision somebody has to be able to
 * defend -- and both of these were found by this guard failing, which is the only
 * reason they are written down rather than left to be discovered again.
 */
const ALLOWED_DIRECT_CALLS: ReadonlyMap<string, string> = new Map([
  [
    "omniroute/omniroute-gateway.ts",
    // THE PUSH INGRESS. A different door: this one admits EVENTS rather than
    // serving a surface, it applies a per-provider RATE LIMIT that `proveTenant`
    // does not know about, and it takes its token list at construction rather
    // than from a vault. Forcing it through the read door would mean threading a
    // limiter through a function that has no business knowing one.
    "push ingress, and it is the door for events rather than for reads",
  ],
  [
    "swarm/safe-regex.ts",
    // NOT AN AUTHENTICATOR. `guard()` here is a private method on a regex
    // compilation guard -- it stops a catastrophic backtrack. The scan cannot tell
    // a noun from a call site, and renaming a working, well-named private method
    // to satisfy a text scan would be changing correct code for a false positive.
    // `guard` here means something else entirely",
  ],
]);

/**
 * THE KERNEL, AND ONLY THE KERNEL.
 *
 * Anchored to this file's own directory rather than to the process's, because the
 * first version walked `process.cwd()` and found the **GitLab Runner's stale copy
 * of the repository** under `builds/`. It reported six offenders, every one of
 * them a file that is not part of this tree, and it passed the check that matters:
 * the real `portal-routes.ts` was in the list too, buried under noise.
 *
 * A guard that reads the wrong tree is worse than no guard, because it trains
 * people to ignore it. So the root is fixed, and the skip list below exists for
 * the case where somebody re-anchors it by mistake.
 */
const PLATFORM = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", "builds", "venv", "dist"]);

/** Every non-test `.ts` under `platform/`, excluding this file. */
function sources(dir: string = PLATFORM): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      if (entry.includes(".test.")) continue;
      out.push({ file: path.relative(PLATFORM, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/** Strip comments and strings, so a MENTION of `guard` is not a CALL to it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

test("ONLY the edge module calls `guard` and `loadTokens`", () => {
  const offenders: string[] = [];
  for (const { file, text } of sources()) {
    if (file === EDGE) continue;
    const body = code(text);
    // An allowed entry still has to NAME the exception, so the count of permitted
    // direct calls is visible in the failure output rather than implied by
    // absence.
    if (/\bguard\s*\(/.test(body) && !ALLOWED_DIRECT_CALLS.has(file)) offenders.push(`${file} calls guard()`);
    if (/\bloadTokens\s*\(/.test(body) && !ALLOWED_DIRECT_CALLS.has(file)) offenders.push(`${file} calls loadTokens()`);
  }
  // THE ASSERTION. A new router that rolls its own door is now a red build rather
  // than a comment nobody reads.
  assert.deepEqual(offenders, [], `authenticate through proveTenant(), not directly:\n  ${offenders.join("\n  ")}`);
});

test("THE ALLOWLIST IS EXACTLY THE ALLOWLIST, and every entry is still used", () => {
  // An allowlist that outlives its reason is a hole with a comment. Two entries
  // that no longer match anything are dead permissions, and the moment somebody
  // copies one is the moment it becomes a real one.
  const files = new Set(sources().map((entry) => entry.file));
  for (const file of ALLOWED_DIRECT_CALLS.keys()) {
    assert.ok(files.has(file), `${file} is allowlisted but no longer exists`);
  }
  const direct = sources()
    .filter((entry) => entry.file !== EDGE && /\b(guard|loadTokens)\s*\(/.test(code(entry.text)))
    .map((entry) => entry.file);
  assert.deepEqual(direct.sort(), [...ALLOWED_DIRECT_CALLS.keys()].sort(), "the allowlist must match reality exactly, in both directions");
});

test("THE ALLOWLIST IS SMALL ENOUGH TO STAY HONEST", () => {
  // A number, so "we added a few exceptions" cannot happen quietly. Every
  // additional entry is one more authentication path somebody has to read.
  assert.ok(ALLOWED_DIRECT_CALLS.size <= 2, `one door means at most this many exceptions; there are ${ALLOWED_DIRECT_CALLS.size}`);
});

test("EVERY ROUTER THAT SERVES A TENANT-SCOPED SURFACE USES THE DOOR", () => {
  // Not a scan of "files that mention it" -- a list of the routers that HAVE to,
  // so that a NEW router added without one is caught by a human reading the
  // failure, rather than by a scan that only knows about today's files.
  const routers = ["api/ui-routes.ts", "api/portal-routes.ts", "api/schema-routes.ts", "memory/memory-routes.ts"];
  const missing = routers.filter((file) => {
    try {
      // Resolved against PLATFORM, not the process's working directory -- the
      // first version read the bare path, failed to find it, and reported all
      // four routers as missing. A guard that fails on an unreadable path must
      // SAY the path is unreadable rather than reporting a different failure.
      return !/\bproveTenant\s*\(/.test(code(readFileSync(path.join(PLATFORM, ...file.split("/")), "utf8")));
    } catch (error) {
      throw new Error(`the one-door guard could not read ${file}, which is itself a failure: ${String(error)}`);
    }
  });
  assert.deepEqual(missing, [], `these routers must authenticate through proveTenant(): ${missing.join(", ")}`);
});

test("ui-routes PROVES THE TENANT rather than discarding it", () => {
  // The specific defect, pinned. `tokenId` was proven and thrown away, which is
  // correct until the first scoped route and a hole afterwards.
  const text = readFileSync(path.join(PLATFORM, "api", "ui-routes.ts"), "utf8");
  assert.match(text, /proven\.tokenId/, "the tenant must be named where it is proven, not silently dropped");
});

/* ================================================================== *
 * THE DOOR'S OWN BEHAVIOUR, because a shared door is a shared blast.   *
 * ================================================================== */

const vaultOf = (): VaultProvider => staticVault([issueToken("acme", ["memory"])]);

test("A PROVEN CALLER GETS ITS TENANT BACK", async () => {
  const vault = vaultOf();
  const token = issueToken("acme", ["memory"]);
  const proven = await proveTenant(staticVault([token]), "memory", { [CREDENTIAL_HEADER]: token.credential });
  assert.equal(proven.ok, true);
  if (!proven.ok) return;
  assert.equal(proven.tokenId, "acme", "the identity is the credential's id, not its value");
  void vault;
});

test("NO CREDENTIAL IS REFUSED, AND THE DECISION IS RETURNED UNCHANGED", async () => {
  const proven = await proveTenant(vaultOf(), "memory", {});
  assert.equal(proven.ok, false);
  if (proven.ok) return;
  // The decision travels back rather than being flattened to a boolean, so a
  // caller renders the kernel's own refusal with its own tier.
  assert.equal(proven.decision.ok, false);
  assert.equal(proven.decision.status, 401);
});

test("A CREDENTIAL FOR ANOTHER PROVIDER IS REFUSED", async () => {
  const token = issueToken("acme", ["portal"]);
  const proven = await proveTenant(staticVault([token]), "memory", { [CREDENTIAL_HEADER]: token.credential });
  assert.equal(proven.ok, false, "a valid credential for the wrong door is still a refusal");
});

test("AN UNISSUED CREDENTIAL IS REFUSED", async () => {
  const proven = await proveTenant(vaultOf(), "memory", { [CREDENTIAL_HEADER]: "invented" });
  assert.equal(proven.ok, false);
});

test("AN EMPTY VAULT REFUSES EVERYBODY, which is the safe direction", async () => {
  const proven = await proveTenant(staticVault([]), "memory", { [CREDENTIAL_HEADER]: "anything" });
  assert.equal(proven.ok, false, "an unprovisioned deployment must not admit by default");
});

test("ROTATING A CREDENTIAL'S VALUE CHANGES NOBODY, and its ID changes everything", async () => {
  // ADR-005 §10.1, asserted rather than restated. Rotation is the common case and
  // must not orphan a customer's records; an id change is rare and is the one the
  // boot refuses on.
  const first = issueToken("acme", ["memory"]);
  const rotated = issueToken("acme", ["memory"]);
  assert.notEqual(first.credential, rotated.credential, "the values differ");
  const before = await proveTenant(staticVault([first]), "memory", { [CREDENTIAL_HEADER]: first.credential });
  const after = await proveTenant(staticVault([rotated]), "memory", { [CREDENTIAL_HEADER]: rotated.credential });
  assert.equal(before.ok && after.ok ? before.tokenId === after.tokenId : false, true, "the same id survives a new value");
});
