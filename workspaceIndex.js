'use strict';

/**
 * workspaceIndex.js
 *
 * A pre-computed, incrementally-updatable workspace index that eliminates the
 * O(N²) file-scan in buildUpstreamTree().
 *
 * Problem it solves
 * ─────────────────
 * The original buildUpstreamTree() scans ALL workspace YAML files on every
 * tree refresh to find callers of the active file.  With 300 files and deep
 * dependency chains this means thousands of disk reads per editor switch.
 *
 * How it works
 * ────────────
 * On first use (or after invalidation) the index scans every YAML file once
 * and builds two adjacency maps:
 *
 *   forwardAdj  : filePath → Set<resolvedTargetPath>   (what each file calls)
 *   reverseAdj  : targetPath → Set<callerPath>          (who calls each file)
 *
 * These maps are kept in memory.  When a file changes (watcher fires) only
 * that file's entries are re-computed — a partial update that is O(1) instead
 * of O(N).
 *
 * Consumers (treeViewProvider, graphDataBuilder) query the index instead of
 * scanning disk:
 *
 *   index.getCallers(filePath)   → Set<string>   direct callers
 *   index.getCallees(filePath)   → Set<string>   direct callees
 *   index.getParams(filePath)    → ParsedParam[]
 *   index.getAllFiles()          → string[]
 *
 * The index also exposes getTransitiveCallers(filePath) which does a BFS
 * upward through reverseAdj — replacing the recursive findChain() traversal
 * with a simple graph walk over in-memory maps.
 *
 * @module workspaceIndex
 */

const path      = require('path');
const fileCache = require('./fileCache');
const {
  collectYamlFiles,
  extractTemplateRefs,
} = require('./graphDataBuilder');
const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require('./hoverProvider');

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceIndex class
// ─────────────────────────────────────────────────────────────────────────────

