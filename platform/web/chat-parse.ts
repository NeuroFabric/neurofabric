/**
 * THE CHAT PARSER. Natural language in, one correction out.
 *
 * This is the piece that makes the product conversational rather than a form.
 * A dropzone that can only be corrected by choosing a column from a dropdown and
 * a role from another dropdown assumes the user already knows the engine's
 * vocabulary, which is the one thing a person with a data problem does not know.
 * They know that col_15 is the amount. They do not know what to call that.
 *
 * === WHY "col_15 is actually the amount" IS REFUSED, NOT GUESSED ===
 *
 * The tempting implementation maps "amount" onto `duration`, the engine's
 * numeric role, and accepts it. That would be confidently wrong, and this
 * codebase has already rejected the same mapping for the same reason.
 * `schema-memory.ts` is explicit: a numeric column is not a duration --
 * `revenue` is numeric and `duration` is only ever filled from a name that says
 * so. Labelling a currency column a duration makes the report publish a latency
 * finding about money, and every downstream figure inherits that error while
 * looking entirely normal.
 *
 * So there are two kinds of acceptable word:
 *
 *   - a SYNONYM, accepted only where the meaning genuinely matches: `host` is a
 *     source, `timestamp` is a time, `kind` is a category, `state` is a status;
 *   - an explicit ROLE NAME, accepted verbatim, because a human saying "this is
 *     the duration" is exercising authority over their own file, not making an
 *     inference the engine is entitled to doubt.
 *
 * A word with no counterpart -- `amount`, `cost`, `total`, `price` -- is refused
 * with the list the engine does have. Refusing costs one more sentence of
 * typing. A wrong mapping costs a report the user has to notice is wrong, and
 * most will not.
 *
 * === THE FUNCTION MUST STAND ALONE ===
 *
 * `parseCorrection` is serialised into the generated page by
 * `Function.prototype.toString`, so the browser and this test suite run the SAME
 * implementation rather than two that agree today. That only works if it closes
 * over nothing: every constant lives inside its own body and it takes one
 * argument. A module-scope helper would pass every test here and fail in the
 * browser with a ReferenceError, which is the same shape of failure as the
 * security header that silently blocked the dashboard's own fetch.
 */

/** The roles the engine actually has. The chat offers these and nothing else. */
export const ROLE_VOCABULARY = [
  "category", "time", "source", "duration", "threshold", "alias", "status", "message",
] as const;

export type ChatRole = (typeof ROLE_VOCABULARY)[number];

export interface ParsedCorrection {
  readonly ok: true;
  readonly column: string;
  readonly role: ChatRole;
  /**
   * `explicit` when the user named a role, `synonym` when they used a plain
   * word. The distinction is carried to the report rather than discarded: a
   * synonym is a human being less precise than they could have been, and the
   * engine may prefer to confirm it.
   */
  readonly confidence: "explicit" | "synonym";
  /** The sentence as typed, so a correction can be shown back to the user. */
  readonly said: string;
}

/**
 * A refusal. It carries NO column and NO role, deliberately: a rejected parse
 * must not be a half-built correction that some later caller treats as
 * actionable. The tests assert the absence, because a parser that finds a word
 * somewhere in a sentence and reports a correction the user never made is worse
 * than one that does nothing.
 */
export interface ParsedRejection {
  readonly ok: false;
  readonly reason: string;
  /** What the engine does have, so the user can finish the sentence. */
  readonly known: readonly string[];
}

/**
 * Parse one sentence into a correction.
 *
 * SELF-CONTAINED BY DESIGN -- see the note above. Every table below is declared
 * inside this function on purpose. Do not hoist them.
 */
