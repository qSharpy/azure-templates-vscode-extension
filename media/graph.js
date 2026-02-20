/* eslint-env browser */
/* global d3, acquireVsCodeApi */
'use strict';

// ---------------------------------------------------------------------------
// VS Code API bridge
// ---------------------------------------------------------------------------
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allNodes = [];
let allEdges = [];
let simulation = null;
let fileScopeEnabled = true; // mirrors _fileScopeEnabled on the extension side
let scopedFilePath = null;   // the focal file when in file-scope mode
let showFullPath = false;    // whether to show workspace-relative paths as node labels
let graphDepth = 1;          // current BFS depth for file-scope mode (1–10)

/** @type {Array<{filePath:string,filename:string,relativePath:string,directory:string}>} */
let searchIndex = [];        // all workspace YAML files for the search bar

// ---------------------------------------------------------------------------
// Colour palette (matches legend in HTML)
// ---------------------------------------------------------------------------
const KIND_COLOR = {
  pipeline: '#4e9de0',
  local:    '#3dba8a',
  external: '#9b6fd4',
  missing:  '#e05c5c',
  unknown:  '#e09a3d',
};

const KIND_RADIUS = {
  pipeline: 18,
  local:    13,
  external: 15,
  missing:  11,
  unknown:  11,
};

const KIND_STROKE = {
  pipeline: '#2a7abf',
  local:    '#1f8a5e',
  external: '#6a3fa8',
  missing:  '#b03030',
  unknown:  '#b06a10',
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------
const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchEmpty   = document.getElementById('search-empty');

let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value), 120);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const first = searchResults.querySelector('.sr-item');
    if (first) first.focus();
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

searchResults.addEventListener('keydown', (e) => {
  const items = [...searchResults.querySelectorAll('.sr-item')];
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < items.length - 1) items[idx + 1].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) items[idx - 1].focus();
    else searchInput.focus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (document.activeElement && document.activeElement.dataset.filepath) {
      openSearchResult(document.activeElement.dataset.filepath);
    }
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

// Close dropdown when clicking outside the search bar
document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-bar')) closeSearch();
});

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) { closeSearch(); return; }

  const hits = searchIndex.filter(item =>
    item.relativePath.toLowerCase().includes(q) ||
    item.filename.toLowerCase().includes(q)
  ).slice(0, 30);

  renderSearchResults(hits);
}

function renderSearchResults(hits) {
  // Remove old items (keep the #search-empty sentinel)
  searchResults.querySelectorAll('.sr-item').forEach(el => el.remove());

  if (hits.length === 0) {
    searchEmpty.style.display = 'block';
    searchResults.classList.add('open');
    return;
  }

  searchEmpty.style.display = 'none';
  searchResults.classList.add('open');

  for (const item of hits) {
    const el = document.createElement('div');
    el.className = 'sr-item';
    el.tabIndex = 0;
    el.dataset.filepath = item.filePath;
    el.title = item.relativePath;

    const name = document.createElement('div');
    name.className = 'sr-name';
    name.textContent = item.filename;

    const dir = document.createElement('div');
    dir.className = 'sr-path';
    dir.textContent = item.directory || item.relativePath;

    el.appendChild(name);
    el.appendChild(dir);

    el.addEventListener('mousedown', (e) => {
      // Use mousedown so it fires before the blur that would close the dropdown
      e.preventDefault();
      openSearchResult(item.filePath);
    });

    searchResults.appendChild(el);
  }
}

function openSearchResult(filePath) {
  closeSearch();
  vscode.postMessage({ type: 'openFile', filePath });
}

function closeSearch() {
  searchResults.classList.remove('open');
  searchInput.value = '';
}

// ---------------------------------------------------------------------------
// DOM refs (graph)
// ---------------------------------------------------------------------------
const svgEl          = document.getElementById('svg');
const zoomLayer      = document.getElementById('zoom-layer');
const edgesLayer     = document.getElementById('edges-layer');
const edgeLabels     = document.getElementById('edge-labels-layer');
const nodesLayer     = document.getElementById('nodes-layer');
const ctxMenu        = document.getElementById('ctx-menu');
const emptyState     = document.getElementById('empty-state');
const btnFileScope   = document.getElementById('btn-file-scope');
const btnFullPath    = document.getElementById('btn-full-path');
const depthControls  = document.getElementById('depth-controls');
const depthValue     = document.getElementById('depth-value');
const btnDepthDec    = document.getElementById('btn-depth-dec');
const btnDepthInc    = document.getElementById('btn-depth-inc');

