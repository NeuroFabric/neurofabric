/// <reference types="vite/client" />

/**
 * VITE ENVIRONMENT TYPING.
 *
 * `tsconfig.json` sets `types: []`, which keeps ambient `@types` packages out of
 * the program -- node's types must not leak into browser code, or a
 * `process.env` reference in a component would typecheck and then fail at
 * runtime in a bundle that has no `process`. That is why Vite's client types are
 * pulled in HERE, by name, rather than globally.
 *
 * `VITE_GATEWAY_TOKEN` is declared rather than cast at the use site, so a typo
 * in the variable name is a compile error instead of a silent `undefined` that
 * turns into "no credential" at boot.
 */
interface ImportMetaEnv {
  /** Issued by the sign-in step, never committed. */
  readonly VITE_GATEWAY_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}