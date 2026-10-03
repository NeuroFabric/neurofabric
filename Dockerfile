# THE COMMERCIAL WEDGE, CONTAINERISED.
#
# STATUS, STATED PLAINLY: this image has NOT been built. Docker is not available
# in the authoring environment, so every claim below is a claim about what the
# file says, not about an image that ran. The earlier `docker-ui-scaffold`
# branch recorded the same limitation honestly and that is the precedent worth
# following: an unverified container claimed as verified is worse than no
# container, because it stops anyone looking. Operator to run:
#     docker compose build && docker compose up
#
# node:22-slim because the host toolchain is v22 and `--experimental-strip-types`
# is what runs the TypeScript suites and the boot script. A major-version
# mismatch here is a suite that cannot start.

FROM node:22-slim

# THE LABEL IS NOT DECORATIVE. It names the account the process runs as, so that
# `docker inspect` answers the question an auditor actually asks -- "what does
# this thing run as?" -- without reading the filesystem.
LABEL org.opencontainers.image.title="neurofebric wedge" \
      org.opencontainers.image.description="Governed, read-only analytical reports over local data files" \
      org.opencontainers.image.source="https://gitlab.com/neurofebric-group/neurofebric"

# WORKSPACE AND GOVERNED PATHS, CREATED BEFORE THE USER SWITCH, OWNED BY THEM.
#
# The order matters. `USER node` comes AFTER the chown, because a chown by a
# non-root user on a root-owned directory fails, and a container that fails to
# start is a container nobody debugs.
#
# Two directories, two different reasons:
#   /app/workspace  the ONLY place the process may read data from, mounted over
#                   at run time
#   /app/reports    a governed path in the policy's own rules. Those rules
#                   describe a tree, and a rule that names a path which does not
#                   exist is a rule describing something other than what is on
#                   disk. Created EMPTY on purpose: the repository's reports/
#                   holds the gauntlet's own markdown artifacts, which are test
#                   output, not runtime data, and .dockerignore keeps them out of
#                   the context. So the path exists and none of its contents
#                   ship.
RUN mkdir -p /app/workspace /app/reports && chown -R node:node /app/workspace /app/reports

# NON-ROOT, AND IT IS THE ONLY USER THAT EVER EXISTS FOR THE RUNTIME.
#
# The `node` user ships in the base image (uid 1000). This is the whole
# privilege story: a process that can read the user's data files and write
# reports has no business running as uid 0, where a container escape starts.
# There is no code path below that switches back.
USER node
WORKDIR /app

# NO `npm install`. The platform has ZERO runtime dependencies (D-018) and
# nothing under platform/ imports anything outside node's own stdlib, so the
# serving image ships with no node_modules at all.
#
# This is a security property as much as a size one: an image with no installed
# packages has no third-party code to be compromised, no lockfile to drift, and
# no supply chain between this repository and what executes. The earlier
# test-container scaffold on `docker-ui-scaffold` DOES install devDependencies,
# correctly, because `npm test` runs `tsc`. A serving image has no reason to.
#
# Only the manifest is copied, and only so that `npm` metadata and the
# `type: module` field travel with the code.
COPY --chown=node:node package.json ./

# THE CODE, AND ONLY THE CODE.
#
# These four directories are the runtime dependency set, established by reading
# the imports rather than by copying the repository and deleting things. The
# earlier test-container scaffold on `docker-ui-scaffold` found the hard way
# that this is not guessable: it omitted `.pi` and `skills`, and its own gate
# failed because the suite reads them off the filesystem.
#   platform/  every module the server imports
#   configs/   default-schemas.json, resolved via installRoot
#   .pi/       the policy, which core/project-config.ts resolves at startup
#   skills/    the product's own skills, including SKILL.md, which is why no
#              blanket "exclude *.md" rule appears in .dockerignore
COPY --chown=node:node platform ./platform
COPY --chown=node:node configs ./configs
COPY --chown=node:node .pi ./.pi
COPY --chown=node:node skills ./skills

COPY --chown=node:node start-ui.mjs ./

# THE BOUNDARY IS THE MOUNT, DECLARED HERE AND NOT ONLY IN COMPOSE.
#
# `--workspace /app/workspace` means the data boundary is the mounted volume and
# nothing else. Anyone running this image by hand -- without compose, without
# reading the compose file -- still gets the same containment, which is the
# point of putting it in the image rather than only in orchestration.
ENV WEDGE_WORKSPACE=/app/workspace \
    NODE_ENV=production

EXPOSE 3000

# 0.0.0.0, and this is the ONE place the loopback default is deliberately
# widened. Inside a container a loopback bind is unreachable from the host:
# Docker publishes to the container's own interface, not its loopback, so a
# loopback bind produces a wedge that starts and then refuses every connection.
#
# It is safe here because of what surrounds it, not because of this line:
#   - the compose file publishes to 127.0.0.1 on the HOST, so the reachable
#     surface is the same loopback address as running it directly;
#   - the container's network namespace is the isolation;
#   - a widened bind prints a warning at startup, so it is never silent.
# The default in platform/web/server.ts is unchanged and is pinned by test.
#
# === THE GARBAGE COLLECTION FLAGS ===
#
# Appended, not substituted: the flags ahead of the script name tune V8, and the
# script, its arguments and the widened bind are unchanged from the line above.
#
#   --max-old-space-size=256   The heap this process may keep. The engine is
#     designed for FLAT-MEMORY STREAMING: `csvRead` retains a bounded window and
#     the broker keeps per-partition reservoirs, so steady-state live memory is
#     a function of the window, not of the file. Without a cap, "bounded" is a
#     property of the code and a deployment with a large file finds out
#     otherwise; with it, the ceiling is visible in the image config rather than
#     discovered on a host that no longer exists.
#   --max-semi-space-size=2    The young generation. Streaming is a high
#     ALLOCATION-RATE workload with a tiny survivor set, which is the shape that
#     scavenges constantly. Doubling the semi-space halves the scavenge count for
#     2 MiB more of resident heap.
#
# WHY 256 AND NOT 512: the container limit is 512 MiB, and the heap is only part
# of a process. Code space, the native allocator, socket buffers, and V8's own
# metadata live outside the old generation, so a 512 MiB heap inside a 512 MiB
# container is an OOM kill that arrives before the heap cap ever fires, and it
# arrives as the kernel killing the process rather than as V8 saying anything.
# Half the limit leaves room for the parts that are not heap. That relationship
# is asserted in docker-compose.yml's comments, so changing one number without
# the other is visible.
#
# WHAT IS *NOT* CLAIMED: these values are not benchmarked. Docker is unavailable
# in the authoring environment and no load test was run against them, so this is
# a documented default chosen for a known access pattern, not a measured optimum.
# The failure direction is deliberate -- too small is an OOM kill that is loud,
# too large is an OOM kill on the host that is quieter. If a deployment needs
# more, `docker-compose.yml` exposes the same command so it can be raised without
# a rebuild.
CMD ["node", "--max-old-space-size=256", "--max-semi-space-size=2", "--experimental-strip-types", "start-ui.mjs", "--workspace", "/app/workspace", "--port", "3000", "--host", "0.0.0.0"]