const svg = d3.select(svgEl);

// ---------------------------------------------------------------------------
// Zoom behaviour
// ---------------------------------------------------------------------------
const zoom = d3.zoom()
  .scaleExtent([0.05, 4])
  .on('zoom', (event) => {
    d3.select(zoomLayer).attr('transform', event.transform);
  });

svg.call(zoom);

// ---------------------------------------------------------------------------
// Legend toggle
// ---------------------------------------------------------------------------
document.getElementById('legend-toggle').addEventListener('click', () => {
  document.getElementById('legend').classList.toggle('open');
});

// ---------------------------------------------------------------------------
// Toolbar buttons
// ---------------------------------------------------------------------------
document.getElementById('btn-fit').addEventListener('click', fitView);

// ---------------------------------------------------------------------------
// File-scope toggle button
// ---------------------------------------------------------------------------

/**
 * Updates the visual state of the file-scope button to match `fileScopeEnabled`.
 */
function updateFileScopeButton() {
  if (fileScopeEnabled) {
    btnFileScope.classList.add('active');
    btnFileScope.textContent = '📄 File';
    btnFileScope.title = 'Showing current file only — click to show full workspace graph';
  } else {
    btnFileScope.classList.remove('active');
    btnFileScope.textContent = '📄 Workspace';
    btnFileScope.title = 'Scope graph to the currently open file (shows parent + direct children only)';
  }
}

btnFileScope.addEventListener('click', () => {
  fileScopeEnabled = !fileScopeEnabled;
  updateFileScopeButton();
  updateDepthControls();
  vscode.postMessage({ type: 'setFileScope', enabled: fileScopeEnabled });
});

// ---------------------------------------------------------------------------
// Depth controls (file-scope mode only)
// ---------------------------------------------------------------------------

/**
 * Updates the depth controls UI to reflect the current `graphDepth` value
 * and shows/hides the controls based on whether file-scope mode is active.
 */
function updateDepthControls() {
  if (fileScopeEnabled) {
    depthControls.classList.add('visible');
  } else {
    depthControls.classList.remove('visible');
  }
  depthValue.textContent = String(graphDepth);
  btnDepthDec.disabled = graphDepth <= 1;
  btnDepthInc.disabled = graphDepth >= 10;
}

btnDepthDec.addEventListener('click', () => {
  if (graphDepth <= 1) return;
  graphDepth--;
  updateDepthControls();
  vscode.postMessage({ type: 'setDepth', depth: graphDepth });
});

btnDepthInc.addEventListener('click', () => {
  if (graphDepth >= 10) return;
  graphDepth++;
  updateDepthControls();
  vscode.postMessage({ type: 'setDepth', depth: graphDepth });
});

// ---------------------------------------------------------------------------
// Full-path toggle button
// ---------------------------------------------------------------------------

/**
 * Updates the visual state of the full-path button and re-renders node labels.
 */
function updateFullPathButton() {
  if (showFullPath) {
    btnFullPath.classList.add('active');
    btnFullPath.title = 'Showing full workspace-relative paths — click to show filenames only';
  } else {
    btnFullPath.classList.remove('active');
    btnFullPath.title = 'Toggle between filename and full workspace-relative path labels';
  }
}

btnFullPath.addEventListener('click', () => {
  showFullPath = !showFullPath;
  updateFullPathButton();
  // Re-render node labels in place without rebuilding the whole graph
  updateNodeLabels();
});

/**
 * Returns the display label for a node based on the current showFullPath setting.
 * @param {object} d  node datum
 * @returns {string}
 */
function nodeLabel(d) {
  if (showFullPath && d.relativePath) {
    return d.relativePath;
  }
  return d.label;
}

/**
 * Updates only the text labels of existing nodes (no simulation restart needed).
 */
