// "Is this actually written in the conversation?" The brake on the second read. Pure.
//
// The second read asks the model to re-read the thread looking only for the fields that came back
// empty. That recovers information the first pass overlooked, and it creates a new, bigger risk: a
// model pressed to fill a field fills it, whether or not the information exists. Asking again is
// annoying; storing an invented customer name on a ticket is worse.
//
// The brake is literal on purpose: a recovered value is accepted only if its words appear IN THE
// THREAD. This does not judge whether the answer is right. It judges whether it was SAID.

/** Connectives and filler. They appear in any thread, so matching them would anchor on noise. */
const STOPWORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "does", "doing", "done",
  "each", "from", "have", "having", "here", "into", "just", "like", "more", "most", "much", "must",
  "need", "only", "other", "over", "same", "should", "some", "such", "than", "that", "their",
  "them", "then", "there", "these", "they", "this", "those", "very", "want", "were", "what",
  "when", "where", "which", "while", "will", "with", "would", "your",
]);

/** No accents, no case, no punctuation. Slashes survive because a route is a strong anchor. */
export function normaliseForGrounding(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words that carry meaning. Anything shorter than four characters matches by accident. */
export function distinctiveTokens(value: string): string[] {
  return normaliseForGrounding(value)
    .split(/[\s/]+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

/**
 * Half of the distinctive words is enough.
 *
 * Not 100%, because models paraphrase: "the Team Billing page" for a thread that says "team
 * billing" is a legitimate recovery. Not a single word, because one word matches by accident.
 */
export const MIN_GROUNDING_RATIO = 0.5;

export function isGrounded(value: string, thread: string): boolean {
  const tokens = distinctiveTokens(value);
  // Nothing distinctive to check means nothing proven. Refuse; the field stays a question.
  if (tokens.length === 0) return false;

  const haystack = normaliseForGrounding(thread);
  const found = tokens.filter((token) => haystack.includes(token)).length;
  return found / tokens.length >= MIN_GROUNDING_RATIO;
}

/**
 * The same question for a NAME (a customer, an account). A short name such as "IBM" has no
 * distinctive token, so it is also accepted when it appears in the thread as whole words.
 */
export function isNameGrounded(name: string, thread: string): boolean {
  const needle = normaliseForGrounding(name);
  if (needle.length === 0) return false;
  if (` ${normaliseForGrounding(thread)} `.includes(` ${needle} `)) return true;
  return isGrounded(name, thread);
}
