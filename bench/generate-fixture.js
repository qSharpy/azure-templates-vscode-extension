#!/usr/bin/env node
/**
 * bench/generate-fixture.js
 *
 * Generates a synthetic Azure Pipelines workspace with a configurable number
 * of YAML template files that mirror the real-world structure described in the
 * performance issue:
 *
 *   - N "leaf" templates  (no outgoing template refs, 5–15 parameters each)
 *   - N "mid" templates   (each calls 2–4 leaf templates, 3–8 parameters)
 *   - N "top" templates   (each calls 2–4 mid templates, 2–5 parameters)
 *   - M "pipeline" roots  (each calls 2–6 top templates, no parameters)
 *
 * Default totals (matching the reported ~300-file repo):
 *   leaves = 120, mids = 80, tops = 60, pipelines = 40  → 300 files
 *
 * Usage:
 *   node bench/generate-fixture.js [--out <dir>] [--leaves N] [--mids N] [--tops N] [--pipelines N]
 *
 * The generated directory is bench/fixture/ by default.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? Number(args[i + 1]) : def;
}
function getStrArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}

const OUT_DIR   = getStrArg('out', path.join(__dirname, 'fixture'));
const N_LEAVES  = getArg('leaves',    120);
const N_MIDS    = getArg('mids',       80);
const N_TOPS    = getArg('tops',       60);
const N_PIPES   = getArg('pipelines',  40);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random (seeded) so fixture is reproducible. */
function makeRng(seed = 42) {
  let s = seed;
  return function rand(n) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return Math.abs(s) % n;
  };
}
const rand = makeRng(42);

function pick(arr) { return arr[rand(arr.length)]; }
function range(n)  { return Array.from({ length: n }, (_, i) => i); }

const PARAM_TYPES = ['string', 'boolean', 'number', 'object'];
const PARAM_NAMES = [
  'project', 'buildConfiguration', 'dotnetVersion', 'environment', 'region',
  'serviceName', 'imageTag', 'registry', 'namespace', 'clusterName',
  'artifactName', 'publishPath', 'testFilter', 'coverageThreshold', 'timeout',
  'retryCount', 'enableCache', 'cacheKey', 'notifySlack', 'slackChannel',
  'deployTarget', 'rollbackEnabled', 'healthCheckUrl', 'maxReplicas', 'minReplicas',
  'resourceGroup', 'subscriptionId', 'tenantId', 'clientId', 'vaultName',
];

/**
 * Generates a YAML parameter block.
 * @param {number} count   Total number of parameters
 * @param {number} reqCount How many are required (no default)
 * @returns {string}
 */
function genParams(count, reqCount) {
  const names = [];
  const used = new Set();
  while (names.length < count) {
    const base = PARAM_NAMES[rand(PARAM_NAMES.length)];
    const candidate = used.has(base) ? `${base}${names.length}` : base;
    used.add(candidate);
    names.push(candidate);
  }

  return names.map((name, i) => {
    const type = pick(PARAM_TYPES);
    const required = i < reqCount;
    const defaultLine = required ? '' : `\n    default: ${type === 'boolean' ? 'false' : type === 'number' ? '0' : "''"}`; 
    return `  - name: ${name}\n    type: ${type}${defaultLine}`;
  }).join('\n');
}

/**
 * Generates a YAML steps block that references each parameter so they're "used".
 * @param {string[]} paramNames
 * @returns {string}
 */
function genSteps(paramNames) {
  if (paramNames.length === 0) return 'steps:\n  - script: echo "no params"';
  const refs = paramNames.map(n => `$\{{ parameters.${n} }}`).join(' ');
  return `steps:\n  - script: echo "${refs}"`;
}

/**
 * Generates a YAML template call block.
 * @param {string} relPath   Relative path from the calling file's directory
 * @param {string[]} paramNames  Parameters to pass (all required ones)
 */
function genTemplateCall(relPath, paramNames) {
  const passedParams = paramNames.slice(0, Math.min(paramNames.length, 3));
  const paramBlock = passedParams.length === 0
    ? ''
    : '\n    parameters:\n' + passedParams.map(p => `      ${p}: 'value'`).join('\n');
  return `  - template: ${relPath}${paramBlock}`;
}

// ── Directory structure ───────────────────────────────────────────────────────
//   bench/fixture/
//     templates/leaves/   leaf-000.yml … leaf-NNN.yml
//     templates/mid/      mid-000.yml  … mid-NNN.yml
//     templates/top/      top-000.yml  … top-NNN.yml
//     pipelines/          pipeline-000.yml … pipeline-NNN.yml

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── Generation ────────────────────────────────────────────────────────────────

console.log(`Generating fixture in: ${OUT_DIR}`);
console.log(`  leaves=${N_LEAVES}  mids=${N_MIDS}  tops=${N_TOPS}  pipelines=${N_PIPES}`);
console.log(`  total files = ${N_LEAVES + N_MIDS + N_TOPS + N_PIPES}`);