function updateNodeLabels() {
  d3.select(nodesLayer).selectAll('g.node').select('text:last-of-type')
    .text(d => truncate(nodeLabel(d), showFullPath ? 40 : 24));
}

// ---------------------------------------------------------------------------
// Context menu — dismiss on outside click or Escape
// ---------------------------------------------------------------------------
document.addEventListener('click', () => hideCtxMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

function showCtxMenu(event, d) {
  event.preventDefault();
  event.stopPropagation();

  // Build menu items
  const items = ctxMenu.querySelectorAll('.ctx-item');
  items.forEach(el => el.remove());

  if (d.filePath && d.kind !== 'missing' && d.kind !== 'unknown') {
    addCtxItem('$(go-to-file) Open file', () => {
      vscode.postMessage({ type: 'openFile', filePath: d.filePath });
    });
    addCtxItem('$(split-horizontal) Open to side', () => {
      vscode.postMessage({ type: 'openFileBeside', filePath: d.filePath });
    });
  }
  if (d.filePath) {
    addCtxItem('$(copy) Copy path', () => {
      vscode.postMessage({ type: 'copyPath', text: d.filePath });
    });
  }

  if (!ctxMenu.querySelector('.ctx-item')) return; // nothing to show

  const container = document.getElementById('graph-container');
  const rect = container.getBoundingClientRect();
  let x = event.clientX - rect.left;
  let y = event.clientY - rect.top;

  ctxMenu.style.display = 'block';
  // Clamp so menu stays inside container
  const mw = ctxMenu.offsetWidth  || 160;
  const mh = ctxMenu.offsetHeight || 80;
  if (x + mw > rect.width  - 4) x = rect.width  - mw - 4;
  if (y + mh > rect.height - 4) y = rect.height - mh - 4;
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top  = `${y}px`;
}

function addCtxItem(label, onClick) {
  const el = document.createElement('div');
  el.className = 'ctx-item';
  el.textContent = label;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    hideCtxMenu();
    onClick();
  });
  ctxMenu.appendChild(el);
}

function hideCtxMenu() {
  ctxMenu.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Message handler (from extension host)
// ---------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'searchData':
      // Receive the full file list for client-side search filtering
      searchIndex = msg.items || [];
      break;

    case 'graphData':
      // Sync file-scope state from the extension (e.g. on first load)
      if (typeof msg.fileScopeEnabled === 'boolean' && msg.fileScopeEnabled !== fileScopeEnabled) {
        fileScopeEnabled = msg.fileScopeEnabled;
        updateFileScopeButton();
      }

      // Sync depth from the extension (e.g. on first load or panel open)
      if (typeof msg.graphDepth === 'number' && msg.graphDepth !== graphDepth) {
        graphDepth = msg.graphDepth;
      }
      updateDepthControls();

      // Track the focal file for upstream/downstream colouring
      scopedFilePath = msg.scopedFile || null;

      // Update stats label to show scope context
      renderGraph(msg.nodes, msg.edges, msg.scopedFile);
      break;
    case 'noWorkspace':
      showEmpty('Open a workspace folder to explore template dependencies.');
      break;
    case 'error':
      showEmpty(`Error: ${msg.message}`);
      break;
    default:
      break;
  }
});

// Signal to the extension that we're ready
vscode.postMessage({ type: 'ready' });

// ---------------------------------------------------------------------------
// Hierarchical layout helpers
// ---------------------------------------------------------------------------

/**
 * Assigns a BFS depth layer to every node, starting from pipeline roots.
 * Nodes not reachable from any root get layer = max_layer + 1.
 *
 * @param {object[]} nodes
 * @param {object[]} edges  – raw edge objects (source/target are ids at this point)
 * @returns {Map<string, number>}  nodeId → layer
 */