class WorkspaceIndex {
  constructor() {
    /** @type {string|null} */
    this._workspaceRoot = null;

    /**
     * filePath → Set<resolvedTargetPath>
     * @type {Map<string, Set<string>>}
     */
    this._forwardAdj = new Map();

    /**
     * targetPath → Set<callerPath>
     * @type {Map<string, Set<string>>}
     */
    this._reverseAdj = new Map();

    /**
     * filePath → ParsedParam[]
     * @type {Map<string, Array>}
     */
    this._params = new Map();

    /**
     * All YAML files known to the index.
     * @type {Set<string>}
     */
    this._allFiles = new Set();

    /** @type {boolean} */
    this._ready = false;

    /** @type {Array<()=>void>} */
    this._readyCallbacks = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isReady() { return this._ready; }

  /**
   * Registers a callback to be called once the index finishes building.
   * If already ready, calls immediately.
   * @param {()=>void} cb
   */
  onReady(cb) {
    if (this._ready) { cb(); return; }
    this._readyCallbacks.push(cb);
  }

  /**
   * Returns the set of files that directly call `filePath`.
   * @param {string} filePath
   * @returns {Set<string>}
   */
  getCallers(filePath) {
    return this._reverseAdj.get(filePath) || new Set();
  }

  /**
   * Returns the set of files that `filePath` directly calls.
   * @param {string} filePath
   * @returns {Set<string>}
   */
  getCallees(filePath) {
    return this._forwardAdj.get(filePath) || new Set();
  }

  /**
   * Returns the parsed parameters for `filePath` (cached).
   * @param {string} filePath
   * @returns {Array}
   */
  getParams(filePath) {
    if (this._params.has(filePath)) return this._params.get(filePath);
    const text = fileCache.readFile(filePath);
    if (!text) return [];
    const params = parseParameters(text);
    this._params.set(filePath, params);
    return params;
  }

  /**
   * Returns all YAML files known to the index.
   * @returns {string[]}
   */
  getAllFiles() {
    return Array.from(this._allFiles);
  }

  /**
   * Returns the set of ALL files that transitively call `filePath`
   * (i.e. the full upstream closure), using a BFS over reverseAdj.
   *
   * This replaces the recursive findChain() + trie-building approach with a
   * simple in-memory BFS — O(callers) instead of O(N × depth × disk reads).
   *
   * @param {string} filePath
   * @returns {Set<string>}
   */
  getTransitiveCallers(filePath) {
    const result = new Set();
    const queue = [filePath];
    while (queue.length > 0) {
      const current = queue.shift();
      const callers = this._reverseAdj.get(current) || new Set();
      for (const caller of callers) {
        if (!result.has(caller)) {
          result.add(caller);
          queue.push(caller);
        }
      }
    }
    return result;
  }

  /**
   * Builds a trie-style upstream tree for `targetFile` using the index.
   *
   * Returns the same shape as the original buildUpstreamTree():
   *   { nodes: DepNode-like[], directCallerCount: number }
   *
   * Each node has: { filePath, relativePath, label, childNodes }
   *
   * @param {string} targetFile
   * @param {string} workspaceRoot
   * @returns {{ nodes: object[], directCallerCount: number }}
   */
  buildUpstreamTree(targetFile, workspaceRoot) {
    const directCallers = this._reverseAdj.get(targetFile) || new Set();

    // BFS to collect all transitive callers and their parent→child relationships
    // We build a trie: for each transitive caller, find the shortest path from
    // it to targetFile and insert that path into the trie.
    //
    // Since we have the full reverseAdj in memory, we can do this with a
    // reverse-BFS from targetFile upward, tracking the path.

    // Map: filePath → Set<direct parents in the upstream tree>
    // (a file can be reached via multiple paths — we show all of them)
    /** @type {Map<string, Set<string>>} child → set of parents */
    const parentMap = new Map();

    const visited = new Set([targetFile]);
    let frontier = [targetFile];

    while (frontier.length > 0) {
      const next = [];
      for (const node of frontier) {
        const callers = this._reverseAdj.get(node) || new Set();
        for (const caller of callers) {
          if (!parentMap.has(caller)) parentMap.set(caller, new Set());
          parentMap.get(caller).add(node);

          if (!visited.has(caller)) {
            visited.add(caller);
            next.push(caller);
          }
        }
      }
      frontier = next;
    }

    // Now build the trie top-down.
    // Root nodes are callers that have no callers themselves (or whose callers
    // are not in the transitive set) — i.e. files that are not called by
    // anything else in the upstream closure.
    const allUpstream = new Set(parentMap.keys());

    // A node is a "root" in the upstream tree if none of the other upstream
    // nodes call it (i.e. it has no incoming edges within the upstream set).
    const hasUpstreamCaller = new Set();
    for (const [caller, children] of parentMap) {
      for (const child of children) {
        if (child !== targetFile) hasUpstreamCaller.add(child);
      }
    }

    const rootCallers = [...allUpstream].filter(f => !hasUpstreamCaller.has(f));

    // Recursively build DepNode-like objects
    const buildNode = (filePath, depth, seen = new Set()) => {
      if (seen.has(filePath)) return null; // cycle guard
      seen = new Set(seen);
      seen.add(filePath);

      const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
      const params = this.getParams(filePath);

      // Children: files that this caller calls, that are also in the upstream tree
      // (i.e. intermediate nodes between this caller and targetFile)
      const children = parentMap.get(filePath) || new Set();
      const childNodes = [];
      for (const child of children) {
        if (child === targetFile) continue; // don't show the target itself
        const childNode = buildNode(child, depth + 1, seen);
        if (childNode) childNodes.push(childNode);
      }

      return {
        kind: 'file',
        label: path.basename(filePath),
        relativePath: rel,
        filePath,
        paramCount: params.length,
        requiredCount: params.filter(p => p.required).length,
        hasChildren: childNodes.length > 0,
        childNodes,
      };
    };

    const nodes = [];
    for (const root of rootCallers) {
      const node = buildNode(root, 0);
      if (node) nodes.push(node);
    }

    return { nodes, directCallerCount: directCallers.size };
  }

  // ── Index building ──────────────────────────────────────────────────────────

  /**
   * Builds the full index by scanning all YAML files in `workspaceRoot`.
   * This is called once on activation and runs synchronously (fast enough
   * with fileCache — typically <50ms for 300 files).
   *
   * @param {string} workspaceRoot
   */
  build(workspaceRoot) {
    this._workspaceRoot = workspaceRoot;
    this._forwardAdj.clear();
    this._reverseAdj.clear();
    this._params.clear();
    this._allFiles.clear();
    this._ready = false;

    const allYaml = collectYamlFiles(workspaceRoot);
    for (const filePath of allYaml) {
      this._allFiles.add(filePath);
      this._indexFile(filePath);
    }

    this._ready = true;
    this._fireReady();
  }

  /**
   * Re-indexes a single file after it changes on disk.
   * Removes the file's old edges and re-computes them.
   * Called by the file-system watcher.
   *
   * @param {string} filePath
   */
  rebuildFile(filePath) {
    // Remove old forward edges from this file
    const oldCallees = this._forwardAdj.get(filePath) || new Set();
    for (const callee of oldCallees) {
      const callers = this._reverseAdj.get(callee);
      if (callers) {
        callers.delete(filePath);
        if (callers.size === 0) this._reverseAdj.delete(callee);
      }
    }
    this._forwardAdj.delete(filePath);
    this._params.delete(filePath);

    // Re-index the file (fileCache.invalidate was already called by the watcher)
    if (this._allFiles.has(filePath)) {
      this._indexFile(filePath);
    }
  }

  /**
   * Adds a newly-created file to the index.
   * @param {string} filePath
   */
  addFile(filePath) {
    this._allFiles.add(filePath);
    this._indexFile(filePath);
  }

  /**
   * Removes a deleted file from the index.
   * @param {string} filePath
   */
  removeFile(filePath) {
    this._allFiles.delete(filePath);
    this._params.delete(filePath);

    // Remove forward edges
    const callees = this._forwardAdj.get(filePath) || new Set();
    for (const callee of callees) {
      const callers = this._reverseAdj.get(callee);
      if (callers) {
        callers.delete(filePath);
        if (callers.size === 0) this._reverseAdj.delete(callee);
      }
    }
    this._forwardAdj.delete(filePath);

    // Remove reverse edges (files that called this file)
    this._reverseAdj.delete(filePath);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Indexes a single file: parses its template references and updates
   * forwardAdj and reverseAdj.
   * @param {string} filePath
   * @private
   */
  _indexFile(filePath) {
    const text = fileCache.readFile(filePath);
    if (!text) return;

    // Cache parameters
    const params = parseParameters(text);
    this._params.set(filePath, params);

    // Parse template references
    const aliases = parseRepositoryAliases(text);
    const refs = extractTemplateRefs(filePath);

    const callees = new Set();

    for (const { templateRef } of refs) {
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;

      const resolved = resolveTemplatePath(templateRef, filePath, aliases);
      if (!resolved || resolved.unknownAlias || !resolved.filePath) continue;

      const targetPath = resolved.filePath;
      callees.add(targetPath);

      // Update reverse adjacency
      if (!this._reverseAdj.has(targetPath)) {
        this._reverseAdj.set(targetPath, new Set());
      }
      this._reverseAdj.get(targetPath).add(filePath);
    }

    this._forwardAdj.set(filePath, callees);
  }

  _fireReady() {
    for (const cb of this._readyCallbacks) {
      try { cb(); } catch { /* ignore */ }
    }
    this._readyCallbacks = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

/** @type {WorkspaceIndex} */
const _instance = new WorkspaceIndex();

module.exports = {
  WorkspaceIndex,
  /** The singleton instance used by all extension modules. */
  workspaceIndex: _instance,
};
