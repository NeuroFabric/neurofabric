import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * TEMP-DIRECTORY TEST HELPERS, shared.
 *
 * Both of these were discovered the hard way, by a test that passed for the
 * wrong reason, and they are here so the next person does not rediscover them.
 *
 * `realpath`. `os.tmpdir()` returns the 8.3 SHORT form on Windows
 * (`RISHAB~1`) while the kernel reports the RESOLVED long form. A path built
 * locally and a path handed back by the code under test are then two different
 * strings for one file. The dangerous half is not the spurious failure, it is
 * the vacuous pass: a "this file does NOT exist" assertion built on the short
 * form is false forever and would pass even if the file were written.
 *
 * `stat`, not `access`. On this host `access()` does not report a file that
 * `readdir()` plainly lists. An existence check written on `access()` therefore
 * reports false negatives, which for a negative assertion again means a test
 * that cannot fail. `stat()` is what both the listing and the write actually
 * agree with.
 *
 * Neither of these is a style preference. Each one turns a real assertion into
 * a vacuous one.
 */

/**
 * A temp directory, already resolved to its canonical form.
 *
 * Write the fixtures you need into it before handing it to code under test.
 */
export async function makeTempWorkspace(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Write a text fixture into a workspace. Returns its full path. */
export async function writeFixture(dir: string, name: string, contents: string): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, contents, "utf8");
  return target;
}

/**
 * Whether a path exists, judged by `stat`.
 *
 * A negative assertion using this is only meaningful if the matching positive
 * one has been shown to work on the same path form -- which is why the
 * workspaces above are `realpath`ed rather than left as `mkdtemp` returned them.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}