function computeLayers(nodes, edges) {
  // Build adjacency list (directed: source → target)
  /** @type {Map<string, string[]>} */
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    const sid = typeof e.source === 'object' ? e.source.id : e.source;
    const tid = typeof e.target === 'object' ? e.target.id : e.target;
    if (adj.has(sid)) adj.get(sid).push(tid);
  }

  const layer = new Map();
  const queue = [];

  // Seed BFS from pipeline roots
  for (const n of nodes) {
    if (n.kind === 'pipeline') {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }

  // BFS
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const curLayer = layer.get(cur);
    for (const nxt of (adj.get(cur) || [])) {
      if (!layer.has(nxt) || layer.get(nxt) < curLayer + 1) {
        layer.set(nxt, curLayer + 1);
        queue.push(nxt);
      }
    }
  }

  // Assign orphan nodes to a layer after the deepest known layer
  const maxLayer = layer.size > 0 ? Math.max(...layer.values()) : 0;
  for (const n of nodes) {
    if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1);
  }

  return layer;
}

/**
 * Computes initial (x, y) positions using a top-down hierarchical layout.
 * Nodes in the same layer are spread horizontally with even spacing.
 *
 * @param {object[]} nodes
 * @param {Map<string, number>} layerMap
 * @param {number} width   – canvas width
 * @param {number} height  – canvas height
 */
