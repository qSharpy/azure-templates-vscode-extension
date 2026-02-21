#!/usr/bin/env node
// Must be first: intercept `require('vscode')` before any extension module loads
require('./vscode-stub');

// WorkspaceIndex singleton — build it once before benchmarks run
const { workspaceIndex } = require('../workspaceIndex');

/**
 * bench/perf-benchmark.js
 *
 * Measures the wall-clock time of the exact code paths that are slow in
 * production.  Run this BEFORE and AFTER each improvement to get hard numbers.
 *
 * Usage:
 *   # First time: generate the fixture
 *   node bench/generate-fixture.js
 *
 *   # Then run the benchmark (default: 5 runs per test)
 *   node bench/perf-benchmark.js
 *
 *   # More runs for tighter numbers
 *   node bench/perf-benchmark.js --runs 10
 *
 *   # Point at a real repo instead of the synthetic fixture
 *   node bench/perf-benchmark.js --workspace /path/to/real/repo
 *
 * Output: a table of median / min / max timings for each measured operation.
 * Results are also appended to bench/benchmark-results.json so you can diff
 * before/after each improvement.
 *
 * Measured operations
 * ───────────────────
 *  1. collectYamlFiles          — directory scan
 *  2. buildUpstreamTree [COLD]  — "Called by" tree, cache cleared each run
 *  3. buildUpstreamTree [WARM]  — "Called by" tree, cache hot (subsequent switches)
 *  4. downstream I/O            — read+parse all reachable files from a pipeline
 *  5. parseParameters × N       — parameter parsing for all files
 *  6. hover simulation          — resolve + read + parse for one template ref
 *  7. buildWorkspaceGraph       — full workspace graph (graph view)
 *  8. buildFileGraph            — scoped file graph (depth=2)
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const fileCache = require('../fileCache');

// ── Resolve workspace root ────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getStrArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}
function getNumArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? Number(args[i + 1]) : def;
}

const FIXTURE_DIR    = path.join(__dirname, 'fixture');
const WORKSPACE_ROOT = getStrArg('workspace', FIXTURE_DIR);
const RUNS           = getNumArg('runs', 5);

if (!fs.existsSync(WORKSPACE_ROOT)) {
  console.error(`\n❌  Workspace not found: ${WORKSPACE_ROOT}`);
  console.error('   Run: node bench/generate-fixture.js\n');
  process.exit(1);
}

// ── Import extension modules ──────────────────────────────────────────────────
const extensionRoot = path.join(__dirname, '..');
const {
  collectYamlFiles,
  extractTemplateRefs,
  buildWorkspaceGraph,
  buildFileGraph,
} = require(path.join(extensionRoot, 'graphDataBuilder'));

const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require(path.join(extensionRoot, 'hoverProvider'));

// ── Timing helpers ────────────────────────────────────────────────────────────

/** Returns high-resolution elapsed milliseconds since `start`. */
function elapsed(start) {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1e6;
}

/** Runs `fn` `runs` times (warm cache), returns { median, min, max }. */
function measure(fn, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime();
    fn();
    times.push(elapsed(t));
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(times.length / 2)],
    min:    times[0],
    max:    times[times.length - 1],
  };
}

/** Runs `fn` `runs` times, clearing the file cache before each run (cold). */
function measureCold(fn, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    fileCache.invalidateAll();
    const t = process.hrtime();
    fn();
    times.push(elapsed(t));
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(times.length / 2)],
    min:    times[0],
    max:    times[times.length - 1],
  };
}

// ── Upstream tree — uses WorkspaceIndex (Improvement 2) ──────────────────────
function buildUpstreamTree(targetFile, workspaceRoot) {
  return workspaceIndex.buildUpstreamTree(targetFile, workspaceRoot);
}

// ── Pick representative target files ─────────────────────────────────────────

