// Port of electron/src/shared/fuzzy.ts.
export interface FuzzyMatch {
  score: number
  // Code-point positions in `text` (Array.from indexing), so callers can wrap
  // matched characters without splitting surrogate pairs.
  indices: number[]
}

const CONSECUTIVE_BONUS = 3
const WORD_START_BONUS = 2
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const ALPHANUMERIC = /[\p{L}\p{N}]/u

// Case-insensitive subsequence match: every non-whitespace query character
// must appear in `text` in order. Greedy left-to-right rather than an optimal
// alignment because it runs once per row per keystroke over labels up to 2k
// characters and paths up to 16k characters.
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const needle = Array.from(query.toLowerCase()).filter(char => !/\s/.test(char))
  if (needle.length === 0) return { score: 0, indices: [] }
  const haystack = Array.from(text)
  const lower = haystack.map(char => char.toLowerCase())
  const indices: number[] = []
  let score = 0
  let cursor = 0
  for (const char of needle) {
    const found = lower.indexOf(char, cursor)
    if (found === -1) return null
    score += 1
    if (indices.length > 0 && found === indices[indices.length - 1] + 1) score += CONSECUTIVE_BONUS
    // A CJK character is a word on its own; otherwise a word starts at the
    // text start or after any non-alphanumeric character (space, /, -, _, ·).
    if (found === 0 || CJK.test(haystack[found]) || !ALPHANUMERIC.test(haystack[found - 1])) score += WORD_START_BONUS
    indices.push(found)
    cursor = found + 1
  }
  return { score, indices }
}