function applyHierarchicalPositions(nodes, layerMap, width, height) {
  // Group nodes by layer
  /** @type {Map<number, object[]>} */
  const byLayer = new Map();
  for (const n of nodes) {
    const l = layerMap.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  }

  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const numLayers = layers.length;
  // Use a minimum of 140px between layers so nodes don't crowd vertically
  const minLayerGap = 140;
  const layerGap = numLayers > 1
    ? Math.max(minLayerGap, (height * 0.85) / (numLayers - 1))
    : 0;
  const topPad = height * 0.075;

  for (const l of layers) {
    const group = byLayer.get(l);
    const count = group.length;
    // Ensure at least 160px between nodes in the same layer
    const minXGap = 160;
    const naturalXGap = count > 1 ? (width * 0.85) / (count - 1) : 0;
    const xGap   = count > 1 ? Math.max(minXGap, naturalXGap) : 0;
    const xStart = count > 1 ? width / 2 - (xGap * (count - 1)) / 2 : width / 2;

    group.forEach((n, i) => {
      n.x = xStart + i * xGap;
      n.y = topPad + l * layerGap;
      // No jitter — let the simulation handle fine-tuning from clean positions
    });
  }
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Returns the stroke colour for an edge based on its direction property.
 * @param {object} e  edge datum
 * @returns {string}
 */
function edgeColor(e) {
  if (e.direction === 'upstream')   return '#e09a3d';  // amber — caller → focal
  if (e.direction === 'downstream') return '#4e9de0';  // blue  — focal → callee
  return '#666';                                        // grey  — workspace-wide
}

/**
 * @param {import('../graphWebViewProvider').GraphNode[]} nodes
 * @param {import('../graphWebViewProvider').GraphEdge[]} edges
 */
function renderGraph(nodes, edges, scopedFile) {
  if (!nodes || nodes.length === 0) {
    if (fileScopeEnabled) {
      showEmpty('Open a YAML pipeline file to scope the graph to it.');
    } else {
      showEmpty();
    }
    return;
  }

  hideEmpty();

  allNodes = nodes.map(n => Object.assign({}, n));
  allEdges = edges.map(e => Object.assign({}, e));

  // Clear previous render
  d3.select(edgesLayer).selectAll('*').remove();
  d3.select(edgeLabels).selectAll('*').remove();
  d3.select(nodesLayer).selectAll('*').remove();

  const width  = svgEl.clientWidth  || 600;
  const height = svgEl.clientHeight || 500;

  // ── Compute hierarchical seed positions ─────────────────────────────────
  const layerMap = computeLayers(allNodes, allEdges);
  applyHierarchicalPositions(allNodes, layerMap, width, height);

  // ── Force simulation ─────────────────────────────────────────────────────
  if (simulation) simulation.stop();

  // Layer-based y-positioning force: match the same gap used in seed positions
  const numLayers = Math.max(...layerMap.values()) + 1;
  const minLayerGap = 140;
  const layerGap  = numLayers > 1
    ? Math.max(minLayerGap, (height * 0.85) / (numLayers - 1))
    : 0;
  const topPad    = height * 0.075;

  simulation = d3.forceSimulation(allNodes)
    .force('link', d3.forceLink(allEdges)
      .id(d => d.id)
      // Longer link distances keep connected nodes well separated
      .distance(d => {
        const target = typeof d.target === 'object' ? d.target : allNodes.find(n => n.id === d.target);
        return target && target.kind === 'external' ? 220 : 160;
      })
      // Weaker link strength so layer/collision forces can dominate
      .strength(0.25)
    )
    .force('charge', d3.forceManyBody()
      // Stronger repulsion pushes nodes apart more aggressively
      .strength(-800)
      .distanceMax(600)
    )
    .force('collide', d3.forceCollide()
      // Account for node circle + label text width (~70px) below the circle
      .radius(d => (KIND_RADIUS[d.kind] || 13) + 55)
      .strength(1.0)
      .iterations(4)
    )
    // Weak horizontal centering — just enough to keep the graph from drifting
    .force('x', d3.forceX(width / 2).strength(0.02))
    // Strong vertical layer attraction — keeps nodes in their assigned row
    .force('y', d3.forceY(d => {
      const l = layerMap.get(d.id) ?? 0;
      return topPad + l * layerGap;
    }).strength(0.6))
    // Faster cooling — nodes settle in ~1 s instead of ~5 s
    .alphaDecay(0.04)
    .velocityDecay(0.35)
    .on('tick', ticked);

  // ── Edges ────────────────────────────────────────────────────────────────
  const edgeSel = d3.select(edgesLayer)
    .selectAll('line')
    .data(allEdges)
    .enter()
    .append('line')
    .attr('stroke', d => edgeColor(d))
    .attr('stroke-width', d => (d.direction === 'upstream' || d.direction === 'downstream') ? 2 : 1.5)
    .attr('stroke-opacity', d => (d.direction === 'upstream' || d.direction === 'downstream') ? 0.75 : 0.6)
    .attr('stroke-dasharray', d => d.direction === 'upstream' ? '5,3' : null)
    .attr('marker-end', d => d.direction === 'upstream' ? 'url(#arrow-upstream)' : 'url(#arrow)');

  // Edge labels (only for cross-repo edges that have a label)
  const edgeLabelSel = d3.select(edgeLabels)
    .selectAll('text')
    .data(allEdges.filter(e => e.label))
    .enter()
    .append('text')
    .attr('font-size', 9)
    .attr('fill', d => edgeColor(d))
    .attr('text-anchor', 'middle')
    .attr('dy', -3)
    .text(d => d.label);

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodeGroup = d3.select(nodesLayer)
    .selectAll('g.node')
    .data(allNodes)
    .enter()
    .append('g')
    .attr('class', 'node')
    .style('cursor', d => (d.filePath && d.kind !== 'missing') ? 'pointer' : 'default')
    .call(
      d3.drag()
        .on('start', dragStarted)
        .on('drag',  dragged)
        .on('end',   dragEnded)
    );

  // Focal-node outer ring (only in file-scope mode for the scoped file)
  nodeGroup.filter(d => scopedFile && d.filePath === scopedFile)
    .append('circle')
    .attr('r', d => (KIND_RADIUS[d.kind] || 13) + 5)
    .attr('fill', 'none')
    .attr('stroke', 'var(--vscode-focusBorder, #007fd4)')
    .attr('stroke-width', 2)
    .attr('stroke-dasharray', '4,2')
    .attr('opacity', 0.8)
    .attr('pointer-events', 'none');

  // Circle
  nodeGroup.append('circle')
    .attr('r', d => KIND_RADIUS[d.kind] || 13)
    .attr('fill', d => KIND_COLOR[d.kind] || '#888')
    .attr('stroke', d => KIND_STROKE[d.kind] || '#555')
    .attr('stroke-width', 2)
    .attr('filter', d => d.kind === 'pipeline' ? 'url(#shadow)' : null);

  // Icon text inside circle
  nodeGroup.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', d => d.kind === 'pipeline' ? 11 : 9)
    .attr('fill', '#fff')
    .attr('pointer-events', 'none')
    .text(d => kindIcon(d.kind));

  // Label below circle
  nodeGroup.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', d => (KIND_RADIUS[d.kind] || 13) + 13)
    .attr('font-size', 10)
    .attr('fill', 'var(--vscode-editor-foreground)')
    .attr('pointer-events', 'none')
    .text(d => truncate(nodeLabel(d), showFullPath ? 40 : 24));

  // ── Interactions ──────────────────────────────────────────────────────────
  nodeGroup
    .on('click', (event, d) => {
      event.stopPropagation();
      hideCtxMenu();
      if (d.filePath && d.kind !== 'missing' && d.kind !== 'unknown') {
        vscode.postMessage({ type: 'openFile', filePath: d.filePath });
      }
    })
    .on('contextmenu', (event, d) => {
      showCtxMenu(event, d);
    })
    .on('dblclick', (event, node) => {
      event.stopPropagation();
      node.fx = null;
      node.fy = null;
      if (simulation) simulation.alpha(0.3).restart();
    })
    .on('mouseover', (event, d) => {
      highlightNeighbours(d, edgeSel, nodeGroup);
    })
    .on('mouseout', () => {
      resetHighlight(edgeSel, nodeGroup);
    });

  // Click on background → dismiss context menu
  svg.on('click', () => {
    resetHighlight(edgeSel, nodeGroup);
    hideCtxMenu();
  });

  // ── Tick function ──────────────────────────────────────────────────────────
  function ticked() {
    edgeSel
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    edgeLabelSel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);

    nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`);
  }

  // Fit early (nodes are roughly in place after ~800 ms) and again when fully settled
  setTimeout(() => fitView(), 800);
  simulation.on('end', () => fitView());
}

// ---------------------------------------------------------------------------
// Drag handlers
// ---------------------------------------------------------------------------
function dragStarted(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event) {
  if (!event.active && simulation) simulation.alphaTarget(0);
  // Keep node pinned after drag
}

// ---------------------------------------------------------------------------
// Highlight / dim
// ---------------------------------------------------------------------------
function highlightNeighbours(d, edgeSel, nodeGroup) {
  const connectedIds = new Set([d.id]);
  allEdges.forEach(e => {
    const sid = typeof e.source === 'object' ? e.source.id : e.source;
    const tid = typeof e.target === 'object' ? e.target.id : e.target;
    if (sid === d.id) connectedIds.add(tid);
    if (tid === d.id) connectedIds.add(sid);
  });

  edgeSel
    .attr('stroke-opacity', e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      return (sid === d.id || tid === d.id) ? 1 : 0.05;
    })
    .attr('stroke-width', e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      return (sid === d.id || tid === d.id) ? 2.5 : 1.5;
    });

  nodeGroup.style('opacity', n => connectedIds.has(n.id) ? 1 : 0.12);
}

function resetHighlight(edgeSel, nodeGroup) {
  edgeSel
    .attr('stroke-opacity', e => (e.direction === 'upstream' || e.direction === 'downstream') ? 0.75 : 0.6)
    .attr('stroke-width',   e => (e.direction === 'upstream' || e.direction === 'downstream') ? 2 : 1.5);
  nodeGroup.style('opacity', 1);
}

// ---------------------------------------------------------------------------
// Fit view
// ---------------------------------------------------------------------------
function fitView() {
  if (allNodes.length === 0) return;

  const padding = 50;
  const w = svgEl.clientWidth  || 600;
  const h = svgEl.clientHeight || 500;

  const xs = allNodes.map(n => n.x).filter(v => v != null && isFinite(v));
  const ys = allNodes.map(n => n.y).filter(v => v != null && isFinite(v));
  if (xs.length === 0) return;

  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;

  const scaleX = w / (maxX - minX);
  const scaleY = h / (maxY - minY);
  const scale  = Math.min(scaleX, scaleY, 2);

  const tx = (w - scale * (minX + maxX)) / 2;
  const ty = (h - scale * (minY + maxY)) / 2;

  svg.transition().duration(500).call(
    zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function showEmpty(msg) {
  emptyState.style.display = 'flex';
  if (msg) {
    emptyState.querySelector('div:last-child').textContent = msg;
  }
}

function hideEmpty() {
  emptyState.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function kindIcon(kind) {
  switch (kind) {
    case 'pipeline': return '▶';
    case 'external': return '⬡';
    case 'missing':  return '✕';
    case 'unknown':  return '?';
    default:         return '◆';
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
