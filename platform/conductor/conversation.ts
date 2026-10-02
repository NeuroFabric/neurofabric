import { parseCorrection, type ParsedCorrection } from "../web/chat-parse.ts";
import { resolveQuery } from "./query.ts";
import { findCrossColumnAnomalies, type CrossColumnAnomaly } from "./multivariate.ts";
import { route } from "./agent-router.ts";
import { barWidget, findingsWidget, lineWidget, type Widget } from "./subagents/widgets.ts";
import { adaptiveSuggestions } from "./subagents/suggestions.ts";
import type { Purpose } from "./semantics.ts";

/**
 * THE CONVERSATION. A sentence in, an answer out.
 *
 * === WHY THE CHAT IS A FUNCTION AND NOT A PAGE ===
 *
 * The conversation is the product now, so the decision of what a sentence MEANS
 * cannot live inside a string that only a browser ever reads. There would be no
 * way to test it except by shipping it and looking at it -- which is exactly how
 * the last two releases shipped a dashboard nobody could open and a chart that
 * returned 404, with every test green.
 *
 * So: data in, reply out, pure, tested in Node. The React page is a thin
 * renderer over what this returns.
 *
 * === WHAT IT IS NOT, STATED PLAINLY AND IN THE SOURCE ===
 *
 * **This is not a language model.** It is a deterministic intent router over an
 * analysis the engine has already computed. That is a real and useful thing --
 * "show me the worst hour" genuinely returns the worst hour, from the engine's
 * own numbers -- and it is what can be built and verified without inventing an
 * API key or pretending a regular expression is intelligence.
 *
 * The honest consequence: it does not answer arbitrary questions about the
 * data. It routes what it recognises, declines the rest, and NEVER invents a
 * figure. A question it cannot answer gets no widget at all, because a widget
 * is a number and there is no number to give.
 *
 * This module is exactly the tool surface a language model would call, so that
 * is where one would slot in. Claiming to be one today would be a claim this
 * repository does not make anywhere else.
 */

/** What the interface is given, once, when the conversation opens. */
export interface ConversationData {
  /**
   * The engine's projection, when it produced one.
   *
   * Present so the CONDUCTOR can route a forward-looking question to the
   * forecasting agent. Optional because forecasting legitimately refuses across a
   * gap in the timeline, and an agent asked about a projection that does not
   * exist must give the engine's reason rather than a bare "no".
   */
  readonly forecast?: {
    readonly ok: boolean;
    readonly method: string;
    readonly points: readonly {
      readonly hour: string; readonly value: number; readonly lower: number; readonly upper: number;
    }[];
    readonly explanation: string;
    readonly reason: string | null;
    readonly lastObservedHour: string | null;
  } | null;
  readonly source: string | null;
  readonly totalRows: number;
  readonly purpose: Purpose;
  readonly columns: readonly {
    readonly name: string;
    readonly mean: number | null;
    readonly min: number | null;
    readonly max: number | null;
    readonly measured: number;
    readonly dirty: number;
    readonly empty: number;
    /**
     * Bucketed distribution, so the agent can COUNT rather than only route.
     *
     * Optional because it is genuinely absent for a column with no measurable
     * values, and a resolver that assumed it was there would answer a range
     * question from an empty array and report zero rows -- the worst possible
     * failure, because it looks like an answer.
     */
    readonly histogram?: readonly { lo: number; hi: number; count: number }[];
  }[];
  readonly anomalies: readonly {
    readonly column: string;
    readonly severity: "critical" | "warning" | "info";
    readonly kind: string;
    readonly detail: string;
    readonly factor: number | null;
  }[];
  readonly ranking: readonly { readonly key: string; count: number }[];
  readonly timeline: readonly {
    readonly hour: string;
    readonly count: number;
    readonly share: number;
    readonly multiple: number | null;
    readonly spike: boolean;
    readonly rule: string | null;
  }[];
  readonly learned: Readonly<Record<string, string>>;
  /**
   * The rows, for the questions that cannot be answered from a summary.
   *
   * Optional, and the reason is the same as `columns[].histogram`: a caller that
   * has not wired it must get an honest "I cannot check that", never a
   * fabricated "no anomalies". Answering "nothing found" from data that was
   * never examined is the one failure this product must not make -- it reads as
   * a clean bill of health for a file nobody looked at.
   */
  readonly rows?: readonly Record<string, unknown>[];
}