export function parseCorrection(input: string): ParsedCorrection | ParsedRejection {
  // Declared inside, deliberately. See the serialisation note.
  const ROLES = ["category", "time", "source", "duration", "threshold", "alias", "status", "message"];
  const SYNONYMS: Record<string, string> = {
    type: "category", kind: "category", group: "category", class: "category", label: "category",
    timestamp: "time", datetime: "time", date: "time", when: "time", day: "time",
    host: "source", hostname: "source", system: "source", origin: "source", service: "source", app: "source", server: "source",
    latency: "duration", elapsed: "duration", response_time: "duration", took: "duration", runtime: "duration",
    limit: "threshold", target: "threshold", sla: "threshold", budget: "threshold",
    also: "alias", aka: "alias", aka_of: "alias",
    state: "status", outcome: "status", result: "status", disposition: "status", severity: "status",
    text: "message", detail: "message", details: "status", description: "message", reason: "message", summary: "message",
  };

  const known = ROLES.slice();
  const text = String(input === undefined || input === null ? "" : input).trim();
  if (text === "") {
    return { ok: false, reason: "say it as '<column> is the <role>', for example 'alert_code is the category'", known };
  }
  // A hard ceiling. A parser handed a pasted paragraph will eventually match
  // something inside it, and the caller cannot tell a one-line request from a
  // wall of text that happens to contain the word "category".
  if (text.length > 200) {
    return { ok: false, reason: "that is too long to be a correction; say it in one short sentence", known };
  }

  // A column is a run of word characters, dots, brackets, dashes and internal
  // spaces. Dots are allowed because a real CSV header can be `total.usd`,
  // spaces because it can be `Alert Code`, and parentheses because it can be
  // `total (USD)` -- and all of them are written into the archive and used to
  // key an actual header row, so truncating any one of them stores a
  // correction against a column that does not exist and the report then says
  // "column not in this file" about a column the user can plainly see.
  const COLUMN = "[\\w.\\u00C0-\\uFFFF()[\\]-]+(?:[ \\t][\\w.\\u00C0-\\uFFFF()[\\]-]+)*";
  // The role word stops before a closing bracket or a sentence stop, so a
  // parenthesised column cannot leave a stray `)` welded onto the role.
  const ROLEWORD = "[^\\s?.,;)\\]]+";
  const FILLER = "(?:is|are|was)\\s+(?:actually\\s+|really\\s+|just\\s+)?";

  /**
   * Resolve one word to a role, and say HOW it resolved.
   *
   * The distinction is the whole point of the confidence field: an explicit role
   * name is a person stating a fact about their own file, while a synonym is
   * them reaching for a word that is close but not exact. The report presents
   * them differently, and calling a synonym "explicit" would present every
   * rough paraphrase as a considered instruction.
   *
   * THE TYPE ANNOTATIONS BELOW COST THE SERIALISATION NOTHING. TypeScript erases
   * them at compile time -- `node --experimental-strip-types` replaces each with
   * whitespace -- so the string handed to the browser by `toString` is still
   * plain JavaScript with no annotations in it. They exist because the file is
   * the only one `tsc --noEmit` checks, and an unannotated parameter here fails
   * the build under `noImplicitAny` and blocks everything else from shipping.
   */
  const roleOf = (word: string): { role: ChatRole; confidence: "explicit" | "synonym" } | undefined => {
    const w = String(word).toLowerCase();
    if (ROLES.indexOf(w) >= 0) return { role: w as ChatRole, confidence: "explicit" };
    if (Object.prototype.hasOwnProperty.call(SYNONYMS, w)) return { role: SYNONYMS[w] as ChatRole, confidence: "synonym" };
    return undefined;
  };

  /**
   * Every form, paired with WHICH CAPTURE IS THE ROLE.
   *
   * === WHY THE SLOT IS DECLARED RATHER THAN GUESSED ===
   *
   * The first version of this loop did not know the word order. It captured two
   * halves, asked which half was a role, and demanded that EXACTLY ONE of them
   * was -- on the reasoning that two roles meant the sentence was ambiguous.
   *
   * That reasoning is wrong, and it refused a correct correction to prove it.
   * "outcome is the state" is a plain instruction: the column is `outcome`, the
   * role is `status`. But `outcome` is also a synonym for `status` and
   * `state` is a synonym for `status`, so BOTH halves resolved to roles, the
   * symmetry check rejected the sentence, and the user was told -- correctly, but
   * uselessly -- that this was not a correction they had made. The synonym table
   * grew, and the bug grew with it: a table that is supposed to make the chat
   * more forgiving quietly made it refuse more.
   *
   * The grammar already answers the question. "X is the Y" puts the role in the
   * second half. "The Y is X" puts it in the first. There is no ambiguity to
   * resolve, and a parser that invents one by cross-checking both halves against
   * a vocabulary will eventually refuse a sentence for the crime of containing
   * two words it happens to know.
   *
   * So the slot is declared by the form that matched, and a half that is not a
   * role ends the attempt. That also removes the failure this replaces could
   * still produce: with the guess, "state is nonsense" would have swapped the
   * halves and returned the invented correction (nonsense -> status) from a
   * sentence that named no role at all.
   */
  const forms = [
    // "alert_code is the category" / "col_15 is actually the amount".
    // The role is the SECOND half: the grammar puts it there.
    new RegExp("^\\s*(" + COLUMN + ")\\s+" + FILLER + "(?:the\\s+)?(" + ROLEWORD + ")\\s*[?.!]?\\s*$", "i"),
    // "the category is alert_code" -- the same correction, said the other way
    // round. A parser that reads one word order refuses a request the user made
    // perfectly clearly.
    //
    // THE ROLE IS CAPTURING HERE, and that is not cosmetic. This form was first
    // written with a non-capturing role, so the match carried one group instead
    // of two, the second capture came back undefined, and the whole form was
    // silently skipped -- a reversed sentence the tests had already been written
    // for simply stopped working, with no error anywhere.
    //
    // The role is the FIRST half here, and only here. That asymmetry is the
    // point of ROLE_SLOT below.
    new RegExp("^\\s*(?:the\\s+)?(" + ROLES.join("|") + ")\\s+" + FILLER + "(?:the\\s+)?(" + COLUMN + ")\\s*[?.!]?\\s*$", "i"),
    // "use alert_code as the category" / "set created_at as time"
    new RegExp("^\\s*(?:use|set|treat|mark)\\s+(" + COLUMN + ")\\s+as\\s+(?:the\\s+)?(" + ROLEWORD + ")\\s*[?.!]?\\s*$", "i"),
    // "alert_code should be the category"
    new RegExp("^\\s*(" + COLUMN + ")\\s+should\\s+be\\s+(?:the\\s+)?(" + ROLEWORD + ")\\s*[?.!]?\\s*$", "i"),
  ];

  // WHICH HALF IS THE ROLE, PER FORM. Every column-first form puts the role
  // second; only the reversed "the <role> is <column>" form puts it first.
  const ROLE_SLOT = [2, 1, 2, 2];

  for (let f = 0; f < forms.length; f += 1) {
    const match = forms[f].exec(text);
    if (match === null) continue;

    const slot = ROLE_SLOT[f];
    const roleWord = String(match[slot] === undefined ? "" : match[slot]).trim();
    const column = String(match[slot === 1 ? 2 : 1] === undefined ? "" : match[slot === 1 ? 2 : 1]).trim();
    // The half the grammar says is the role must actually BE a role. If it is
    // not, this form has not matched a correction and the next one is tried.
    if (roleWord === "" || column === "") continue;

    const chosen = roleOf(roleWord);
    if (chosen === undefined) continue;
    return { ok: true, column, role: chosen.role, confidence: chosen.confidence, said: text };
  }

  // Nothing matched. Before giving up, check whether the sentence MENTIONS a
  // column and a role word at all, so the refusal can be specific. A message
  // that names the word it could not place is actionable; "I did not understand"
  // is not.
  const roleWord = /\b(" + ROLES.join("|") + "|amount|cost|total|price|revenue|value|count|level|severity)\b/i.exec(text);
  if (roleWord !== null) {
    const word = roleWord[1].toLowerCase();
    if (ROLES.indexOf(word) < 0) {
      return {
        ok: false,
        reason: `"${word}" is not a role this engine has, so nothing was changed. It knows: ${known.join(", ")}. ` +
          "If one of those is what you meant, say it by name - for example 'col_15 is the category'.",
        known,
      };
    }
    return {
      ok: false,
      reason: `that mentions the ${word} role but does not say which column it is. ` +
        "Say it as '<column> is the <role>'.",
      known,
    };
  }

  return {
    ok: false,
    reason: "that is not a correction I can read. Say it as '<column> is the <role>', " +
      `for example 'alert_code is the category'. The roles are: ${known.join(", ")}.`,
    known,
  };
}
