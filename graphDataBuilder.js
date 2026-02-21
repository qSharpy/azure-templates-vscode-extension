'use strict';

/**
 * graphDataBuilder.js
 *
 * Pure Node.js functions (no vscode dependency) that scan a workspace
 * directory and build the graph data (nodes + edges) for the Template Graph
 * WebView panel.
 *
 * Kept separate from graphWebViewProvider.js so these functions can be
 * unit-tested without a VS Code host.
 */

const fs        = require('fs');
const path      = require('path');
const fileCache = require('./fileCache');
const {
  parseRepositoryAliases,
  parseParameters,
  resolveTemplatePath,
} = require('./hoverProvider');

// ---------------------------------------------------------------------------
// collectYamlFiles
// ---------------------------------------------------------------------------

/**
 * Recursively collects all *.yml / *.yaml files under `dir`,
 * skipping common non-pipeline directories.
 *
 * @param {string}   dir
 * @param {string[]} [acc]
 * @returns {string[]}  Absolute file paths
 */
function collectYamlFiles(dir, acc = []) {
  const SKIP = new Set(['.git', 'node_modules', '.vscode', 'dist', 'out', 'build']);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectYamlFiles(full, acc);
    } else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// isPipelineRoot
// ---------------------------------------------------------------------------

/**
 * Determines whether a YAML file looks like an Azure Pipeline root file
 * (has `trigger:`, `pr:`, `schedules:`, or `stages:` at the top level).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isPipelineRoot(text) {
  return /^(?:trigger|pr|schedules|stages|jobs|steps)\s*:/m.test(text);
}

// ---------------------------------------------------------------------------
// extractTemplateRefs
// ---------------------------------------------------------------------------

/**
 * Parses a single YAML file and returns the raw template references it contains.
 *
 * @param {string} filePath
 * @returns {{ templateRef: string, line: number }[]}
 */
