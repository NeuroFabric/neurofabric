import { normaliseToken } from "./stream-harness.ts";

/**
 * FORMAT PARSERS: SAST and DAST output, read one record at a time.
 *
 * === WHY EVERY PARSER HERE IS LINE-ORIENTED ===
 *
 * SARIF is specified as a JSON *document* and ZAP as an XML *document*, and both
 * are routinely shipped as a single blob. Parsing either as a blob means holding
 * it, which for a CI log that is a gigabyte is the whole memory story of the
 * product decided by a file format.
 *
 * So this module reads the STREAMED shapes, which both tools actually emit:
 *   - SARIF Results as JSON Lines: one result object per line.
 *   - ZAP's XML report, scanned by an incremental tag state machine, emitting an
 *     alert at its closing tag.
 *
 * And where a caller genuinely has a single-document file, the honest answer is
 * that it must be split before it reaches here. `sarifDocumentNeedsSplitting` and
 * the XML scanner's own behaviour say so rather than pretending a document can be
 * streamed without an incremental parser, because the alternative -- quietly
 * accumulating a document until it is complete -- is the exact failure this
 * platform has spent its history avoiding.
 */

/** The maximum field value retained from an XML alert. Desc fields run to pages. */
const MAX_FIELD_CHARS = 512;
/** The maximum open XML tags tracked at once. Deeper than this is not an alert list. */
const MAX_OPEN_ELEMENTS = 64;

export type Severity = "info" | "warning" | "critical";

/** ONE FINDING, NORMALISED. Every parser produces this and nothing else. */
export interface ParsedFinding {
  readonly severity: Severity;
  /** Stable identifier: a SARIF rule id, a ZAP plugin id, or a synthetic one. */
  readonly rule: string;
  readonly message: string;
  /** Where. Optional, because a build-time SAST finding may name no location. */
  readonly location?: string;
  /** The line as it arrived, truncated. Evidence, not re-derivable from the above. */
  readonly evidence: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_FIELD_CHARS) return text;
  // Marked rather than silently cut: a reader needs to know the evidence is
  // partial, because an unqualified truncation is a quiet lie about the record.
  return `${text.slice(0, MAX_FIELD_CHARS)}...[truncated ${text.length - MAX_FIELD_CHARS} chars]`;
}

/**
 * SARIF `level` and ZAP `riskcode` BOTH onto our three severities.
 *
 * The mapping is a single function because two mappings that disagree is how a
 * report ends up saying "critical" for two different things. ZAP's codes are
 * 0 informational, 1 low, 2 medium, 3 high; there is no critical in ZAP, and
 * high is mapped to critical rather than to warning because a high-confidence
 * SQL injection is not a medium finding.
 */
export function severityFromSarifLevel(level: unknown): Severity | undefined {
  const value = normaliseToken(String(level ?? ""));
  if (value === "error" || value === "critical" || value === "high") return "critical";
  if (value === "warning" || value === "warn" || value === "medium") return "warning";
  if (value === "note" || value === "none" || value === "info" || value === "low") return "info";
  return undefined;
}

export function severityFromRiskCode(code: unknown): Severity | undefined {
  const value = Number.parseInt(String(code ?? "").trim(), 10);
  if (Number.isNaN(value)) return undefined;
  // ZAP: 3 high, 2 medium, 1 low, 0 informational. Low maps to warning rather
  // than to info because a confirmed low is still a confirmed finding, and
  // reserving "info" for informational keeps "no findings" unambiguous.
  if (value >= 3) return "critical";
  if (value >= 1) return "warning";
  if (value === 0) return "info";
  return undefined;
}

/**
 * PARSE ONE LINE OF SARIF Results-as-JSON-Lines.
 *
 * Returns undefined for a line that is not a SARIF result, rather than throwing.
 * A log stream interleaves build output, timestamps and progress bars with the
 * findings, so a parser that insists every line is JSON is a parser that dies on
 * the first progress bar -- and an agent that dies mid-scan reports nothing at all,
 * which is worse than reporting the subset it understood.
 */
