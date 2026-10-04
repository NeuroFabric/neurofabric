import test from "node:test";
import assert from "node:assert/strict";

import { parseFloodArgs } from "./flood-args.ts";
import { WEDGE_URL } from "./dev-endpoints.ts";

/**
 * THE FLOOD ARGUMENT PARSER, FIXTURE-TESTED.
 *
 * === WHY THIS FILE IS WORTH ITS OWN EXISTENCE ===
 *
 * A live demo failed four times in one session. Every failure was in the
 * bootstrap path, and this parser was the worst of them: `--token value` -- the
 * form every other CLI in the world accepts, and the form a person types under
 * pressure -- set the token to the empty string and reported a MISSING CREDENTIAL.
 *
 * The observable failure was a policy guard firing on the credential the operator
 * had just supplied correctly. **A syntax mistake must never present as a policy
 * violation**, because the operator's next move is to argue with the guard instead
 * of fixing the command.
 *
 * === WHY FIXTURES AND NOT EXAMPLES ===
 *
 * Every case below is a real command line someone typed. An "example" that
 * nobody re-ran is documentation; a fixture that fails is a test.
 */

const CREDENTIAL = "gw-fixture-9c1e";

/**
 * Parses with an EXPLICIT empty environment rather than a mutated one.
 *
 * Passing `{}` is better than deleting `process.env` keys around the call: the
 * host running this suite may genuinely have `WEDGE_URL` set, and a test that
 * deletes a global to get its answer is a test that fails on someone else's
 * machine for a reason it never mentions.
 */
function parse(argv: readonly string[]) {
  return parseFloodArgs(argv, {});
}

test("the equals form binds every flag", () => {
  const options = parse([
    `--url=http://127.0.0.1:9000`,
    `--token=${CREDENTIAL}`,
    "--provider=webhook",
    "--events=500",
    "--batch=100",
    "--concurrency=8",
    "--anomaly-every=13",
    "--seconds=3",
  ]);

  assert.equal(options.url, "http://127.0.0.1:9000");
  assert.equal(options.gatewayToken, CREDENTIAL);
  assert.equal(options.provider, "webhook");
  assert.equal(options.events, 500);
  assert.equal(options.batch, 100);
  assert.equal(options.concurrency, 8);
  assert.equal(options.anomalyEvery, 13);
  assert.equal(options.seconds, 3);
});

test("THE SPACE FORM BINDS TOO - the reason this file exists", () => {
  // Exactly what a person types. Before this parser accepted it, this produced a
  // token of "" and a message about a missing credential.
  const options = parse(["--url", "http://127.0.0.1:9000", "--token", CREDENTIAL, "--provider", "webhook", "--events", "500"]);

  assert.equal(options.url, "http://127.0.0.1:9000");
  assert.equal(options.gatewayToken, CREDENTIAL);
  assert.equal(options.provider, "webhook");
  assert.equal(options.events, 500);
});

test("both forms of the same command produce identical options", () => {
  const equals = parse([`--url=${WEDGE_URL}`, `--token=${CREDENTIAL}`, "--events=250"]);
  const spaced = parse(["--url", WEDGE_URL, "--token", CREDENTIAL, "--events", "250"]);

  // Not "both parse" -- they are the SAME command. Anything less would let the
  // two forms drift apart again, which is the failure being fixed.
  assert.deepEqual(spaced, equals);
});

test("a mixed command binds every flag whichever form it uses", () => {
  // The realistic case: someone edits a working command and only the value form.
  const options = parse([`--url=${WEDGE_URL}`, "--token", CREDENTIAL, "--batch=500", "--concurrency", "2"]);

  assert.equal(options.url, WEDGE_URL);
  assert.equal(options.gatewayToken, CREDENTIAL);
  assert.equal(options.batch, 500);
  assert.equal(options.concurrency, 2);
});

test("a flag with no value names itself, rather than binding an empty string", () => {
  // The distinction the guard depends on: a genuinely absent value is an error
  // about the SYNTAX, and a present credential that is refused is a 401. They
  // must not read alike.
  for (const flag of ["--token", "--url", "--provider", "--events"]) {
    assert.throws(
      () => parse([flag]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`${flag} needs a value`), `${flag} must name itself: ${message}`);
        // And it must show BOTH accepted syntaxes, since that is the help the
        // operator needs at the moment they typed it wrong -- built from the flag
        // itself, so a message that named only one form could not pass.
        assert.match(message, new RegExp(`${flag}=<value>`));
        assert.match(message, new RegExp(`${flag} <value>`));
        return true;
      },
      `${flag} with no value must refuse by name`,
    );
  }
});

test("the missing-credential guard still fires, and names both syntaxes", () => {
  assert.throws(
    () => parse([]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /--token/);
      assert.match(message, /WEDGE_GATEWAY_TOKEN/);
      // The guard itself is unchanged and must stay: no default credential, ever.
      assert.match(message, /credentialed/);
      return true;
    },
  );
});

test("the default target is the wedge's declared contract, not a stale literal", () => {
  // THE REGRESSION THIS PARSER CARRIES. It defaulted to 3000 while the wedge ran
  // on 8080, and the symptom -- "fetch failed" against a dead port while the
  // server was healthy -- looked like an engine fault and cost a live demo.
  assert.equal(parse(["--token", CREDENTIAL]).url, WEDGE_URL);
  assert.match(WEDGE_URL, /:8080$/);
});

test("WEDGE_URL overrides the default without a flag", () => {
  const env = { WEDGE_URL: "http://127.0.0.1:9999" };
  assert.equal(parseFloodArgs(["--token", CREDENTIAL], env).url, "http://127.0.0.1:9999");
  // And an explicit flag still beats the environment, because a flag is somebody's
  // deliberate act for this one command.
  assert.equal(parseFloodArgs(["--token", CREDENTIAL, "--url=http://127.0.0.1:7777"], env).url, "http://127.0.0.1:7777");
});

test("WEDGE_GATEWAY_TOKEN supplies the credential without a flag", () => {
  assert.equal(parseFloodArgs([], { WEDGE_GATEWAY_TOKEN: CREDENTIAL }).gatewayToken, CREDENTIAL);
});

test("a trailing slash is trimmed, so a pasted URL does not double up", () => {
  assert.equal(parse(["--token", CREDENTIAL, "--url=http://127.0.0.1:8080///"]).url, "http://127.0.0.1:8080");
});

test("a value containing an equals sign survives", () => {
  // Query strings are exactly this shape, and splitting on the FIRST `=` rather
  // than joining the rest is what makes `--url=http://h/?a=1&b=2` work.
  const options = parse(["--token", CREDENTIAL, "--url=http://127.0.0.1:8080/?a=1&b=2"]);
  assert.equal(options.url, "http://127.0.0.1:8080/?a=1&b=2");
});

test("a typo is refused rather than ignored", () => {
  assert.throws(() => parse(["--token", CREDENTIAL, "--providr=webhook"]), /unknown option: --providr/);
});

test("an empty value is refused where one is required", () => {
  assert.throws(() => parse(["--token", CREDENTIAL, "--url="]), /--url needs a base address/);
  assert.throws(() => parse(["--token", CREDENTIAL, "--provider="]), /--provider needs a name/);
});

test("the numeric flags stay bounded by the server's own ceilings", () => {
  // The batch ceiling is the SERVER's: an oversized body is refused by the
  // portal, which would read as a server fault rather than a client one.
  const options = parse(["--token", CREDENTIAL, "--batch=99999", "--concurrency=9999", "--events=0"]);
  assert.equal(options.batch, 1000);
  assert.equal(options.concurrency, 32);
  assert.equal(options.events, 1);
});