// Clean and recreate
if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}
const leafDir     = path.join(OUT_DIR, 'templates', 'leaves');
const midDir      = path.join(OUT_DIR, 'templates', 'mid');
const topDir      = path.join(OUT_DIR, 'templates', 'top');
const pipelineDir = path.join(OUT_DIR, 'pipelines');
ensureDir(leafDir);
ensureDir(midDir);
ensureDir(topDir);
ensureDir(pipelineDir);

// ── Leaf templates ────────────────────────────────────────────────────────────
const leafFiles = []; // { filePath, paramNames }
for (const i of range(N_LEAVES)) {
  const name = `leaf-${String(i).padStart(3, '0')}.yml`;
  const filePath = path.join(leafDir, name);
  const totalParams = 5 + rand(11);   // 5–15
  const reqCount    = 1 + rand(4);    // 1–4 required
  const paramBlock  = genParams(totalParams, reqCount);

  // Extract param names for step references
  const paramNames = [];
  for (const line of paramBlock.split('\n')) {
    const m = /^\s+-\s+name:\s+(\S+)/.exec(line);
    if (m) paramNames.push(m[1]);
  }

  const content = `parameters:\n${paramBlock}\n\n${genSteps(paramNames)}\n`;
  writeFile(filePath, content);
  leafFiles.push({ filePath, paramNames });
}
console.log(`  ✓ ${N_LEAVES} leaf templates`);

// ── Mid templates ─────────────────────────────────────────────────────────────
const midFiles = [];
for (const i of range(N_MIDS)) {
  const name = `mid-${String(i).padStart(3, '0')}.yml`;
  const filePath = path.join(midDir, name);
  const totalParams = 3 + rand(6);    // 3–8
  const reqCount    = 1 + rand(3);
  const paramBlock  = genParams(totalParams, reqCount);

  const paramNames = [];
  for (const line of paramBlock.split('\n')) {
    const m = /^\s+-\s+name:\s+(\S+)/.exec(line);
    if (m) paramNames.push(m[1]);
  }

  // Call 2–4 random leaf templates
  const callCount = 2 + rand(3);
  const calls = [];
  for (let c = 0; c < callCount; c++) {
    const leaf = leafFiles[rand(leafFiles.length)];
    const relPath = path.relative(midDir, leaf.filePath).replace(/\\/g, '/');
    calls.push(genTemplateCall(relPath, leaf.paramNames.filter((_, idx) => idx < 2)));
  }

  const content = `parameters:\n${paramBlock}\n\nsteps:\n${calls.join('\n')}\n`;
  writeFile(filePath, content);
  midFiles.push({ filePath, paramNames });
}
console.log(`  ✓ ${N_MIDS} mid templates`);

// ── Top templates ─────────────────────────────────────────────────────────────
const topFiles = [];
for (const i of range(N_TOPS)) {
  const name = `top-${String(i).padStart(3, '0')}.yml`;
  const filePath = path.join(topDir, name);
  const totalParams = 2 + rand(4);    // 2–5
  const reqCount    = 1 + rand(2);
  const paramBlock  = genParams(totalParams, reqCount);

  const paramNames = [];
  for (const line of paramBlock.split('\n')) {
    const m = /^\s+-\s+name:\s+(\S+)/.exec(line);
    if (m) paramNames.push(m[1]);
  }

  // Call 2–4 random mid templates
  const callCount = 2 + rand(3);
  const calls = [];
  for (let c = 0; c < callCount; c++) {
    const mid = midFiles[rand(midFiles.length)];
    const relPath = path.relative(topDir, mid.filePath).replace(/\\/g, '/');
    calls.push(genTemplateCall(relPath, mid.paramNames.filter((_, idx) => idx < 2)));
  }

  const content = `parameters:\n${paramBlock}\n\nsteps:\n${calls.join('\n')}\n`;
  writeFile(filePath, content);
  topFiles.push({ filePath, paramNames });
}
console.log(`  ✓ ${N_TOPS} top templates`);

// ── Pipeline roots ────────────────────────────────────────────────────────────
for (const i of range(N_PIPES)) {
  const name = `pipeline-${String(i).padStart(3, '0')}.yml`;
  const filePath = path.join(pipelineDir, name);

  // Call 2–6 random top templates
  const callCount = 2 + rand(5);
  const calls = [];
  for (let c = 0; c < callCount; c++) {
    const top = topFiles[rand(topFiles.length)];
    const relPath = path.relative(pipelineDir, top.filePath).replace(/\\/g, '/');
    calls.push(genTemplateCall(relPath, top.paramNames.filter((_, idx) => idx < 2)));
  }

  const content = `trigger:\n  - main\n\nstages:\n  - stage: Build\n    jobs:\n      - job: BuildJob\n        steps:\n${calls.join('\n')}\n`;
  writeFile(filePath, content);
}
console.log(`  ✓ ${N_PIPES} pipeline roots`);

console.log(`\nFixture ready. Total: ${N_LEAVES + N_MIDS + N_TOPS + N_PIPES} files`);
console.log(`Run: node bench/perf-benchmark.js`);