export function parseSarifLine(line: string): ParsedFinding | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  // A SARIF result is identified by carrying a ruleId OR a level. Requiring both
  // would reject results with no rule, which is legal; requiring neither would
  // accept every JSON line in the stream.
  const hasRule = typeof record.ruleId === "string";
  if (!hasRule && record.level === undefined) return undefined;

  const properties = typeof record.properties === "object" && record.properties !== null
    ? (record.properties as Record<string, unknown>)
    : {};
  // An explicit severity in `properties` outranks the coarse `level`, because a
  // tool that bothered to say "high" meant it.
  const severity = severityFromSarifLevel(properties.severity) ?? severityFromSarifLevel(record.level) ?? "info";

  const message = readSarifMessage(record.message);
  const location = readSarifLocation(record.locations);

  const finding: ParsedFinding = {
    severity,
    // The narrowing is repeated here rather than reusing `hasRule`: a boolean
    // flag records THAT the field was a string, not that the field is one, and
    // the value is still `unknown` to the type checker.
    rule: typeof record.ruleId === "string" ? record.ruleId : "sarif:unattributed",
    message: truncate(message),
    ...(location === undefined ? {} : { location }),
    evidence: truncate(trimmed),
  };
  return finding;
}

function readSarifMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (typeof message === "object" && message !== null) {
    const text = (message as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return "no message";
}

function readSarifLocation(locations: unknown): string | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const first = locations[0];
  if (typeof first !== "object" || first === null) return undefined;
  const physical = (first as Record<string, unknown>).physicalLocation;
  if (typeof physical !== "object" || physical === null) return undefined;

  const artifact = (physical as Record<string, unknown>).artifactLocation;
  const uri = typeof artifact === "object" && artifact !== null
    ? (artifact as Record<string, unknown>).uri
    : undefined;
  if (typeof uri !== "string" || uri === "") return undefined;

  const region = (physical as Record<string, unknown>).region;
  const startLine = typeof region === "object" && region !== null
    ? (region as Record<string, unknown>).startLine
    : undefined;
  return typeof startLine === "number" ? `${uri}:${startLine}` : uri;
}

/**
 * A ZAP XML REPORT, READ INCREMENTALLY.
 *
 * A state machine over lines rather than a parser over a string, because the
 * report is one document and the document is the thing we refuse to hold. State
 * is: the element currently open, and the fields of the ONE alert being
 * assembled. When `</alert>` arrives the alert is emitted and the buffer is
 * cleared -- so peak memory is the largest single alert's fields, not the
 * largest report.
 *
 * Two things are bounded that a naive scanner would not bound:
 *   - field values are truncated, because ZAP `desc` runs to pages and one alert
 *     can otherwise be larger than the whole line ceiling;
 *   - the open-element depth is capped, so a malformed document with thousands of
 *     unclosed tags cannot grow a stack without limit. Exceeding the cap drops
 *     the current alert and counts it, rather than desynchronising silently.
 */
export class ZapXmlScanner {
  private current: Record<string, string> | undefined;
  private inAlert = false;
  /**
   * The open element names, innermost last.
   *
   * A stack rather than a counter, and the reason is ZAP's own shape: `<alert>` is
   * BOTH the container element AND one of its fields, so a report reads
   * `<alert>...<alert>SQL Injection</alert>...</alert>`. A scanner that watches
   * for the tag name alone emits on the INNER close and every finding it produces
   * is a fragment. Depth cannot disambiguate that; the nesting can.
   */
  private stack: string[] = [];
  private dropped = 0;
  private alerts = 0;

  /** Alerts abandoned because their depth exceeded the cap, and not parsed. */
  get droppedAlerts(): number {
    return this.dropped;
  }

  get alertsEmitted(): number {
    return this.alerts;
  }

