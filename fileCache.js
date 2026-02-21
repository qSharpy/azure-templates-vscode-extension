'use strict';

/**
 * fileCache.js
 *
 * A singleton, mtime-aware in-memory cache for YAML file contents.
 *
 * Problem it solves
 * ─────────────────
 * In a 300-file workspace every tree refresh, hover, diagnostic scan, and
 * graph build independently calls fs.readFileSync() on the same files.
 * A single "Called by" tree rebuild can trigger thousands of redundant reads.
 *
 * How it works
 * ────────────
 * • `readFile(filePath)` returns the cached text if the file's mtime on disk
 *   matches the cached mtime.  Otherwise it reads from disk, updates the
 *   cache, and returns the fresh text.
 * • `invalidate(filePath)` removes one entry (called by the file-system
 *   watcher when a file changes).
 * • `invalidateAll()` clears everything (called on workspace folder change).
 * • The cache is a plain Map — no external dependencies.
 *
 * Thread safety
 * ─────────────
 * Node.js is single-threaded so no locking is needed.
 *
 * @module fileCache
 */

const fs   = require('fs');
const path = require('path'); // eslint-disable-line no-unused-vars

/**
 * @typedef {{ text: string, mtimeMs: number }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/**
 * Returns the text content of `filePath`.
 *
 * • If the file is cached and its mtime has not changed, returns the cached
 *   text without touching the disk.
 * • Otherwise reads the file, updates the cache, and returns the fresh text.
 * • Returns `null` if the file cannot be read (does not exist, permission
 *   error, etc.).
 *
 * @param {string} filePath  Absolute path to the file
 * @returns {string|null}
 */
function readFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;

    const entry = _cache.get(filePath);
    if (entry && entry.mtimeMs === mtimeMs) {
      return entry.text;
    }

    // Cache miss or stale — read from disk
    const text = fs.readFileSync(filePath, 'utf8');
    _cache.set(filePath, { text, mtimeMs });
    return text;
  } catch {
    // File not found, permission denied, etc.
    return null;
  }
}

/**
 * Checks whether a file exists on disk (stat only, no read).
 * Uses the cache's last-known mtime as a fast-path hint, but always
 * confirms with a real stat so deletions are detected.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a single entry from the cache.
 * Call this when the file-system watcher reports that `filePath` changed or
 * was deleted.
 *
 * @param {string} filePath
 */
function invalidate(filePath) {
  _cache.delete(filePath);
}

/**
 * Clears the entire cache.
 * Call this when the workspace folder changes or on a manual full refresh.
 */
function invalidateAll() {
  _cache.clear();
}

/**
 * Returns the number of entries currently in the cache.
 * Useful for diagnostics / tests.
 *
 * @returns {number}
 */
function size() {
  return _cache.size;
}

/**
 * Returns a snapshot of all cached file paths.
 * Useful for diagnostics / tests.
 *
 * @returns {string[]}
 */
function cachedPaths() {
  return Array.from(_cache.keys());
}

module.exports = {
  readFile,
  fileExists,
  invalidate,
  invalidateAll,
  size,
  cachedPaths,
};