/**
 * A widget. DATA, NEVER MARKUP.
 *
 * This is the discipline the whole pivot rests on. A widget carrying
 * pre-rendered HTML would put an untrusted-data path straight back into the
 * chat -- on the surface that now touches every column name in the file, which
 * is a value a user dropped and this product exists to read. So a widget is a
 * discriminant plus a payload, and the renderer owns all the markup.
 */
/**
 * RE-EXPORTED, NOT REDECLARED.
 *
 * The interface used to be defined here because this module used to build every
 * widget itself. It does not any more -- the subagents do -- and a second
 * structurally identical declaration is a type error rather than a duplicate.
 * Re-exporting keeps every existing import path working, so sharing the
 * definition costs no caller a change.
 */
export type { Widget } from "./subagents/widgets.ts";

export interface Reply {
  readonly kind: "answer" | "correction";
  /** What the agent says. Always a sentence addressed to a person. */
  readonly text: string;
  readonly widgets: readonly Widget[];
  /** Clickable follow-ups. Never empty on a decline -- a user must not be stuck. */
  readonly suggestions: readonly string[];
  /** Set only when a correction was parsed AND accepted. */
  readonly correction?: { readonly column: string; readonly role: string };
}

/**
 * WHAT THE AGENT CAN DO, IN ITS OWN WORDS.
 *
 * Exported so the interface cannot advertise something the router does not
 * implement. That drift is easy -- a help list is written once and the router
 * grows separately -- and the symptom is a button that produces a refusal.
 */
export const CAPABILITIES: readonly { readonly label: string; readonly ask: string }[] = [
  { label: "Show me the worst hour", ask: "show me the worst hour" },
  { label: "What are the biggest categories?", ask: "what are the top categories" },
  { label: "What is wrong with this file?", ask: "what is wrong with this file" },
  { label: "How did you read the columns?", ask: "how did you read the columns" },
  { label: "Show me the column statistics", ask: "show me the columns" },
];

/**
 * THE CHIPS, BUILT FROM WHAT THE FILE CAN ACTUALLY ANSWER.
 *
 * Five fixed chips sat under every answer, including the ones that could not
 * possibly apply: "show me the worst hour" on a file with no readable
 * timestamps, "what are the top categories" on a file with no categorical
 * column. A suggestion is an INVITATION, and an invitation to ask a question
 * that is guaranteed to be refused teaches the user that the suggestions are
 * noise -- which is the fastest way to make nobody click anything again.
 *
 * So each chip is offered only when the data behind it exists. Ordering is by
 * how much the question is worth asking on THIS file: findings first when there
 * are findings, then the shape, then the mechanics. `answered` drops whatever
 * the user just clicked, because re-suggesting the question they already asked
 * is the clearest possible evidence that nothing is paying attention.
 *
 * This NEVER changes what the agent answers. It only changes what it offers. A
 * question with no chip is still answered, and a test pins that, because the
 * day the chips become a gate the refusal this phase removed comes straight
 * back through the suggestions instead of the router.
 */
function adaptiveSuggestionsRemoved(data: ConversationData, answered = ""): readonly string[] {
  // MOVED TO subagents/suggestions.ts. Kept as a symbol only so any remaining
  // caller resolves; the body is deleted below.
  return adaptiveSuggestions(data, answered);
}