  /**
   * Feed one line. Returns a finding when the line CLOSED an alert.
   *
   * Every tag in the line is walked in document order, not just the first of each
   * kind: a ZAP alert is normally written on ONE line with eight tags in it, and
   * a scanner that looked only at the first open and the first close tag would
   * read one field per alert.
   */
  push(line: string): ParsedFinding | undefined {
    // Tag extraction without an XML parser: this is not general XML, it is one
    // known report shape, and a general parser would need a dependency the
    // platform does not have (D-018) or a hand-rolled one that is worse.
    const tags = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let match: RegExpExecArray | null;

    while ((match = tags.exec(line)) !== null) {
      const closing = match[1] === "/";
      const name = match[2]!.toLowerCase();
      if (match[4] === "/") continue; // self-closing: no value, no children

      if (!closing) {
        if (this.stack.length >= MAX_OPEN_ELEMENTS) {
          // Bounded depth. Dropping the alert and resynchronising is better than
          // growing a stack for a malformed document, and the drop is counted.
          this.dropped += 1;
          this.reset();
          return undefined;
        }
        // A leaf value is the text between this tag and its own closing tag.
        this.capture(name, line, match.index + match[0].length);
        if (name === "alert" && !this.inAlert) {
          this.inAlert = true;
          this.current = {};
        }
        this.stack.push(name);
        continue;
      }

      const at = this.stack.lastIndexOf(name);
      if (at === -1) continue; // a stray close tag: ignore rather than desync
      this.stack.length = at;
      // Emit only when the alert CONTAINER closes, which is the close that leaves
      // no `alert` still open. The inner field's close leaves one behind.
      if (name === "alert" && this.inAlert && !this.stack.includes("alert")) {
        const finding = this.emit();
        this.inAlert = false;
        this.current = undefined;
        return finding;
      }
    }
    return undefined;
  }

  /** Call at end of stream, for a report whose last `</alert>` was never written. */
  flush(): ParsedFinding | undefined {
    if (!this.inAlert || this.current === undefined) return undefined;
    const finding = this.emit();
    this.reset();
    return finding;
  }

  private reset(): void {
    this.inAlert = false;
    this.current = undefined;
    this.stack = [];
  }

  /**
   * Record a leaf value, if this element is one.
   *
   * "Leaf" means the very next tag in the line closes it. A container's text is
   * markup, not a value, and storing it would put `<pluginid>10021</pluginid>` in
   * a field called `alert`.
   */
  private capture(name: string, line: string, from: number): void {
    if (this.current === undefined || this.current[name] !== undefined) return;
    const next = line.indexOf("<", from);
    if (next === -1) return; // no closing tag on this line
    const between = line.slice(from, next);
    // The next tag must be THIS element's close. Anything else means the element
    // is a container and its "value" is markup, which must not be stored: putting
    // `<pluginid>10021</pluginid>` into a field called `alert` is how a scanner
    // produces findings nobody can read.
    const closer = new RegExp(`^</${name}\\s*>`).exec(line.slice(next));
    if (closer === null) return;
    this.current[name] = truncate(between.trim());
  }

  private emit(): ParsedFinding | undefined {
    const fields = this.current;
    if (fields === undefined) return undefined;
    this.alerts += 1;

    const severity = severityFromRiskCode(fields.riskcode) ?? "warning";
    const rule = fields.pluginid === undefined ? "zap:unattributed" : `zap:${fields.pluginid}`;
    const message = fields.alert ?? fields.desc ?? "no description";
    const location = fields.uri ?? fields.param;

    return {
      severity,
      rule,
      message: truncate(message),
      ...(location === undefined ? {} : { location: truncate(location) }),
      evidence: truncate(`riskcode=${fields.riskcode ?? "?"} pluginid=${fields.pluginid ?? "?"} alert=${fields.alert ?? "?"}`),
    };
  }
}

/**
 * DOES THIS LOOK LIKE A WHOLE SARIF DOCUMENT RATHER THAN A RESULT LINE?
 *
 * Published so a caller holding one big file can be told, at the point of
 * handing it over, that it will not be read as a stream -- instead of watching
 * the agent silently find no results and report a clean pipeline.
 */
export function sarifDocumentNeedsSplitting(firstKilobyte: string): boolean {
  return /^\s*\{[\s\S]*"\$schema"/.test(firstKilobyte) || /^\s*\{\s*"version"\s*:\s*2/.test(firstKilobyte);
}
