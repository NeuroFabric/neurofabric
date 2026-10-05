/**
 * THE EMBASSY'S PROCESS ENTRY POINT.
 *
 * A separate file rather than a line in `main`, for one reason: `main` is imported
 * by tests and by anyone embedding the server in another process, and a module that
 * starts reading `process.stdin` on import is a module that cannot be imported.
 *
 * So this is the only file in the package that touches the real streams, and
 * `node --experimental-strip-types platform/embassy/bin.mjs` is the whole of the
 * documented way to run an embassy. Everything else takes its streams as parameters.
 */
import { main } from "./server.ts";

await main();