/** `nl` is the only number this module is willing to invent. */
function rows(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * THE OPENING MESSAGE.
 *
 * It leads with WHAT THE FILE IS, because that is the thing the engine knows
 * that the user does not yet know, and it is the whole reason to have a
 * semantic profiler. Then how much was read, then what was found, then an
 * invitation -- because a statement with no question at the end of it is a
 * lecture, and the user has to know they are allowed to speak.
 *
 * The hedging is not decoration. `appears to be` and `This file IS` are different
 * claims, and the difference is precisely what `confidence` encodes. A low
 * confidence reading says so in words rather than in a badge nobody reads.
 */
export function greet(data: ConversationData): Reply {
  const severe = data.anomalies.filter((a) => a.severity === "critical").length;
  const total = data.anomalies.length;
  const file = data.source ? ` (${data.source})` : "";

  // === THE HONEST GREETING, FOR A FILE IT CANNOT PLACE ===
  if (data.purpose.kind === "unknown") {
    return {
      kind: "answer",
      text: `I read ${rows(data.totalRows)} rows${file}. Looking at the column names, I cannot tell what this file is for, ` +
        "so I will not guess. Tell me what it is and I will read it that way. " +
        (total === 0
          ? "Nothing in it looks malformed."
          : `I did find ${rows(total)} thing${total === 1 ? "" : "s"} worth looking at.`),
      widgets: [],
      suggestions: CAPABILITIES.slice(0, 3).map((c) => c.ask),
    };
  }

  const opening = data.purpose.confidence === "high"
    ? `${data.purpose.statement}`
    : `${data.purpose.statement} Based on the column names, so treat it as a first reading.`;

  const found = total === 0
    ? "There is nothing to flag -- every column is clean by the engine's own thresholds."
    : severe > 0
      ? `I found ${rows(severe)} severe anomal${severe === 1 ? "y" : "ies"} and ${rows(total - severe)} other finding${total === 1 ? "" : "s"}.`
      : `I found ${rows(total)} finding${total === 1 ? "" : "s"}, none of them severe.`;

  return {
    kind: "answer",
    text: `I read ${rows(data.totalRows)} rows${file}. ${opening} ${found} What would you like to know about this data?`,
    widgets: [
      {
        kind: "findings",
        title: "First look",
        note: severe > 0 ? "Severe findings first." : "Nothing severe; here is everything.",
        payload: { anomalies: data.anomalies.slice(0, 5) },
      },
    ],
    suggestions: CAPABILITIES.map((c) => c.ask),
  };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

// THE WIDGET BUILDERS ARE IN subagents/widgets.ts.
//
// They were defined here for as long as this module built every answer itself.
// The conductor now delegates to three subagents that each need them, and three
// copies of "what a bar chart is" is three definitions -- one of which would
// have capped at five bars and another at ten, and the tests would have had to
// pick a winner. The shared module owns the cap and the shape.

/**
 * Route one sentence.
 *
 * ORDER MATTERS and it is the whole design. A correction is checked FIRST,
 * before any question is considered, because "alertType is the category" is a
 * statement about the file and not a question, and answering it as a question
 * would be answering a different sentence than the one typed.
 *
 * Then the direct matches, most specific first. Then the decline.
 */
export function replyTo(data: ConversationData, message: string): Reply {
  const text = String(message ?? "").trim();
  const lower = text.toLowerCase();

  // ---- 1. A CORRECTION, recognised by the one parser the browser also runs ----
  const parsed = parseCorrection(text);
  if (parsed.ok) return acceptCorrection(data, parsed);

  // === THE CONDUCTOR, AFTER THE CORRECTION PARSER AND BEFORE ANY BRANCH ====
  //
  // Correction comes first because a schema correction is a COMMAND, not a
  // question, and every agent here would try to answer it as one.
  //
  // Everything after this point used to be eight numbered branches, each owning
  // both the decision and the answer. The decision now lives in
  // `agent-router.ts` as data -- so adding a capability means adding an agent
  // rather than inserting a conditional above five others and hoping the new one
  // is not shadowed by an existing regex.
  const routed = route(text, data);
  if (routed.reply !== undefined) return routed.reply;
  // === IS THIS A CORRECTION ATTEMPT, OR A QUESTION? ===
  //
  // `parseCorrection` handled the ACCEPTED forms. This decides whether a FAILED
  // parse should be reported as a refused correction or routed as a question,
  // and getting it wrong is not a small thing: the first version looked for
  // "is|are|was" anywhere in the sentence, and that made
  //
  //     what ARE THE TOP categories?
  //
  // a correction attempt, because "are the top" matches the shape. So did
  // "what IS WRONG with this file". Every ordinary question containing a copula
  // was being answered with a refusal to map a column, which reads as a broken
  // product and is worse than mis-routing one obscure sentence.
  //
  // So the test is now: the sentence must LOOK LIKE the correction grammar --
  // a column, a copula, and a trailing word that could plausibly be a role. A
  // trailing word is only "role-ish" if it is one the engine knows, or is one of
  // the magnitudes it deliberately refuses. "top" and "wrong" are neither.
  const correctionShape = /\b(is|are|was|should be|as)\b/i.test(text);
  // THE DECISIVE RULE, and the one that should have been the first: A CORRECTION
  // IS DECLARATIVE. It names a column and asserts something about it. A question
  // opens with an interrogative and asks for something back. "What is the
  // customer's lifetime value in dollars" contains a copula AND the word "value"
  // and is still plainly a question, and no amount of shape-matching on the rest
  // of the sentence will fix that -- the word it happens to share with a role is
  // an accident of English.
  const interrogative = /^\s*(what|which|who|whom|whose|when|where|why|how|does|do|did|is|are|can|could|would|should|show|tell|give|find|list|explain|compare|check|summarise|summarize|and)\b/i.test(text);
  // AND THE GRAMMAR IS THE REAL TEST: a correction ENDS right after the role
  // word. "<column> is [actually] [the] <one-word>."
  //
  // This is better than asking whether the trailing word is one the engine knows,
  // which was the first attempt and which fails on "alert_code is the
  // sparklines" -- a perfectly clear correction attempt about a role that does
  // not exist, refused for the wrong reason. It also rejects the questions that
  // broke the copula-matching version, because they all keep going after the
  // copula:
  //
  //     what ARE THE TOP categories?        -> "the top categories" is 3 words
  //     what IS WRONG with this file?        -> "wrong with this file" is 4
  //     ...lifetime VALUE in dollars?        -> several words after "the"
  const correctionGrammar = new RegExp(
    "^[\\w.()\\[\\]-]+(?:[ \\t][\\w.()\\[\\]-]+)*\\s+(?:is|are|was)\\s+" +
    "(?:actually\\s+|really\\s+|just\\s+)?(?:the\\s+|a\\s+|an\\s+)?" +
    "[^\\s?.,;]+\\s*[?.!]?\\s*$",
    "i",
  );
  const looksLikeCorrection = !interrogative && correctionShape && correctionGrammar.test(text);
  if (looksLikeCorrection) return refuseCorrection(parsed.reason, parsed.known);

  // ---- 2. A QUERY ABOUT THE DATA, BEFORE ANY COARSE INTENT ----
  //
  // Order matters and this sits above every keyword route. "What are the top
  // categories?" contains the word "categories" and would otherwise be handled
  // by the category branch -- which is fine -- but "How many rows took longer
  // than 5000ms" contains "how many" and would fall through every branch to the
  // DECLINE, because the router only knew how to find a WIDGET and never how to
  // COUNT anything.
  //
  // The resolver runs first because it is the only thing here that computes.
  // A `matched: false` means it did not recognise a queryable question, and the
  // coarse routes below handle it exactly as before.
  const query = resolveQuery({
    totalRows: data.totalRows,
    columns: data.columns,
    ranking: data.ranking,
    timeline: data.timeline,
  }, text);
  if (query.matched || query.clarify) {
    return {
      kind: "answer",
      text: query.answer,
      widgets: query.widget === undefined ? [] : [{
        kind: query.widget.kind === "histogram" ? "histogram" : query.widget.kind === "line" ? "chart-line" : "chart-bar",
        title: query.widget.title,
        note: query.widget.note,
        payload: query.widget.payload,
      }],
      suggestions: query.column === null
        ? ["what is wrong with this file?"]
        : [`what is the average ${query.column}`, "what is wrong with this file?"],
    };
  }

  // ---- 3. HELP ----
  if (/\b(help|what can you|capabilit|how do i|what do you)\b/.test(lower)) {
    return {
      kind: "answer",
      text: "I can show you the shape of the data, the worst hour, the biggest categories, everything that looks " +
        "wrong with it, and how I read each column. You can also correct a column in plain English, and I will " +
        "re-read the file. I do not answer free-form questions about values -- I can only report what the engine measured.",
      widgets: [{
        kind: "capabilities",
        title: "What I can do",
        payload: { capabilities: CAPABILITIES },
      }],
      suggestions: [],
    };
  }

  // ---- 4. THE SHAPE OF THE DAY ----
  if (/\b(hour|when|spike|peak|timeline|time of day|busiest|quietest)\b/.test(lower)) {
    if (data.timeline.length === 0) {
      return decline(
        "This file has no readable timestamps, so there is no hour to show. " +
        "I can still show you the categories and anything that looks wrong with the values.");
    }
    const worst = [...data.timeline].sort((a, b) => b.count - a.count)[0]!;
    const spikes = data.timeline.filter((p) => p.spike);
    const lead = spikes.length > 0
      ? `${spikes.length} hour${spikes.length === 1 ? "" : "s"} stand out against the mean. The busiest is ${worst.hour.replace("T", " ")}:00 with ${rows(worst.count)} rows.`
      : `No hour stands out against the mean. The busiest is ${worst.hour.replace("T", " ")}:00 with ${rows(worst.count)} rows.`;
    return {
      kind: "answer",
      text: lead,
      widgets: [lineWidget(data)],
      suggestions: adaptiveSuggestions(data, lower),
    };
  }

  // ---- 5. THE CATEGORIES ----
  if (/\b(categor|top |biggest|largest|most common|breakdown|group|which .*most)\b/.test(lower)) {
    if (data.ranking.length === 0) {
      return decline(
        "I could not find a categorical column in this file, so there is nothing to rank. " +
        "I can show you the column statistics and anything that looks wrong with the values.");
    }
    const top = data.ranking[0]!;
    return {
      kind: "answer",
      text: `${rows(data.ranking.length)} distinct value${data.ranking.length === 1 ? "" : "s"} in the category column. ` +
        `The largest is "${top.key}" with ${rows(top.count)} rows.`,
      widgets: [barWidget(data)],
      suggestions: adaptiveSuggestions(data, lower),
    };
  }

  // ---- 5b. THE DISCORDANCE, BEFORE THE FINDINGS ----
  //
  // THE ORDER IS LOAD-BEARING. This sits above the findings branch on purpose:
  // that branch matches on `anomal`, and "are there any complex anomalies?"
  // contains it. A branch added below would be unreachable, and the question
  // would answer something true and unrelated. If these two are ever reordered,
  // this test fails and the question quietly stops working.
  // NO TRAILING \b, and that is not sloppiness. A pattern like
  // /\b(discord)\b/ cannot match "discordant": after "discord" the next
  // character is a word character, so there is no boundary, and the branch
  // silently never fires. The alternatives below are deliberately unanchored
  // at the end so a PREFIX of the word is enough.
  if (/(discord|contradict|relational|out of step|inconsistent pair|complex anomal|cross.column|two column|both column)/.test(lower)) {
    return discordanceAnswer(data);
  }

  // ---- 6. THE FINDINGS ----
  if (/\b(wrong|problem|issue|anomal|findings|broken|bad|error|clean|wrong with)\b/.test(lower)) {
    const severe = data.anomalies.filter((a) => a.severity === "critical");
    if (data.anomalies.length === 0) {
      return {
        kind: "answer",
        text: "Nothing to flag. Every column is numerically clean by the engine's own thresholds, " +
          "and there are no extreme values past the 3x-IQR fence.",
        widgets: [{ kind: "findings", title: "Findings", payload: { anomalies: [] } }],
        suggestions: CAPABILITIES.slice(1, 3).map((c) => c.ask),
      };
    }
    return {
      kind: "answer",
      text: severe.length === 0
        ? `${rows(data.anomalies.length)} finding${data.anomalies.length === 1 ? "" : "s"}, none of them severe.`
        : `${rows(severe.length)} severe finding${severe.length === 1 ? "" : "s"}. The worst is ${severe[0]!.column}: ${severe[0]!.detail}.`,
      widgets: [findingsWidget(data)],
      suggestions: adaptiveSuggestions(data, lower),
    };
  }

  // ---- 7. HOW THE COLUMNS WERE READ ----
  if (/\b(column|schema|mapping|how did you read|guess|assum|verified|mapping)\b/.test(lower)) {
    const learned = Object.entries(data.learned);
    return {
      kind: "answer",
      text: learned.length > 0
        ? `I read ${rows(data.columns.length)} numeric columns, and ${rows(learned.length)} of those mappings came from what ` +
          "you told me in this conversation. The rest I inferred from column names and a statistical profile, " +
          "so treat them as a first reading rather than verified."
        : "I inferred every column reading from its name and a statistical profile of the values. " +
          "None of it has been checked by a person, so treat it as a first reading. " +
          "Tell me a mapping in plain English and I will remember it for this checkout.",
      widgets: [
        { kind: "mappings", title: "How I read the columns", payload: { learned, columns: data.columns.map((c) => c.name) } },
        { kind: "columns", title: "Column statistics", payload: { columns: data.columns } },
      ],
      suggestions: ["alertType is the category", "show me the worst hour"],
    };
  }

  // ---- 8. AN OVERVIEW ----
  //
  // THE PATTERN WAS WRITTEN FOR THE WORDS AN AUTHOR IMAGINES.
  //
  // It used to match "summary" and "tell me about", which misses the two things
  // people actually type. "summarize" does not contain "summary", and "tell me
  // more about this file" does not contain "tell me about" contiguously -- so
  // both fell past a branch that existed, into the decline. That is why the
  // agent could read a file and then refuse to describe it.
  //
  // The variants below are the observed phrasings, not synonyms invented for
  // this comment. Spelled variants (summarise/summarise) are listed rather than
  // normalised, because a missing British spelling is not a different intent.
  // NO TRAILING \b, and this is the SECOND time it has bitten this file. An
  // alternative like "summar" terminated by a word boundary cannot match
  // "summarize": the next character is itself a word character, so there is no
  // boundary and the alternative silently never fires. Prefix alternatives and a
  // trailing boundary are mutually exclusive; pick the prefix.
  //
  // AND THE ALTERNATIVES ARE DELIBERATELY NOT "tell me ". An earlier draft
  // matched the bare phrase and consequently answered "tell me a STORY about
  // this file" with a column summary, which broke the rule that a genuine
  // non-question still declines. Each alternative below names the shape of the
  // request, not just its opening words.
  if (/(summar|overview|tell me (more |anything |everything )?about|what is this|what s this|describe (this|the)|catch me up|walk me through|what can you tell me|what could you tell me|what do you see|give me (an? )?(summary|overview|tour|breakdown)|fill me in|anything (interesting|notable)|brief me)/.test(lower)) {
    return synthesisResponse(data);
  }

  // ---- 9. THE DECLINE ----
  return decline(
    "I cannot answer that from what I have measured. I report what the engine found in this file -- " +
    "the shape of the day, the categories, the findings and how I read each column -- and I will not invent a figure " +
    "to fill the gap.");
}

/**
 * "ARE THERE ROWS WHERE TWO COLUMNS DISAGREE?"
 *
 * The only question in this file that cannot be answered from a summary, which
 * is why it needs the rows. It pairs up the numeric columns, runs the MAD
 * cross-column check on each pair, and reports the pair that found the most --
 * so a user asking one question gets the strongest available answer rather than
 * a search over every pair.
 *
 * THE PAIR SEARCH IS BOUNDED, and the bound is a product decision rather than a
 * performance one. Reporting all pairs would be noisier and less useful: with
 * six columns there are fifteen pairs, and a user told about eleven of them
 * learns nothing. The most discordant pair is the finding; the rest are
 * arithmetic.
 *
 * Each reported row is stated in the user's terms -- "row 46", the columns, and
 * which way each is wrong -- because a finding a user cannot locate is a
 * finding they cannot act on.
 */
/**
 * THE SYNTHESIS. What the engine knows, said as a paragraph.
 *
 * Assembled from facts already computed -- never re-derived, never re-worded
 * into something vaguer. Every sentence carries a number the engine measured,
 * so the paragraph cannot drift from the file it describes, and it costs one
 * pass over data already in memory.
 *
 * THE ORDER IS WHAT MAKES IT READ. What it is, how much of it, what is in it,
 * what is wrong with it, and finally what to ask next. A summary that leads
 * with the caveats is an apology wearing a summary's clothes.
 *
 * AN UNIDENTIFIABLE FILE STILL GETS ONE. The purpose statement may be an
 * admission, but the row count, the column count, the categories and the
 * findings are all known, and refusing to describe a file because the engine
 * cannot NAME it would throw away four facts to protect a fifth. The admission
 * appears in its place in the paragraph; it does not become the whole answer.
 */
function synthesisResponse(data: ConversationData): Reply {
  const severe = data.anomalies.filter((a) => a.severity === "critical");
  const parts: string[] = [];

  const columnCount = data.columns.length;
  // The period is not cosmetic. Without it the paragraph reads as a run-on
  // fragment ("...across 2 numeric columns This file appears to be..."), and a
  // summary that looks machine-assembled undercuts the very trust it is trying
  // to earn.
  parts.push(`I read ${rows(data.totalRows)} rows across ${columnCount} numeric column${columnCount === 1 ? "" : "s"}.`);

  const opening = data.purpose.kind === "unknown"
    ? "I cannot tell what this file is for from the column names alone, so I will not pretend otherwise."
    : data.purpose.confidence === "high"
      ? data.purpose.statement
      : `${data.purpose.statement} That is a reading of the column names, not something I checked.`;
  parts.push(opening);

  const top = data.ranking[0];
  if (top !== undefined) {
    const distinct = data.ranking.length;
    parts.push(`The largest category is "${top.key}" with ${rows(top.count)} rows, across ${rows(distinct)} distinct value${distinct === 1 ? "" : "s"} I can rank.`);
  }

  const busiest = [...data.timeline].sort((a, b) => b.count - a.count)[0];
  if (busiest !== undefined && data.timeline.length > 0) {
    parts.push(`The busiest hour is ${busiest.hour.replace("T", " ")}:00 with ${rows(busiest.count)} rows.`);
  }

  if (severe.length > 0) {
    const worst = severe[0]!;
    // THE FIGURE, not the multiplier. "250x the fence" tells a reader the size
    // of the problem; "250,000" tells them what to go and look at, and they can
    // find it in their own file. The multiple is kept as a trailing clause
    // because it is what makes the number meaningful.
    const stat = data.columns.find((c) => c.name === worst.column);
    const value = stat?.max === null || stat?.max === undefined ? null : stat.max;
    const figure = value === null
      ? ""
      : ` at ${fmtNum(value)}, ${rows(Math.round(worst.factor ?? 0))}x the fence`;
    parts.push(`I found ${rows(severe.length)} severe finding${severe.length === 1 ? "" : "s"}; the worst is in ${worst.column}${figure}.`);
  } else if (data.anomalies.length > 0) {
    parts.push(`Nothing is severe. I found ${rows(data.anomalies.length)} thing${data.anomalies.length === 1 ? "" : "s"} worth looking at.`);
  } else {
    parts.push("Nothing in it looks malformed -- every column is clean by the engine's own thresholds.");
  }

  parts.push("Ask me about the categories, the busiest hour, what is wrong with it, or how I read each column, and I will go further.");

  return {
    kind: "answer",
    text: parts.join(" "),
    widgets: severe.length > 0
      ? [{ kind: "findings", title: "What I found", note: "Severe findings first.", payload: { anomalies: severe.slice(0, 5) } }]
      : [],
    suggestions: adaptiveSuggestions(data),
  };
}

function discordanceAnswer(data: ConversationData): Reply {
  if (data.rows === undefined || data.rows.length === 0) {
    return decline(
      "I cannot check for rows that disagree with each other from the summary I was given -- " +
      "that needs the rows themselves, and I do not have them here. " +
      "I can still show you the per-column findings, the categories, and how I read each column.");
  }

  const numeric = data.columns.map((c) => c.name).filter((n) => n !== undefined).slice(0, 6);
  let best: { a: CrossColumnAnomaly; x: string; y: string } | null = null;
  for (let i = 0; i < numeric.length; i++) {
    for (let j = i + 1; j < numeric.length; j++) {
      const found = findCrossColumnAnomalies({ rows: data.rows, columns: [numeric[i]!, numeric[j]!] });
      if (found.length > 0 && (best === null || found[0]!.strength > best.a.strength)) {
        best = { a: found[0]!, x: numeric[i]!, y: numeric[j]! };
      }
    }
  }

  if (best === null) {
    return {
      kind: "answer",
      text: `No. Across ${rows(data.totalRows)}, no row has two numeric columns that contradict each other -- ` +
        "every row that is high in one is also high in the other, or low in both. " +
        "Rows that are merely large are a different question, and I answer that one from the per-column findings.",
      widgets: [],
      suggestions: ["what is wrong with this file?", "what are the top categories"],
    };
  }

  const { a, x, y } = best;
  const all = findCrossColumnAnomalies({ rows: data.rows, columns: [x, y] });
  const n = all.length;
  // "1 row contradicts ITSELF", "3 rows contradict THEMSELVES". A finding
  // about a handful of rows, described in the singular, reads as a grammar
  // mistake and costs the reader a beat of doubt about the rest of it.
  return {
    kind: "answer",
    text: `Yes. ${n} row${n === 1 ? "" : "s"} contradict${n === 1 ? "s" : ""} ` +
      `${n === 1 ? "itself" : "themselves"}: ` +
      `${a.x.column} is unusually ${a.x.z > 0 ? "high" : "low"} (${fmtNum(a.x.value)}) while ` +
      `${a.y.column} is unusually ${a.y.z > 0 ? "high" : "low"} (${fmtNum(a.y.value)}), which do not go together. ` +
      `Row ${a.row + 1} is the clearest: ${a.x.column} ${a.x.z.toFixed(1)} robust deviations from its median, ` +
      `${a.y.column} ${a.y.z.toFixed(1)}. ` +
      "A row like that is usually a join that went wrong or a field measured in the wrong unit, rather than a real observation.",
    widgets: [],
    suggestions: ["what is wrong with this file?", "how did you read the columns?"],
  };
}

function fmtNum(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100);
}

function decline(why: string): Reply {
  return {
    kind: "answer",
    text: why,
    // NO WIDGET. A widget is a number, and there is no number to give.
    widgets: [],
    suggestions: CAPABILITIES.slice(0, 4).map((c) => c.ask),
  };
}

function acceptCorrection(data: ConversationData, parsed: ParsedCorrection): Reply {
  const exists = data.columns.some((c) => c.name === parsed.column);
  return {
    kind: "correction",
    text: exists
      ? `I will treat ${parsed.column} as the ${parsed.role}. Re-reading the file with that mapping.`
      : `I will treat ${parsed.column} as the ${parsed.role}. Note that no numeric column in this file has that ` +
        "name, so it will change how I label things rather than how I measure them.",
    widgets: [],
    suggestions: ["show me the worst hour", "what is wrong with this file?"],
    correction: { column: parsed.column, role: parsed.role },
  };
}

/**
 * A correction attempt the engine cannot honour.
 *
 * It gets its OWN reply rather than falling through to the router, because
 * "col_15 is actually the amount" names a column and a role and is therefore a
 * correction attempt. Answering it as a general question would be answering a
 * different sentence than the one typed, and the user would see an unrelated
 * chart and conclude the feature is broken.
 */
function refuseCorrection(reason: string, known: readonly string[]): Reply {
  return {
    kind: "correction",
    text: reason + (known.length > 0 ? ` The roles I know are: ${known.join(", ")}.` : ""),
    widgets: [],
    suggestions: [...known.slice(0, 3).map((r) => `col_1 is the ${r}`)],
  };
}