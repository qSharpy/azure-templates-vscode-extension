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

const fs   = require('fs');
const path = require('path');
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
  let rawBuffer;
  let text;
  try {
    rawBuffer = fs.readFileSync(filePath);
    // Detect UTF-16 BOM: FF FE (LE) or FE FF (BE)
    const isUtf16LE = rawBuffer[0] === 0xFF && rawBuffer[1] === 0xFE;
    const isUtf16BE = rawBuffer[0] === 0xFE && rawBuffer[1] === 0xFF;
    const hasUtf8BOM = rawBuffer[0] === 0xEF && rawBuffer[1] === 0xBB && rawBuffer[2] === 0xBF;
    if (isUtf16LE || isUtf16BE) {
      console.log(`[ATN DEBUG] extractTemplateRefs ENCODING: file="${filePath}" encoding=${isUtf16LE ? 'UTF-16LE' : 'UTF-16BE'} — reading as utf16le`);
      text = rawBuffer.toString('utf16le');
      // Strip BOM character if present
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    } else {
      text = rawBuffer.toString('utf8');
      if (hasUtf8BOM) {
        console.log(`[ATN DEBUG] extractTemplateRefs ENCODING: file="${filePath}" has UTF-8 BOM`);
        text = text.slice(1); // remove BOM char
      }
    }
  } catch {
    return [];
  }
  const refs = [];
  const hasCRLF = text.includes('\r\n');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Strip YAML line comments before matching to avoid false positives from
    // lines like:  # ── Step template: build the .NET project ──
    const stripped = lines[i].replace(/(^\s*#.*|\s#.*)$/, '');
    const m = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(stripped);
    if (m) refs.push({ templateRef: m[1].trim(), line: i });
  }
  // If the file has "template" text but we found zero refs, log the raw lines to diagnose
  const hasTemplateLine = lines.some(l => /template/i.test(l));
  if (hasTemplateLine && refs.length === 0) {
    const sampleLines = lines
      .map((l, i) => ({ i, raw: l }))
      .filter(({ raw }) => /template/i.test(raw))
      .slice(0, 3)
      .map(({ i, raw }) => `L${i}:${JSON.stringify(raw)}`);
    console.log(`[ATN DEBUG] extractTemplateRefs ZERO REFS: file="${filePath}" hasCRLF=${hasCRLF} sampleLines=[${sampleLines.join(', ')}]`);
  } else if (refs.length === 0 && rawBuffer.length > 0) {
    // Log first 20 bytes as hex to detect unexpected encoding
    const hexDump = Array.from(rawBuffer.slice(0, 20)).map(b => b.toString(16).padStart(2,'0')).join(' ');
    const firstLine = lines[0] ? JSON.stringify(lines[0].slice(0, 80)) : '(empty)';
    console.log(`[ATN DEBUG] extractTemplateRefs NO TEMPLATE WORD: file="${filePath}" hasCRLF=${hasCRLF} firstBytes=[${hexDump}] firstLine=${firstLine}`);
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
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { /* skip */ }

    const kind = isPipelineRoot(text) ? 'pipeline' : 'local';
    nodeMap.set(filePath, {
      id: filePath,
      label: path.basename(filePath),
      kind,
      filePath,
      paramCount: 0,
      requiredCount: 0,
    });
  }

  // ── Pass 2: for each file, resolve its template references ───────────────
  console.log(`[ATN DEBUG] buildWorkspaceGraph Pass2: nodeMap has ${nodeMap.size} nodes. Keys sample: ${[...nodeMap.keys()].slice(0,3).join(' | ')}`);
  let totalRefs = 0, skippedVar = 0, nullResolved = 0, missingFile = 0, edgesAdded = 0;
  for (const filePath of yamlFiles) {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

    const repoAliases = parseRepositoryAliases(text);
    const refs = extractTemplateRefs(filePath);

    for (const { templateRef } of refs) {
      totalRefs++;
      // Skip variable expressions
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) { skippedVar++; continue; }

      const resolved = resolveTemplatePath(templateRef, filePath, repoAliases);
      if (!resolved) { nullResolved++; continue; }

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

        if (!fs.existsSync(resolvedPath)) {
          missingFile++;
          // Missing file node
          console.log(`[ATN DEBUG] Pass2 MISSING: templateRef="${templateRef}" resolvedPath="${resolvedPath}" sourceFile="${filePath}"`);
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
          const nodeMapHit = nodeMap.has(targetId);
          if (!nodeMapHit) {
            console.log(`[ATN DEBUG] Pass2 nodeMap MISS: targetId="${targetId}" (not found in nodeMap). Source="${filePath}" ref="${templateRef}"`);
            // Log a sample of nodeMap keys to check for separator/case differences
            const keys = [...nodeMap.keys()];
            const similar = keys.filter(k => k.toLowerCase().includes(path.basename(resolvedPath).toLowerCase()));
            if (similar.length > 0) console.log(`[ATN DEBUG]   Similar keys in nodeMap: ${similar.join(' | ')}`);
            nodeMap.set(targetId, {
              id: targetId,
              label: path.basename(resolvedPath),
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
        edgesAdded++;
        const edge = { source: filePath, target: targetId };
        if (edgeLabel) edge.label = edgeLabel;
        edges.push(edge);
      }
    }
  }
  console.log(`[ATN DEBUG] buildWorkspaceGraph Pass2 SUMMARY: totalRefs=${totalRefs} skippedVar=${skippedVar} nullResolved=${nullResolved} missingFile=${missingFile} edgesAdded=${edgesAdded} finalEdges=${edges.length}`);

  // ── Pass 3: fill in paramCount for all resolvable nodes ──────────────────
  for (const [, node] of nodeMap) {
    if (node.filePath && node.kind !== 'missing') {
      try {
        const tplText = fs.readFileSync(node.filePath, 'utf8');
        const params = parseParameters(tplText);
        node.paramCount = params.length;
        node.requiredCount = params.filter(p => p.required).length;
      } catch { /* ignore */ }
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
 * Adds a resolved downstream template reference as a node+edge to the given
 * nodeMap / edges / edgeKeys collections.
 *
 * @param {string}              sourceId   ID of the source node (the caller)
 * @param {string}              templateRef Raw template reference string
 * @param {string}              callerFile  Absolute path of the file that contains the ref
 * @param {object}              resolved    Result of resolveTemplatePath()
 * @param {Map<string,GraphNode>} nodeMap
 * @param {GraphEdge[]}         edges
 * @param {Set<string>}         edgeKeys
 * @param {'downstream'|'upstream'} direction
 */
function _addResolvedRef(sourceId, templateRef, callerFile, resolved, nodeMap, edges, edgeKeys, direction) {
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
    if (!resolvedPath) return;

    if (!fs.existsSync(resolvedPath)) {
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
      if (!nodeMap.has(targetId)) {
        let childParamCount = 0;
        let childRequiredCount = 0;
        try {
          const childText = fs.readFileSync(resolvedPath, 'utf8');
          const childParams = parseParameters(childText);
          childParamCount = childParams.length;
          childRequiredCount = childParams.filter(p => p.required).length;
        } catch { /* ignore */ }

        nodeMap.set(targetId, {
          id: targetId,
          label: path.basename(resolvedPath),
          kind: repoName ? 'external' : 'local',
          filePath: resolvedPath,
          repoName,
          paramCount: childParamCount,
          requiredCount: childRequiredCount,
        });
      }

      // Upgrade to external if referenced via alias
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

  // For upstream direction the edge goes: caller → active file (sourceId is the caller)
  // For downstream direction the edge goes: active file → template (sourceId is the active file)
  const edgeSrc = direction === 'upstream' ? targetId : sourceId;
  const edgeTgt = direction === 'upstream' ? sourceId : targetId;

  const edgeKey = `${edgeSrc}→${edgeTgt}`;
  if (!edgeKeys.has(edgeKey)) {
    edgeKeys.add(edgeKey);
    const edge = { source: edgeSrc, target: edgeTgt, direction };
    if (edgeLabel) edge.label = edgeLabel;
    edges.push(edge);
  }
}

/**
 * Builds a scoped graph for a single file: the file itself as the root node,
 * plus all templates it directly references (downstream, depth = 1) AND all
 * workspace files that reference it (upstream callers, depth = 1).
 *
 * @param {string} filePath      Absolute path to the pipeline / template file
 * @param {string} workspaceRoot Absolute path to the workspace root (used for
 *                               resolving relative template references)
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
function buildFileGraph(filePath, workspaceRoot) {
  /** @type {Map<string, GraphNode>} */
  const nodeMap = new Map();
  /** @type {GraphEdge[]} */
  const edges = [];
  /** @type {Set<string>} */
  const edgeKeys = new Set();

  // ── Root node ─────────────────────────────────────────────────────────────
  let rootText = '';
  try { rootText = fs.readFileSync(filePath, 'utf8'); } catch { /* skip */ }

  const rootKind = isPipelineRoot(rootText) ? 'pipeline' : 'local';
  const rootParams = parseParameters(rootText);
  nodeMap.set(filePath, {
    id: filePath,
    label: path.basename(filePath),
    kind: rootKind,
    filePath,
    paramCount: rootParams.length,
    requiredCount: rootParams.filter(p => p.required).length,
    isScope: true,   // marks this as the "scoped" focal node
  });

  // ── Downstream: direct children (templates called by this file) ───────────
  const repoAliases = parseRepositoryAliases(rootText);
  const refs = extractTemplateRefs(filePath);

  for (const { templateRef } of refs) {
    if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;
    const resolved = resolveTemplatePath(templateRef, filePath, repoAliases);
    if (!resolved) continue;
    _addResolvedRef(filePath, templateRef, filePath, resolved, nodeMap, edges, edgeKeys, 'downstream');
  }

  // ── Upstream: find all workspace YAML files that reference this file ───────
  const allYaml = collectYamlFiles(workspaceRoot);
  for (const callerFile of allYaml) {
    if (callerFile === filePath) continue;

    let callerText = '';
    try { callerText = fs.readFileSync(callerFile, 'utf8'); } catch { continue; }

    const callerAliases = parseRepositoryAliases(callerText);
    const callerRefs = extractTemplateRefs(callerFile);

    for (const { templateRef } of callerRefs) {
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;
      const resolved = resolveTemplatePath(templateRef, callerFile, callerAliases);
      if (!resolved) continue;

      // Only care about refs that resolve to our focal file
      const resolvedPath = resolved.filePath;
      if (!resolvedPath || resolvedPath !== filePath) continue;

      // Ensure the caller node exists
      if (!nodeMap.has(callerFile)) {
        const callerKind = isPipelineRoot(callerText) ? 'pipeline' : 'local';
        let callerParamCount = 0;
        let callerRequiredCount = 0;
        try {
          const callerParams = parseParameters(callerText);
          callerParamCount = callerParams.length;
          callerRequiredCount = callerParams.filter(p => p.required).length;
        } catch { /* ignore */ }

        nodeMap.set(callerFile, {
          id: callerFile,
          label: path.basename(callerFile),
          kind: callerKind,
          filePath: callerFile,
          paramCount: callerParamCount,
          requiredCount: callerRequiredCount,
        });
      }

      // Add upstream edge: caller → focal file
      const edgeKey = `${callerFile}→${filePath}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        const edge = { source: callerFile, target: filePath, direction: 'upstream' };
        if (resolved.alias && resolved.alias !== 'self') edge.label = `@${resolved.alias}`;
        edges.push(edge);
      }
    }
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
