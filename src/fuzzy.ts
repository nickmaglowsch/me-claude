// Pure bigram fuzzy-match utilities. No external dependencies.

// Basic latin-1 diacritic replacements (covers common Portuguese/Spanish chars).
const DIACRITIC_MAP: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  ý: 'y', ÿ: 'y',
  ñ: 'n',
  ç: 'c',
  ß: 'ss',
  æ: 'ae', œ: 'oe',
};

// Normalize: lowercase, strip diacritics, strip punctuation, collapse whitespace.
export function normalize(s: string): string {
  // Lowercase first
  let result = s.toLowerCase();

  // Replace diacritics
  result = result.replace(/[àáâãäåèéêëìíîïòóôõöùúûüýÿñçßæœ]/g, ch => DIACRITIC_MAP[ch] ?? ch);

  // Strip punctuation (keep letters, digits, whitespace)
  result = result.replace(/[^\p{L}\p{N}\s]/gu, '');

  // Collapse whitespace (trim + normalize internal)
  result = result.trim().replace(/\s+/g, ' ');

  return result;
}

// Build the set of character bigrams for a string.
function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s[i] + s[i + 1];
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  return counts;
}

// Total count of bigrams in a map.
function bigramCount(map: Map<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

// Dice coefficient over character bigrams of two raw (pre-normalized) strings.
// Normalizes internally. Returns 0–1.
export function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);

  // Strings shorter than 2 chars have no bigrams.
  if (na.length < 2 && nb.length < 2) {
    return na === nb ? 1.0 : 0.0;
  }
  if (na.length < 2 || nb.length < 2) {
    // One side has no bigrams; fall back to exact match.
    return na === nb ? 1.0 : 0.0;
  }

  const ba = bigrams(na);
  const bb = bigrams(nb);

  const totalA = bigramCount(ba);
  const totalB = bigramCount(bb);

  // Intersection: sum of min counts for each shared bigram.
  let intersection = 0;
  for (const [bg, count] of ba) {
    const bCount = bb.get(bg) ?? 0;
    intersection += Math.min(count, bCount);
  }

  return (2 * intersection) / (totalA + totalB);
}

export interface FuzzyMatch {
  topic: string;       // the bank entry that matched
  matchedWord: string; // the word in body that matched best
  score: number;       // 0-1
}

// Returns the best score for a single bank entry against the body, ignoring threshold.
// Each bank entry may be an alias group (e.g. "futebol|tenis|basquete"); each alias
// is scored independently and the best wins.
// Returns { topic, matchedWord, score } using the *full bank entry string* as topic.
function scoreBankEntry(
  entry: string,
  bodyWords: string[],
  normalizedBody: string,
): FuzzyMatch | null {
  // Split on | to get individual aliases; skip empty aliases.
  const aliases = entry.split('|').filter(a => a.length > 0);
  if (!aliases.length) return null;

  let best: FuzzyMatch | null = null;

  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);

    // Compare alias against each word in body.
    for (const word of bodyWords) {
      const score = diceSimilarity(normalizedAlias, word);
      if (best === null || score > best.score) {
        best = { topic: entry, matchedWord: word, score };
      }
    }

    // Also compare alias against the full normalized body.
    const fullScore = diceSimilarity(normalizedAlias, normalizedBody);
    if (best === null || fullScore > best.score) {
      best = { topic: entry, matchedWord: normalizedBody, score: fullScore };
    }
  }

  return best;
}

// scoreFuzzy: returns the top-scoring bank entry match regardless of threshold.
// Returns null only when bank is empty or body has no words.
export function scoreFuzzy(
  body: string,
  bank: string[],
  _threshold?: number,
): FuzzyMatch | null {
  if (!bank.length) return null;
  const trimmedBody = body.trim();
  if (!trimmedBody.length) return null;

  const normalizedBody = normalize(trimmedBody);
  const bodyWords = normalizedBody.split(/\s+/).filter(w => w.length > 0);

  let best: FuzzyMatch | null = null;

  for (const entry of bank) {
    const candidate = scoreBankEntry(entry, bodyWords, normalizedBody);
    if (candidate && (best === null || candidate.score > best.score)) {
      best = candidate;
    }
  }

  return best;
}

// Best fuzzy match of any token in `bank` against any word in `body`.
// Also compares each topic against the full normalized body.
// Returns the top-scoring match with score >= threshold, or null.
// Each bank entry may be an alias group (e.g. "futebol|tenis|basquete").
export function bestFuzzyMatch(
  body: string,
  bank: string[],
  threshold: number,
): FuzzyMatch | null {
  const top = scoreFuzzy(body, bank);
  if (!top) return null;
  if (top.score < threshold) return null;
  return top;
}
