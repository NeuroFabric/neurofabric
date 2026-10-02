import { parseCorrection, type ParsedCorrection } from "../web/chat-parse.ts";
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
export interface Widget {
  readonly kind: "chart-line" | "chart-bar" | "findings" | "columns" | "mappings" | "capabilities";
  readonly title: string;
  readonly note?: string;
  /** The data. Shape depends on `kind`; the renderer branches, nothing else. */
  readonly payload: unknown;
}

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

/** Everything a widget needs, pulled from the data. */
function lineWidget(data: ConversationData): Widget {
  return {
    kind: "chart-line",
    title: "Rows by hour",
    note: "Orange points are spikes the engine flagged against its own mean. Hover for the exact count.",
    payload: { points: data.timeline },
  };
}

function barWidget(data: ConversationData): Widget {
  // THE CAP LIVES HERE, NOT AT THE CALLER.
  //
  // It used to be applied by whichever code built the ConversationData, which
  // means it held only for the paths that remembered. A caller that passed the
  // full ranking got a chart of every distinct value in the column -- and a
  // column of free-text keys can have thousands, which renders as a grey stripe
  // rather than a chart.
  //
  // Applying it where the WIDGET is built means every caller gets the same
  // promise, and the assertion lives with the reason. Nothing is lost: the
  // analysis still holds every category, and `show me all categories` is a
  // question the router can grow a widget for.
  const points = data.ranking.slice(0, BAR_DEPTH);
  const hidden = data.ranking.length - points.length;
  return {
    kind: "chart-bar",
    title: "Record categories",
    note: hidden > 0
      ? `How many rows fall in each category. Showing the top ${BAR_DEPTH} of ${data.ranking.length}.`
      : "How many rows fall in each category.",
    payload: { points, hidden },
  };
}

/** How many bars a category chart draws. Ten fits without becoming a texture. */
const BAR_DEPTH = 10;

/** Every kind of value the chat can render, as a ranked list. */
function findingsWidget(data: ConversationData): Widget {
  return {
    kind: "findings",
    title: "Findings",
    note: `${rows(data.anomalies.length)} in total, worst first.`,
    payload: { anomalies: data.anomalies },
  };
}

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

  // ---- 2. HELP ----
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

  // ---- 3. THE SHAPE OF THE DAY ----
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
      suggestions: CAPABILITIES.filter((c) => !/hour/.test(c.ask)).slice(0, 3).map((c) => c.ask),
    };
  }

  // ---- 4. THE CATEGORIES ----
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
      suggestions: CAPABILITIES.filter((c) => !/categor/.test(c.ask)).slice(0, 3).map((c) => c.ask),
    };
  }

  // ---- 5. THE FINDINGS ----
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
      suggestions: ["show me the worst hour", "how did you read the columns?"],
    };
  }

  // ---- 6. HOW THE COLUMNS WERE READ ----
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

  // ---- 7. AN OVERVIEW ----
  if (/\b(summary|overview|tell me about|what is this|describe|hello|hi\b|thanks|thank you)\b/.test(lower)) {
    const g = greet(data);
    return { ...g, text: g.text };
  }

  // ---- 8. THE DECLINE ----
  return decline(
    "I cannot answer that from what I have measured. I report what the engine found in this file -- " +
    "the shape of the day, the categories, the findings and how I read each column -- and I will not invent a figure " +
    "to fill the gap.");
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