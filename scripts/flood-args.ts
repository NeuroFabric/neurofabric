import { DEFAULT_PROVIDER, wedgeUrl } from "./dev-endpoints.ts";

/**
 * THE FLOOD ARGUMENT PARSER. Pure, exported, and importable on its own.
 *
 * === WHY IT IS ITS OWN MODULE AND NOT A FUNCTION IN THE GENERATOR ===
 *
 * The generator ends in a module-level dispatch: `if (argv.includes("--flood"))`
 * runs the flood, `else` runs `main()`. So importing it from a test **wrote a
 * CSV and ran a data generator as a side effect**. A parser cannot be tested in
 * the file that has a `main()` at import time, and the alternative — never
 * testing it — is how the parser shipped accepting one form of a flag.
 *
 * This module has no side effects at import. That is the whole requirement.
 *
 * === BOTH FLAG FORMS, AND WHY ===
 *
 * Only `--flag=value` was accepted, and `--flag value` failed in the worst
 * possible way: it bound the EMPTY STRING and then complained that no credential
 * had been supplied, on a command where one plainly had. In a live session the
 * observable failure was a policy guard firing on a correctly-typed value.
 *
 * **A syntax mistake must not present as a policy violation.** The operator's
 * next move after a guard fires is to argue with the guard, not to fix the
 * command, and the argument is unwinnable because the guard is right.
 */
export interface FloodOptions {
  readonly url: string;
  readonly gatewayToken: string;
  readonly provider: string;
  readonly events: number;
  readonly batch: number;
  readonly concurrency: number;
  readonly anomalyEvery: number;
  readonly seconds: number;
}

/** Parses a number, falling back rather than producing NaN. */
export function num(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The flags that take a value, declared as data.
 *
 * One list rather than three parallel ones, because the old parser's failure
 * mode was exactly a list drifting: a flag in the switch that nothing looked
 * ahead for would silently take no value. Adding a flag here is now sufficient.
 */
const STRING_FLAGS: ReadonlySet<string> = new Set(["--url", "--token", "--provider"]);

const NUMBER_FLAGS: readonly string[] = ["--events", "--batch", "--concurrency", "--anomaly-every", "--seconds"];

export function parseFloodArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FloodOptions {
  let url = wedgeUrl(undefined, env);
  let gatewayToken = env.WEDGE_GATEWAY_TOKEN ?? "";
  let provider = DEFAULT_PROVIDER;
  let events = 20_000;
  let batch = 250;
  let concurrency = 4;
  let anomalyEvery = 97;
  let seconds = 0;

  /**
   * Split one argument into key and value, looking ahead for the space form.
   *
   * Returns undefined for a bare positional, which is not an error -- these
   * arguments are all optional and a stray word is simply ignored, exactly as
   * before.
   */
  const readFlag = (index: number): { key: string; value: string; next: number } | undefined => {
    const raw = argv[index];
    if (raw === undefined || !raw.startsWith("-")) return undefined;
    const equals = raw.indexOf("=");
    if (equals >= 0) return { key: raw.slice(0, equals), value: raw.slice(equals + 1), next: index + 1 };

    // No `=` in the argument. A flag that takes no value is a bare switch; a flag
    // that does takes the NEXT argument, if there is one.
    const takesValue = STRING_FLAGS.has(raw) || NUMBER_FLAGS.includes(raw);
    if (!takesValue) return { key: raw, value: "", next: index + 1 };
    const following = argv[index + 1];
    if (following === undefined) {
      // A MISSING VALUE IS A SYNTAX ERROR NAMING THE FLAG. Not an empty value,
      // and not a default: the guard for an absent credential has to keep firing
      // on a command that genuinely had none, and it must fire on a SYNTAX
      // message when the command was simply typed wrong.
      throw new Error(`${raw} needs a value: use ${raw}=<value> or ${raw} <value>`);
    }
    return { key: raw, value: following, next: index + 2 };
  };

  const apply = (key: string, value: string): void => {
    if (key === "--url") url = value;
    else if (key === "--token") gatewayToken = value;
    else if (key === "--provider") provider = value;
    else if (key === "--events") events = num(value, events);
    else if (key === "--batch") batch = num(value, batch);
    else if (key === "--concurrency") concurrency = num(value, concurrency);
    else if (key === "--anomaly-every") anomalyEvery = num(value, anomalyEvery);
    else if (key === "--seconds") seconds = num(value, seconds);
    else throw new Error(`unknown option: ${key}`);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = readFlag(i);
    if (flag === undefined) continue;
    apply(flag.key, flag.value);
    i = flag.next - 1;
  }

  // A cap rather than a floor, and the caps are the SERVER's: an oversized body
  // is refused by the portal, which reads as a server fault rather than a
  // client one.
  batch = Math.min(1000, Math.max(1, Math.floor(batch)));
  concurrency = Math.min(32, Math.max(1, Math.floor(concurrency)));
  events = Math.max(1, Math.floor(events));
  anomalyEvery = Math.max(0, Math.floor(anomalyEvery));

  if (url.trim() === "") throw new Error("--url needs a base address");
  if (provider.trim() === "") throw new Error("--provider needs a name");
  if (gatewayToken.trim() === "") {
    // Named here rather than discovered as a wall of 401s, and NEVER defaulted: a
    // default credential is a credential everybody shares. The hint names both
    // syntaxes because the equals form was once the only one that worked, and a
    // person who typed the other one deserves to be told both are now fine.
    throw new Error(
      "--token (or $WEDGE_GATEWAY_TOKEN) is required: the ingress is credentialed. " +
        "Pass --token=<value> or --token <value>.",
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    gatewayToken,
    provider,
    events,
    batch,
    concurrency,
    anomalyEvery,
    seconds,
  };
}