function pickTargetFiles(workspaceRoot) {
  const allYaml = collectYamlFiles(workspaceRoot);
  const leaves    = allYaml.filter(f => f.includes('leaves'));
  const pipelines = allYaml.filter(f => f.includes('pipeline'));
  const mids      = allYaml.filter(f => f.includes('/mid/'));

  return {
    leafTarget:     leaves[Math.floor(leaves.length / 2)]       || allYaml[0],
    pipelineTarget: pipelines[Math.floor(pipelines.length / 2)] || allYaml[0],
    midTarget:      mids[Math.floor(mids.length / 2)]           || allYaml[0],
    allYaml,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Build the workspace index once (warm it up before benchmarks)
// This mirrors what extension.js does on activation.
const _allYamlForIndex = collectYamlFiles(FIXTURE_DIR.replace(/\/$/, '') === WORKSPACE_ROOT
  ? WORKSPACE_ROOT : WORKSPACE_ROOT);
workspaceIndex.build(WORKSPACE_ROOT);
console.log(`\n  [WorkspaceIndex] Built: ${workspaceIndex.getAllFiles().length} files indexed`);

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║         Azure Templates Navigator — Performance Benchmark    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');
console.log(`  Workspace : ${WORKSPACE_ROOT}`);
console.log(`  Runs/test : ${RUNS}`);

const allYaml = collectYamlFiles(WORKSPACE_ROOT);
console.log(`  YAML files: ${allYaml.length}\n`);

const { leafTarget, pipelineTarget, midTarget } = pickTargetFiles(WORKSPACE_ROOT);
console.log(`  Upstream target  (leaf)     : ${path.relative(WORKSPACE_ROOT, leafTarget)}`);
console.log(`  Downstream target (pipeline): ${path.relative(WORKSPACE_ROOT, pipelineTarget)}`);
console.log(`  Mid target                  : ${path.relative(WORKSPACE_ROOT, midTarget)}`);
console.log('');

const results = [];

/**
 * @param {string}   label
 * @param {()=>void} fn
 * @param {boolean}  [cold=false]  Clear file cache before each run
 */
function bench(label, fn, cold = false) {
  process.stdout.write(`  ⏱  ${label.padEnd(50, '.')} `);
  const r = cold ? measureCold(fn, RUNS) : measure(fn, RUNS);
  const med = r.median.toFixed(1).padStart(8);
  const min = r.min.toFixed(1).padStart(8);
  const max = r.max.toFixed(1).padStart(8);
  console.log(`median ${med} ms   min ${min} ms   max ${max} ms`);
  results.push({ label, ...r });
  return r;
}

// ── 1. Directory scan ─────────────────────────────────────────────────────────
bench('collectYamlFiles (dir scan)', () => {
  collectYamlFiles(WORKSPACE_ROOT);
});

// ── 2. Upstream tree — the critical bottleneck ────────────────────────────────
// COLD = cache cleared before each run (worst case: first load after startup)
// WARM = cache hot from previous run (subsequent editor switches)
bench('buildUpstreamTree leaf  [COLD cache]', () => {
  buildUpstreamTree(leafTarget, WORKSPACE_ROOT);
}, true);

bench('buildUpstreamTree leaf  [WARM cache]', () => {
  buildUpstreamTree(leafTarget, WORKSPACE_ROOT);
});

bench('buildUpstreamTree mid   [COLD cache]', () => {
  buildUpstreamTree(midTarget, WORKSPACE_ROOT);
}, true);

bench('buildUpstreamTree mid   [WARM cache]', () => {
  buildUpstreamTree(midTarget, WORKSPACE_ROOT);
});

// ── 3. Downstream tree ────────────────────────────────────────────────────────
bench('downstream I/O read+parse reachable [COLD]', () => {
  const visited = new Set();
  function traverse(filePath, depth) {
    if (depth > 5 || visited.has(filePath)) return;
    visited.add(filePath);
    const text = fileCache.readFile(filePath);
    if (!text) return;
    parseParameters(text);
    const aliases = parseRepositoryAliases(text);
    const refs = extractTemplateRefs(filePath);
    for (const { templateRef } of refs) {
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;
      const resolved = resolveTemplatePath(templateRef, filePath, aliases);
      if (resolved && resolved.filePath && fileCache.fileExists(resolved.filePath)) {
        traverse(resolved.filePath, depth + 1);
      }
    }
  }
  traverse(pipelineTarget, 0);
}, true);

// ── 4. parseParameters for all files ─────────────────────────────────────────
bench(`parseParameters × ${allYaml.length} files [COLD]`, () => {
  for (const f of allYaml) {
    const text = fileCache.readFile(f);
    if (text) parseParameters(text);
  }
}, true);

bench(`parseParameters × ${allYaml.length} files [WARM]`, () => {
  for (const f of allYaml) {
    const text = fileCache.readFile(f);
    if (text) parseParameters(text);
  }
});

// ── 5. Hover simulation ───────────────────────────────────────────────────────
let hoverSourceFile = null;
let hoverTemplateRef = null;
for (const f of allYaml) {
  const refs = extractTemplateRefs(f);
  if (refs.length > 0) {
    hoverSourceFile = f;
    hoverTemplateRef = refs[0].templateRef;
    break;
  }
}

if (hoverSourceFile && hoverTemplateRef) {
  bench('hover simulation resolve+read+parse [COLD]', () => {
    const text = fileCache.readFile(hoverSourceFile);
    if (!text) return;
    const aliases = parseRepositoryAliases(text);
    const resolved = resolveTemplatePath(hoverTemplateRef, hoverSourceFile, aliases);
    if (resolved && resolved.filePath) {
      const tplText = fileCache.readFile(resolved.filePath);
      if (tplText) parseParameters(tplText);
    }
  }, true);

  bench('hover simulation resolve+read+parse [WARM]', () => {
    const text = fileCache.readFile(hoverSourceFile);
    if (!text) return;
    const aliases = parseRepositoryAliases(text);
    const resolved = resolveTemplatePath(hoverTemplateRef, hoverSourceFile, aliases);
    if (resolved && resolved.filePath) {
      const tplText = fileCache.readFile(resolved.filePath);
      if (tplText) parseParameters(tplText);
    }
  });
}

// ── 6. buildWorkspaceGraph ────────────────────────────────────────────────────
bench('buildWorkspaceGraph full workspace [COLD]', () => {
  buildWorkspaceGraph(WORKSPACE_ROOT, '');
}, true);

bench('buildWorkspaceGraph full workspace [WARM]', () => {
  buildWorkspaceGraph(WORKSPACE_ROOT, '');
});

// ── 7. buildFileGraph ─────────────────────────────────────────────────────────
bench('buildFileGraph pipeline depth=2 [COLD]', () => {
  buildFileGraph(pipelineTarget, WORKSPACE_ROOT, 2);
}, true);

bench('buildFileGraph pipeline depth=2 [WARM]', () => {
  buildFileGraph(pipelineTarget, WORKSPACE_ROOT, 2);
});

bench('buildFileGraph leaf depth=2 [COLD]', () => {
  buildFileGraph(leafTarget, WORKSPACE_ROOT, 2);
}, true);

bench('buildFileGraph leaf depth=2 [WARM]', () => {
  buildFileGraph(leafTarget, WORKSPACE_ROOT, 2);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n  ─────────────────────────────────────────────────────────────');
console.log('  SUMMARY (median ms, sorted slowest first)\n');
const sorted = [...results].sort((a, b) => b.median - a.median);
for (const r of sorted) {
  const bar = '█'.repeat(Math.min(40, Math.round(r.median / 20)));
  console.log(`  ${r.median.toFixed(1).padStart(8)} ms  ${r.label.padEnd(50)} ${bar}`);
}

// ── Machine-readable JSON output ──────────────────────────────────────────────
const jsonOut = path.join(__dirname, 'benchmark-results.json');
const existing = fs.existsSync(jsonOut)
  ? JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
  : { runs: [] };

existing.runs.push({
  timestamp: new Date().toISOString(),
  workspaceRoot: WORKSPACE_ROOT,
  fileCount: allYaml.length,
  runsPerTest: RUNS,
  results: results.map(r => ({ label: r.label, median: r.median, min: r.min, max: r.max })),
});

fs.writeFileSync(jsonOut, JSON.stringify(existing, null, 2), 'utf8');
console.log(`\n  Results appended to: bench/benchmark-results.json`);

// ── Diff against previous run ─────────────────────────────────────────────────
if (existing.runs.length >= 2) {
  const prev = existing.runs[existing.runs.length - 2];
  const curr = existing.runs[existing.runs.length - 1];
  console.log('\n  ─────────────────────────────────────────────────────────────');
  console.log(`  DIFF vs previous run (${prev.timestamp.slice(0, 19)})\n`);
  for (const cr of curr.results) {
    const pr = prev.results.find(r => r.label === cr.label);
    if (!pr) continue;
    const delta = cr.median - pr.median;
    const pct   = ((delta / pr.median) * 100).toFixed(1);
    const sign  = delta > 0 ? '+' : '';
    const icon  = delta < -5 ? '🟢' : delta > 5 ? '🔴' : '⚪';
    console.log(`  ${icon}  ${cr.label.padEnd(50)} ${sign}${delta.toFixed(1)} ms (${sign}${pct}%)`);
  }
}

console.log('');
