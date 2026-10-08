# THE COMMERCIAL WEDGE — TWO-STAGE BUILD
#
# STATUS: UNVERIFIED. This image has NOT been built. Docker is absent
# from the authoring environment, so every claim below is a claim about
# what the file says, not about an image that ran.
# Operator to run:
#     docker compose build && docker compose up
#
# ─── WHY TWO STAGES ────────────────────────────────────────────────────────────
#
# Stage 1 (builder) installs all dependencies including devDependencies, runs
# the Vite UI build, and compiles the TypeScript backend. Everything it touches
# is discarded after COPY --from=builder. Stage 2 (runtime) receives only the
# compiled artefacts — no build toolchain, no devDependencies, no source maps
# with full paths, no npm cache.
#
# The attack surface of the running image is therefore the platform/ module
# graph plus node:22-alpine's own packages, not the entire build toolchain.
# node:22-alpine is chosen for stage 2 (not -slim) because musl libc is
# lighter than glibc-slim and better-sqlite3's prebuilt binary ships for
# alpine. Stage 1 uses the same base so the Node major version is identical
# and --experimental-strip-types works in both.

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1 — BUILDER
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:22-alpine AS builder

LABEL org.opencontainers.image.description="Wedge builder stage — discarded after copy"

WORKDIR /build

# --- Backend dependencies ---
# Copy the root manifest first so Docker's layer cache is reused on subsequent
# builds when only source files change.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- UI dependencies ---
# The UI has its own manifest and lockfile. Copying them before the source
# gives the same cache benefit.
COPY platform/ui/package.json platform/ui/package-lock.json ./platform/ui/
RUN npm ci --prefix platform/ui --ignore-scripts

# --- Source ---
COPY platform ./platform
COPY configs ./configs
COPY .pi ./.pi
COPY start-ui.mjs ./

# --- Build the React/Vite UI ---
# `npm run build` in platform/ui runs `tsc -b && vite build`, producing
# platform/ui/dist/ with the compiled, hashed assets. The backend serves this
# directory as static files via the react-app-harness route.
RUN npm run build --prefix platform/ui

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2 — RUNTIME
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:22-alpine AS runtime

# THE LABEL IS NOT DECORATIVE. It names the account the process runs as, so
# that `docker inspect` answers the question an auditor actually asks —
# "what does this thing run as?" — without reading the filesystem.
LABEL org.opencontainers.image.title="neurofebric wedge" \
      org.opencontainers.image.description="Governed, read-only analytical reports over local data files" \
      org.opencontainers.image.source="https://gitlab.com/neurofebric-group/neurofebric"

# WORKSPACE AND GOVERNED PATHS, CREATED BEFORE THE USER SWITCH, OWNED BY THEM.
#
# Order matters. `USER node` comes AFTER the chown, because a chown by a
# non-root user on a root-owned directory fails, and a container that fails
# to start is a container nobody debugs.
#
# /app/workspace  the ONLY place the process may read data from, mounted at
#                 run time as a named volume.
# /app/reports    named by the policy's own rules; must exist even if empty.
# /app/gate.db    parent directory for the SQLite audit ledger volume.
RUN mkdir -p /app/workspace /app/reports /app/gate-data \
    && chown -R node:node /app/workspace /app/reports /app/gate-data

# NON-ROOT, AND IT IS THE ONLY USER THAT EVER EXISTS FOR THE RUNTIME.
#
# The `node` user ships in the base image (uid 1000). A process that can read
# the user's data files has no business running as uid 0, where a container
# escape starts. There is no code path below that switches back.
USER node
WORKDIR /app

# --- Runtime dependencies only (no devDependencies) ---
# better-sqlite3 is a native addon and must be present at runtime. Everything
# else the platform/ graph imports is either node: stdlib or pure TypeScript
# that --experimental-strip-types handles. Installing with --omit=dev keeps
# the toolchain (typescript, vite, vitest, …) out of the image.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# --- Compiled artefacts from the builder stage ---
# platform/ui/dist/ contains the compiled React app. The backend serves it
# from this path; nothing else in platform/ui/ is needed at runtime.
COPY --from=builder --chown=node:node /build/platform ./platform
COPY --from=builder --chown=node:node /build/platform/ui/dist ./platform/ui/dist
COPY --from=builder --chown=node:node /build/configs ./configs
COPY --from=builder --chown=node:node /build/.pi ./.pi
COPY --chown=node:node skills ./skills
COPY --from=builder --chown=node:node /build/start-ui.mjs ./

# THE BOUNDARY IS THE MOUNT, DECLARED HERE AND NOT ONLY IN COMPOSE.
#
# `--workspace /app/workspace` means the data boundary is the mounted volume
# and nothing else. Anyone running this image by hand — without compose,
# without reading the compose file — still gets the same containment.
ENV WEDGE_WORKSPACE=/app/workspace \
    NODE_ENV=production

EXPOSE 8080

# === THE GARBAGE COLLECTION FLAGS ===
#
#   --max-old-space-size=256   The heap this process may keep. The engine is
#     designed for FLAT-MEMORY STREAMING: csvRead retains a bounded window and
#     the broker keeps per-partition reservoirs, so steady-state live memory is
#     a function of the window, not of the file. Without a cap "bounded" is a
#     property of the code; with it the ceiling is visible in the image config.
#   --max-semi-space-size=2    Streaming is a high allocation-rate workload
#     with a tiny survivor set. Doubling the semi-space halves the scavenge
#     count for 2 MiB more of resident heap.
#
# WHY 256 AND NOT 512: the container limit is 512 MiB, and the heap is only
# part of a process. Code space, the native allocator, socket buffers, and V8's
# own metadata live outside the old generation, so a 512 MiB heap inside a
# 512 MiB container is an OOM kill that arrives before the heap cap fires.
# Half the limit leaves room for the parts that are not heap. That relationship
# is asserted in docker-compose.yml's comments; changing one without the other
# is visible.
CMD ["node", \
     "--max-old-space-size=256", \
     "--max-semi-space-size=2", \
     "--experimental-strip-types", \
     "start-ui.mjs", \
     "--workspace", "/app/workspace", \
     "--port", "8080", \
     "--host", "0.0.0.0"]
