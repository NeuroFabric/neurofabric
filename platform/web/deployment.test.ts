import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE DEPLOYMENT'S SECURITY CONSTRAINTS, AS A TEST.
 *
 * WHAT THIS ACTUALLY PROVES, STATED HONESTLY FIRST: docker is not available in
 * the authoring environment, so nothing here has been BUILT or RUN. These
 * assertions read the Dockerfile and the compose file as text. They are a
 * regression guard, not a verification, and the distinction matters -- an
 * unverified container described as verified is how a security property quietly
 * stops existing.
 *
 * What they are genuinely good for is the most common way a container
 * deployment rots: someone removes `USER node` to make a permission error go
 * away, or changes `127.0.0.1:3000:3000` to `3000:3000` so a colleague can see
 * a demo, or adds a bind mount of the working tree to make a path resolve. Each
 * of those is a one-character or one-line change that looks like a fix and is a
 * boundary removal, and each of them is invisible in a build log.
 *
 * So the constraints are pinned where a change has to argue with them. The
 * operator still has to run the image; this only means the file cannot drift
 * silently in the meantime.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * STRIP COMMENTS BEFORE ASSERTING, which is the whole reason this helper exists.
 *
 * The first version of this file matched `/npm install/` and `/network_mode:
 * host/` against the raw files and failed -- because the files *document* why
 * they do not do those things, in comments that contain those exact strings. A
 * test that greps a config file for a directive will always find the directive
 * in the prose explaining its absence, and the failure then looks like a
 * security defect when it is a comment.
 *
 * This is the same mistake twice in one session, in three files now: assert on
 * a file's CONTENT, never on the whole file. Whole-line comments are stripped
 * here; inline trailing comments are left alone, because removing them safely
 * needs to understand quoting and a wrong guess silently changes what is being
 * asserted.
 */
function directives(source: string): string {
  return source.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join("\n");
}

const dockerfile = directives(readFileSync(path.join(ROOT, "Dockerfile"), "utf8"));
const compose = directives(readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8"));
const dockerignore = directives(readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));

/** The comments, kept for the one test that asserts the files are honest. */
const dockerfileProse = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const composeProse = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

test("the image runs as a non-root user, and never as root", () => {
  const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(users.length > 0, "the Dockerfile must declare a USER");
  assert.deepEqual(users, ["node"], `exactly one non-root user, switching once: got ${users.join(", ")}`);
  assert.ok(!/^USER\s+root/m.test(dockerfile), "and never root");
});

test("the workspace is created and chowned BEFORE the user switch", () => {
  // In this order. A chown after `USER node` fails, and a container that fails
  // to start is one nobody debugs.
  const chown = dockerfile.indexOf("chown");
  const user = dockerfile.search(/^USER\s/m);
  assert.ok(chown > -1, "the workspace must be chowned to the runtime user");
  assert.ok(user > -1);
  assert.ok(chown < user, `chown must precede USER: chown at ${chown}, USER at ${user}`);
});

test("no dependencies are installed, because there are none to install", () => {
  // The platform has zero runtime dependencies (D-018). An image with no
  // installed packages has no third-party code to compromise and no lockfile
  // to drift -- a security property, not just a smaller image.
  assert.ok(!/npm (ci|install)/.test(dockerfile),
    "a serving image with no runtime dependencies must not run npm install");
  assert.ok(!/^COPY.*node_modules/m.test(dockerfile), "and must not copy a host node_modules in");
});

test("the container's data boundary is the workspace, declared in the image", () => {
  // In the image as well as in compose, so someone running `docker run` by hand
  // gets the same containment as someone who read the orchestration file.
  assert.match(dockerfile, /ENV WEDGE_WORKSPACE=\/app\/workspace/);
  const cmd = /CMD\s+\[(.*)\]/s.exec(dockerfile)?.[1] ?? "";
  assert.match(cmd, /--workspace/, "the process must be told its workspace explicitly");
  assert.match(cmd, /\/app\/workspace/);
});

