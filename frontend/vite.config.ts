import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * THE COMMAND CENTER'S BUILD AND TEST CONFIGURATION.
 *
 * `defineConfig` comes from `vitest/config`, not from `vite`. Both export the same
 * function, but only the vitest one widens the return type to accept the `test`
 * block below. Importing from `vite` and then writing `test:` is a type error
 * that is genuinely confusing, because the property is real and does run.
 *
 * TEST ENVIRONMENT IS `node`, AND THAT IS A CHOICE NOT AN OMISSION.
 *
 * Everything under test so far -- the gateway client and the schema store -- is
 * pure logic: fetch, JSON parsing, a subscription list. None of it touches the
 * DOM. Running under `node` rather than `jsdom` therefore costs nothing today and
 * saves installing and booting a second DOM implementation for no benefit. When
 * the visual components arrive in the next micro-step and a test genuinely needs
 * a document, this changes to `jsdom` (or `happy-dom`) in ONE place, with the
 * dependency added at the moment it is first needed rather than speculatively.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Loopback only, matching the wedge's own default bind (start-ui.mjs).
    // A dev server reachable on every interface publishes an authenticated API
    // client to the network by accident.
    host: "127.0.0.1",
    proxy: {
      // The portal routes are served under /api/portal/*. Proxying keeps the
      // browser same-origin, so the credential header never has to survive a
      // cross-origin preflight in development.
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },

  build: {
    // Relative base so `dist/` can be served from a subpath by the wedge's
    // static handler without a rebuild per mount point.
    outDir: "dist",
    sourcemap: true,
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Explicit imports, not ambient globals -- see tsconfig.json.
    globals: false,
  },
});