function extractTemplateRefs(filePath) {
  const text = fileCache.readFile(filePath);
  if (!text) return [];
  const refs = [];
  // Normalize CRLF → LF so that regex $ anchors work on Windows-authored files
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Strip YAML line comments before matching to avoid false positives from
    // lines like:  # ── Step template: build the .NET project ──
    const stripped = lines[i].replace(/(^\s*#.*|\s#.*)$/, '');
    const m = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(stripped);
    if (m) refs.push({ templateRef: m[1].trim(), line: i });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// buildWorkspaceGraph
// ---------------------------------------------------------------------------

/**
 * @typedef {'pipeline'|'local'|'external'|'missing'|'unknown'} NodeKind
 *
 * @typedef {object} GraphNode
 * @property {string}   id
 * @property {string}   label
 * @property {NodeKind} kind
 * @property {string}   [filePath]
 * @property {string}   [repoName]
 * @property {string}   [alias]
 * @property {number}   paramCount
 * @property {number}   requiredCount
 *
 * @typedef {object} GraphEdge
 * @property {string} source
 * @property {string} target
 * @property {string} [label]
 */

/**
 * Builds the full graph data (nodes + edges) by scanning every YAML file
 * in the workspace root (or a sub-directory of it).
 *
 * @param {string} workspaceRoot  Absolute path to the workspace folder
 * @param {string} [subPath]      Optional relative sub-path to scan instead of the full root.
 *                                E.g. "templates" or "pipelines/api".
 *                                If empty / falsy the entire workspace is scanned.
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
function buildWorkspaceGraph(workspaceRoot, subPath) {
  const scanRoot = (subPath && subPath.trim())
    ? path.join(workspaceRoot, subPath.trim().replace(/^[/\\]+/, ''))
    : workspaceRoot;

  const yamlFiles = collectYamlFiles(scanRoot);

  /** @type {Map<string, GraphNode>} */
  const nodeMap = new Map();

  /** @type {Set<string>} edge dedup key = "sourceId→targetId" */
  const edgeKeys = new Set();

  /** @type {GraphEdge[]} */
  const edges = [];

  // ── Pass 1: register every YAML file as a node ──────────────────────────
  for (const filePath of yamlFiles) {
    const text = fileCache.readFile(filePath) || '';

    const kind = isPipelineRoot(text) ? 'pipeline' : 'local';
    nodeMap.set(filePath, {
      id: filePath,
      label: path.basename(filePath),
      relativePath: path.relative(workspaceRoot, filePath).replace(/\\/g, '/'),
      kind,
      filePath,
      paramCount: 0,
      requiredCount: 0,
    });
  }

  // ── Pass 2: for each file, resolve its template references ───────────────
  for (const filePath of yamlFiles) {
    const text = fileCache.readFile(filePath);
    if (!text) continue;

    const repoAliases = parseRepositoryAliases(text);
    const refs = extractTemplateRefs(filePath);

    for (const { templateRef } of refs) {
      // Skip variable expressions
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;

      const resolved = resolveTemplatePath(templateRef, filePath, repoAliases);
      if (!resolved) continue;

      let targetId;
      let edgeLabel;

      if (resolved.unknownAlias) {
        // Synthetic node for unknown alias
        targetId = `UNKNOWN_ALIAS:${resolved.alias}:${templateRef}`;
        if (!nodeMap.has(targetId)) {
          nodeMap.set(targetId, {
            id: targetId,
            label: path.basename(templateRef.split('@')[0]),
            kind: 'unknown',
            alias: resolved.alias,
            paramCount: 0,
            requiredCount: 0,
          });
        }
        edgeLabel = `@${resolved.alias}`;
      } else {
        const { filePath: resolvedPath, repoName, alias } = resolved;

        if (!resolvedPath) continue;

        if (!fileCache.fileExists(resolvedPath)) {
          // Missing file node
          targetId = `MISSING:${resolvedPath}`;
          if (!nodeMap.has(targetId)) {
            nodeMap.set(targetId, {
              id: targetId,
              label: path.basename(resolvedPath),
              kind: 'missing',
              filePath: resolvedPath,
              repoName,
              paramCount: 0,
              requiredCount: 0,
            });
          }
        } else {
          targetId = resolvedPath;

          // Ensure the target node exists (may be outside workspace)
          if (!nodeMap.has(targetId)) {
            nodeMap.set(targetId, {
              id: targetId,
              label: path.basename(resolvedPath),
              relativePath: path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/'),
              kind: repoName ? 'external' : 'local',
              filePath: resolvedPath,
              repoName,
              paramCount: 0,
              requiredCount: 0,
            });
          }

          // Upgrade kind to 'external' if referenced via a repo alias
          const existingNode = nodeMap.get(targetId);
          if (repoName && existingNode.kind !== 'external') {
            existingNode.kind = 'external';
            existingNode.repoName = repoName;
          }

          if (alias && alias !== 'self') {
            edgeLabel = `@${alias}`;
          }
        }
      }

      // Add edge (deduplicated)
      const edgeKey = `${filePath}→${targetId}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        const edge = { source: filePath, target: targetId };
        if (edgeLabel) edge.label = edgeLabel;
        edges.push(edge);
      }
    }
  }
  // ── Pass 3: fill in paramCount for all resolvable nodes ──────────────────
  for (const [, node] of nodeMap) {
    if (node.filePath && node.kind !== 'missing') {
      const tplText = fileCache.readFile(node.filePath);
      if (tplText) {
        const params = parseParameters(tplText);
        node.paramCount = params.length;
        node.requiredCount = params.filter(p => p.required).length;
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

// ---------------------------------------------------------------------------
// buildFileGraph
// ---------------------------------------------------------------------------

/**
 * Ensures a real (non-missing, non-unknown) file node exists in nodeMap and
 * returns its id, or null if the file cannot be resolved / does not exist.
 *
 * @param {string}              filePath
 * @param {string}              workspaceRoot
 * @param {Map<string,GraphNode>} nodeMap
 * @param {string|null}         [repoName]
 * @returns {string|null}  node id
 */
function _ensureFileNode(filePath, workspaceRoot, nodeMap, repoName = null) {
  if (nodeMap.has(filePath)) return filePath;

  let paramCount = 0;
  let requiredCount = 0;
  const text = fileCache.readFile(filePath) || '';
  if (text) {
    const params = parseParameters(text);
    paramCount = params.length;
    requiredCount = params.filter(p => p.required).length;
  }

  const kind = repoName ? 'external' : (isPipelineRoot(text) ? 'pipeline' : 'local');
  nodeMap.set(filePath, {
    id: filePath,
    label: path.basename(filePath),
    relativePath: path.relative(workspaceRoot, filePath).replace(/\\/g, '/'),
    kind,
    filePath,
    repoName: repoName || undefined,
    paramCount,
    requiredCount,
  });
  return filePath;
}

/**
 * Builds a scoped graph for a single file using multi-level BFS.
 *
 * Downstream BFS: starting from `filePath`, follows template references up to
 * `depth` levels deep.
 *
 * Upstream BFS: starting from `filePath`, finds all workspace files that
 * (transitively) call it, up to `depth` levels up.
 *
 * @param {string} filePath      Absolute path to the pipeline / template file
 * @param {string} workspaceRoot Absolute path to the workspace root
 * @param {number} [depth=1]     How many BFS levels to traverse (1–10)
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
function buildFileGraph(filePath, workspaceRoot, depth = 1) {
  const maxDepth = Math.max(1, Math.min(10, depth));

  /** @type {Map<string, GraphNode>} */
  const nodeMap = new Map();
  /** @type {GraphEdge[]} */
  const edges = [];
  /** @type {Set<string>} */
  const edgeKeys = new Set();

  // ── Root node ─────────────────────────────────────────────────────────────
  let rootText = fileCache.readFile(filePath) || '';

  const rootKind = isPipelineRoot(rootText) ? 'pipeline' : 'local';
  const rootParams = parseParameters(rootText);
  nodeMap.set(filePath, {
    id: filePath,
    label: path.basename(filePath),
    relativePath: path.relative(workspaceRoot, filePath).replace(/\\/g, '/'),
    kind: rootKind,
    filePath,
    paramCount: rootParams.length,
    requiredCount: rootParams.filter(p => p.required).length,
    isScope: true,
  });

  // ── Downstream BFS ────────────────────────────────────────────────────────
  // Queue entries: { filePath, currentDepth }
  /** @type {{ fp: string, d: number }[]} */
  let downQueue = [{ fp: filePath, d: 0 }];
  /** @type {Set<string>} visited set to avoid re-processing */
  const downVisited = new Set([filePath]);

  while (downQueue.length > 0) {
    const next = [];
    for (const { fp: curFile, d: curDepth } of downQueue) {
      if (curDepth >= maxDepth) continue;

      const curText = fileCache.readFile(curFile);
      if (!curText) continue;

      const repoAliases = parseRepositoryAliases(curText);
      const refs = extractTemplateRefs(curFile);

      for (const { templateRef } of refs) {
        if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;

        const resolved = resolveTemplatePath(templateRef, curFile, repoAliases);
        if (!resolved) continue;

        let targetId;
        let edgeLabel;

        if (resolved.unknownAlias) {
          targetId = `UNKNOWN_ALIAS:${resolved.alias}:${templateRef}`;
          if (!nodeMap.has(targetId)) {
            nodeMap.set(targetId, {
              id: targetId,
              label: path.basename(templateRef.split('@')[0]),
              kind: 'unknown',
              alias: resolved.alias,
              paramCount: 0,
              requiredCount: 0,
            });
          }
          edgeLabel = `@${resolved.alias}`;
        } else {
          const { filePath: resolvedPath, repoName, alias } = resolved;
          if (!resolvedPath) continue;

          if (!fileCache.fileExists(resolvedPath)) {
            targetId = `MISSING:${resolvedPath}`;
            if (!nodeMap.has(targetId)) {
              nodeMap.set(targetId, {
                id: targetId,
                label: path.basename(resolvedPath),
                relativePath: path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/'),
                kind: 'missing',
                filePath: resolvedPath,
                repoName,
                paramCount: 0,
                requiredCount: 0,
              });
            }
          } else {
            targetId = resolvedPath;
            _ensureFileNode(resolvedPath, workspaceRoot, nodeMap, repoName || null);

            // Upgrade to external if referenced via alias
            const existingNode = nodeMap.get(targetId);
            if (repoName && existingNode.kind !== 'external') {
              existingNode.kind = 'external';
              existingNode.repoName = repoName;
            }

            if (alias && alias !== 'self') edgeLabel = `@${alias}`;

            // Enqueue for further BFS if not yet visited
            if (!downVisited.has(resolvedPath)) {
              downVisited.add(resolvedPath);
              next.push({ fp: resolvedPath, d: curDepth + 1 });
            }
          }
        }

        // Add downstream edge: curFile → target
        const edgeKey = `${curFile}→${targetId}`;
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          const edge = { source: curFile, target: targetId, direction: 'downstream' };
          if (edgeLabel) edge.label = edgeLabel;
          edges.push(edge);
        }
      }
    }
    downQueue = next;
  }

  // ── Upstream BFS ──────────────────────────────────────────────────────────
  // Build a reverse adjacency map: targetFilePath → Set<callerFilePath>
  // We scan all workspace YAML files once and build the full reverse map,
  // then BFS upward from filePath.
  const allYaml = collectYamlFiles(workspaceRoot);

  /** @type {Map<string, Set<string>>} targetPath → set of callerPaths */
  const reverseAdj = new Map();

  for (const callerFile of allYaml) {
    const callerText = fileCache.readFile(callerFile);
    if (!callerText) continue;

    const callerAliases = parseRepositoryAliases(callerText);
    const callerRefs = extractTemplateRefs(callerFile);

    for (const { templateRef } of callerRefs) {
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;
      const resolved = resolveTemplatePath(templateRef, callerFile, callerAliases);
      if (!resolved || resolved.unknownAlias || !resolved.filePath) continue;

      const targetPath = resolved.filePath;
      if (!reverseAdj.has(targetPath)) reverseAdj.set(targetPath, new Set());
      reverseAdj.get(targetPath).add(callerFile);

      // Store the alias label on the edge later — keep a lookup map
      // key: "callerFile→targetPath", value: alias label
      const edgeInfoKey = `${callerFile}→${targetPath}`;
      if (resolved.alias && resolved.alias !== 'self') {
        // We'll look this up when adding edges below
        reverseAdj._edgeLabels = reverseAdj._edgeLabels || new Map();
        reverseAdj._edgeLabels.set(edgeInfoKey, `@${resolved.alias}`);
      }
    }
  }

  const edgeLabels = reverseAdj._edgeLabels || new Map();

  /** @type {{ fp: string, d: number }[]} */
  let upQueue = [{ fp: filePath, d: 0 }];
  const upVisited = new Set([filePath]);

  while (upQueue.length > 0) {
    const next = [];
    for (const { fp: curTarget, d: curDepth } of upQueue) {
      if (curDepth >= maxDepth) continue;

      const callers = reverseAdj.get(curTarget) || new Set();
      for (const callerFile of callers) {
        // Ensure caller node exists
        if (!nodeMap.has(callerFile)) {
          const callerText = fileCache.readFile(callerFile) || '';
          const callerKind = isPipelineRoot(callerText) ? 'pipeline' : 'local';
          let callerParamCount = 0;
          let callerRequiredCount = 0;
          if (callerText) {
            const callerParams = parseParameters(callerText);
            callerParamCount = callerParams.length;
            callerRequiredCount = callerParams.filter(p => p.required).length;
          }

          nodeMap.set(callerFile, {
            id: callerFile,
            label: path.basename(callerFile),
            relativePath: path.relative(workspaceRoot, callerFile).replace(/\\/g, '/'),
            kind: callerKind,
            filePath: callerFile,
            paramCount: callerParamCount,
            requiredCount: callerRequiredCount,
          });
        }

        // Add upstream edge: callerFile → curTarget
        const edgeKey = `${callerFile}→${curTarget}`;
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          const edge = { source: callerFile, target: curTarget, direction: 'upstream' };
          const lbl = edgeLabels.get(edgeKey);
          if (lbl) edge.label = lbl;
          edges.push(edge);
        }

        if (!upVisited.has(callerFile)) {
          upVisited.add(callerFile);
          next.push({ fp: callerFile, d: curDepth + 1 });
        }
      }
    }
    upQueue = next;
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

module.exports = {
  collectYamlFiles,
  isPipelineRoot,
  extractTemplateRefs,
  buildWorkspaceGraph,
  buildFileGraph,
};