test("the session archive cannot reach the image", () => {
  // The one that matters most. `.session-archive/` is gitignored, so it is not
  // in the repository -- which means a build context picks it up from a working
  // checkout, and it holds the developer's learned schema memory.
  assert.match(dockerignore, /^\.session-archive\/$/m, "the archive must be excluded by exact rule");
  assert.match(dockerignore, /\*\*\/\.session-archive\//, "and at any depth, not only at the root");
  // And it must not be copied in by a COPY the ignore file does not cover.
  assert.ok(!/^\s*COPY.*\.session-archive/m.test(dockerfile), "and no COPY may bring it back");
});

test("the developer's own data files are kept out of the context", () => {
  assert.match(dockerignore, /^ui-workspace\/$/m);
  assert.match(dockerignore, /^workspace\/$/m);
});

test("the port is published to the host's LOOPBACK, and the container bind is deliberate", () => {
  // The asymmetry that makes containerisation work without widening the tool's
  // reachable surface: 0.0.0.0 inside the container's network namespace,
  // 127.0.0.1 on the host. Changing the host side to `3000:3000` is the single
  // most likely way this deployment becomes remote.
  assert.match(compose, /"127\.0\.0\.1:3000:3000"/, "the published port must be loopback-bound");
  assert.ok(!/^\s*-\s*"?3000:3000"?\s*$/m.test(compose), "a bare 3000:3000 would publish on every interface");
  assert.match(compose, /WEDGE_HOST:\s*"0\.0\.0\.0"/, "the in-container bind is explicit, not inherited");
  // And the code default must still be loopback, or the container would be the
  // only place the safety property is absent.
  const server = readFileSync(path.join(ROOT, "platform", "web", "server.ts"), "utf8");
  assert.match(server, /\?\? "127\.0\.0\.1"/, "the server default must remain loopback");
});

test("nothing in the compose file widens the container's privilege", () => {
  for (const forbidden of [/privileged:\s*true/, /network_mode:\s*"?host"?/, /^\s*-\s*\/:/m, /cap_add:/, /docker\.sock/]) {
    assert.ok(!forbidden.test(compose), `compose must not contain ${forbidden}`);
  }
  // The positive controls, because an absent hardening flag reads the same as an
  // unconfigured one in a diff.
  assert.match(compose, /read_only:\s*true/, "the root filesystem should be read-only");
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /mem_limit:/, "and a memory ceiling, since input size is the operator's to choose");
});

test("the healthcheck asks the real question, not merely whether the socket is open", () => {
  // A listener that is up while its module graph failed to import answers on the
  // socket and 500s on every request. "Up" is not the question.
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/'\)/, "it must request the real route");
});

test("the governed reports path exists in the image without shipping its contents", () => {
  // The policy's rules name a reports/ path, so a rule describes a tree that
  // does not exist. The path must be created; the gauntlet's markdown must not
  // travel with it.
  assert.match(dockerfile, /mkdir -p [^\n]*\/app\/reports/);
  assert.match(dockerignore, /^reports\/$/m, "and its contents stay out of the context");
});

test("skills ship, SKILL.md and all", () => {
  // A blanket `*.md` exclusion looks harmless and strips every SKILL.md,
  // leaving a skills directory that exists and means nothing.
  assert.match(dockerfile, /COPY --chown=node:node skills \.\/skills/);
  assert.ok(!/^\*\.md$/m.test(dockerignore), "no blanket markdown exclusion; it would remove SKILL.md");
});

test("the Dockerfile states that it has never been built", () => {
  // Not a security control -- a truthfulness control. The precedent is the
  // `docker-ui-scaffold` branch, which recorded the same limitation and was
  // right to. A container file that reads as verified when no image exists is
  // the exact defect this repository keeps refusing to commit elsewhere.
  // These two read the PROSE, deliberately: the claim lives in the comments.
  assert.match(dockerfileProse, /NOT been built/i);
  assert.match(composeProse, /UNVERIFIED/i);
});
