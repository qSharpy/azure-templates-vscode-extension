'use strict';

/**
 * fuzzySearch.js
 *
 * Typo-tolerant fuzzy search engine for the Dependencies panel.
 *
 * Scoring combines:
 *   1. Subsequence matching  — query chars must appear in order in the target
 *   2. Word-boundary bonus   — matching at start of a word (after /, -, _, .)
 *   3. CamelCase bonus       — matching at an uppercase letter after a lowercase
 *   4. Levenshtein segment   — each whitespace-separated query word is matched
 *      against every slash-separated path segment; best segment score wins
 *
 * A query like "templete" will still find "template" because the Levenshtein
 * distance between the two is 1 (one transposition).
 */

// ---------------------------------------------------------------------------
// Levenshtein distance (bounded — returns Infinity if distance > maxDist)
// ---------------------------------------------------------------------------

/**
 * Computes the Levenshtein edit distance between two strings.
 * Returns Infinity early if the distance exceeds `maxDist`.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [maxDist=4]
 * @returns {number}
 */
function levenshtein(a, b, maxDist = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return Infinity;

  const la = a.length;
  const lb = b.length;

  // Use two rows to save memory
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return Infinity;
    [prev, curr] = [curr, prev];
  }

  return prev[lb] <= maxDist ? prev[lb] : Infinity;
}

// ---------------------------------------------------------------------------
// Subsequence score
// ---------------------------------------------------------------------------

/**
 * Checks whether every character of `query` appears in `target` in order,
 * and returns a score reflecting how "tight" the match is.
 *
 * Returns -Infinity if the query is not a subsequence of the target.
 *
 * Higher score = better match.
 *
 * @param {string} query   lower-cased query
 * @param {string} target  lower-cased target
 * @param {string} [targetOrig]  original-case target (for camelCase bonus)
 * @returns {number}
 */
function subsequenceScore(query, target, targetOrig = target) {
  let score = 0;
  let qi = 0;
  let lastMatchIdx = -1;
  let consecutiveBonus = 0;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] !== query[qi]) {
      consecutiveBonus = 0;
      continue;
    }

    // Base match
    score += 1;

    // Consecutive characters bonus
    if (ti === lastMatchIdx + 1) {
      consecutiveBonus += 2;
      score += consecutiveBonus;
    } else {
      consecutiveBonus = 0;
    }

    // Word-boundary bonus: match at start of a path segment or after separator
    if (ti === 0 || /[/\-_.\s]/.test(target[ti - 1])) {
      score += 5;
    }

    // CamelCase bonus: match at an uppercase letter (original case)
    if (ti > 0 && targetOrig[ti] >= 'A' && targetOrig[ti] <= 'Z' &&
        targetOrig[ti - 1] >= 'a' && targetOrig[ti - 1] <= 'z') {
      score += 3;
    }

    lastMatchIdx = ti;
    qi++;
  }

  // All query chars must be matched
  if (qi < query.length) return -Infinity;

  // Penalise long targets (prefer shorter, more specific matches)
  score -= target.length * 0.05;

  return score;
}

// ---------------------------------------------------------------------------
// Segment fuzzy score (Levenshtein-based)
// ---------------------------------------------------------------------------

/**
 * Splits `target` on path separators and scores each segment against `word`
 * using Levenshtein distance.  Returns the best (lowest distance) score
 * converted to a positive bonus, or 0 if no segment is close enough.
 *
 * @param {string} word    single lower-cased query word
 * @param {string} target  lower-cased full path or filename
 * @returns {number}  bonus score (0 if no close segment found)
 */
function segmentFuzzyScore(word, target) {
  const segments = target.split(/[/\-_.\s]+/).filter(Boolean);
  let best = Infinity;

  for (const seg of segments) {
    // Only compare if lengths are in a reasonable ratio
    if (seg.length === 0) continue;
    const maxDist = Math.max(1, Math.floor(word.length * 0.4));
    const dist = levenshtein(word, seg, maxDist);
    if (dist < best) best = dist;
  }

  if (!isFinite(best)) return 0;
  // Convert distance to a bonus: distance 0 → 8, distance 1 → 5, distance 2 → 2, etc.
  return Math.max(0, 8 - best * 3);
}

// ---------------------------------------------------------------------------
// FuzzySearch class
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SearchEntry
 * @property {string} filePath     Absolute path to the YAML file
 * @property {string} filename     Basename (e.g. "build-dotnet.yml")
 * @property {string} relativePath Workspace-relative path (e.g. "templates/build-dotnet.yml")
 * @property {string} directory    Directory portion of relativePath
 */

/**
 * @typedef {object} SearchResult
 * @property {SearchEntry} entry
 * @property {number}      score
 */

class FuzzySearch {
  constructor() {
    /** @type {SearchEntry[]} */
    this._index = [];
  }

  /**
   * Rebuilds the search index from an array of entries.
   * @param {SearchEntry[]} entries
   */
  buildIndex(entries) {
    this._index = entries.slice();
  }

  /**
   * Returns the current number of indexed entries.
   * @returns {number}
   */
  get size() {
    return this._index.length;
  }

  /**
   * Searches the index for entries matching `query`.
   *
   * @param {string} query
   * @param {number} [maxResults=20]
   * @returns {SearchResult[]}  Sorted best-first, score > 0 only.
   */
  search(query, maxResults = 20) {
    const q = query.trim();
    if (!q) return [];

    const qLower = q.toLowerCase();
    // Split query into words for segment fuzzy matching
    const qWords = qLower.split(/\s+/).filter(Boolean);

    /** @type {SearchResult[]} */
    const results = [];

    for (const entry of this._index) {
      const filenameLower = entry.filename.toLowerCase();
      const relLower      = entry.relativePath.toLowerCase();

      // ── 1. Subsequence score against filename ──────────────────────────────
      let score = subsequenceScore(qLower, filenameLower, entry.filename);

      // ── 2. Subsequence score against full relative path (lower weight) ─────
      if (score <= 0) {
        const pathScore = subsequenceScore(qLower, relLower, entry.relativePath);
        if (pathScore > 0) score = pathScore * 0.7;
      }

      // ── 3. Levenshtein segment bonus (typo tolerance) ──────────────────────
      let segBonus = 0;
      for (const word of qWords) {
        segBonus += segmentFuzzyScore(word, filenameLower);
        segBonus += segmentFuzzyScore(word, relLower) * 0.5;
      }

      // Combine: subsequence score dominates; segment bonus rescues typos
      const totalScore = score + segBonus;

      if (totalScore > 0) {
        results.push({ entry, score: totalScore });
      }
    }

    // Sort best-first
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, maxResults);
  }
}

module.exports = { FuzzySearch, levenshtein, subsequenceScore };
