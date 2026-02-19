'use strict';

/**
 * Unit tests for graphDataBuilder.js
 *
 * These tests exercise the pure Node.js functions that scan a workspace
 * directory and build graph data (nodes + edges).  No VS Code host is needed.
 *
 * Run with:  npm run test:unit
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

const {
  collectYamlFiles,
  isPipelineRoot,
  extractTemplateRefs,
  buildWorkspaceGraph,
} = require('../../graphDataBuilder');

// ---------------------------------------------------------------------------
// Helpers — build a temporary directory tree for tests
// ---------------------------------------------------------------------------

/**
 * Creates a temp directory, writes the given files into it, and returns the
 * root path.  `files` is a map of relative path → content string.
 *
 * @param {Record<string, string>} files
 * @returns {string} absolute path to the temp root
 */
function makeTempWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atn-graph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/**
 * Recursively removes a directory.
 * @param {string} dir
 */
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// collectYamlFiles
// ---------------------------------------------------------------------------
describe('collectYamlFiles()', () => {
  let root;
  afterEach(() => root && rmrf(root));

  it('returns all .yml and .yaml files recursively', () => {
    root = makeTempWorkspace({
      'pipeline.yml':           'trigger: [main]',
      'templates/build.yml':    'parameters: []',
      'templates/deploy.yaml':  'parameters: []',
      'README.md':              '# readme',
      'src/app.js':             'console.log(1)',
    });

    const files = collectYamlFiles(root);
    const names = files.map(f => path.basename(f)).sort();
    assert.deepStrictEqual(names, ['build.yml', 'deploy.yaml', 'pipeline.yml']);
  });

  it('skips .git and node_modules directories', () => {
    root = makeTempWorkspace({
      'pipeline.yml':                 'trigger: [main]',
      '.git/config':                  '[core]',
      'node_modules/pkg/index.yml':   'x: 1',
    });

    const files = collectYamlFiles(root);
    const names = files.map(f => path.basename(f));
    assert.ok(names.includes('pipeline.yml'));
    assert.ok(!names.includes('index.yml'));
  });

  it('returns empty array for empty directory', () => {
    root = makeTempWorkspace({});
    const files = collectYamlFiles(root);
    assert.deepStrictEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// isPipelineRoot
// ---------------------------------------------------------------------------
describe('isPipelineRoot()', () => {
  it('returns true for a file with trigger:', () => {
    assert.strictEqual(isPipelineRoot('trigger:\n  branches:\n    include: [main]'), true);
  });

  it('returns true for a file with stages:', () => {
    assert.strictEqual(isPipelineRoot('stages:\n  - stage: Build'), true);
  });

  it('returns true for a file with pr:', () => {
    assert.strictEqual(isPipelineRoot('pr:\n  branches:\n    include: [main]'), true);
  });

  it('returns false for a plain template file', () => {
    assert.strictEqual(isPipelineRoot('parameters:\n  - name: foo\n    type: string'), false);
  });

  it('returns false for an empty file', () => {
    assert.strictEqual(isPipelineRoot(''), false);
  });
});

// ---------------------------------------------------------------------------
// extractTemplateRefs
// ---------------------------------------------------------------------------
describe('extractTemplateRefs()', () => {
  let root;
  afterEach(() => root && rmrf(root));

  it('extracts a single template reference', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'stages:',
        '  - template: templates/build.yml',
      ].join('\n'),
    });

    const refs = extractTemplateRefs(path.join(root, 'pipeline.yml'));
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].templateRef, 'templates/build.yml');
    assert.strictEqual(refs[0].line, 1);
  });

  it('extracts multiple template references', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'stages:',
        '  - template: templates/build.yml',
        '  - template: templates/deploy.yml',
        '  - template: stages/notify.yml@external',
      ].join('\n'),
    });

    const refs = extractTemplateRefs(path.join(root, 'pipeline.yml'));
    assert.strictEqual(refs.length, 3);
    assert.strictEqual(refs[0].templateRef, 'templates/build.yml');
    assert.strictEqual(refs[1].templateRef, 'templates/deploy.yml');
    assert.strictEqual(refs[2].templateRef, 'stages/notify.yml@external');
  });

  it('returns empty array for a file with no template references', () => {
    root = makeTempWorkspace({
      'template.yml': 'parameters:\n  - name: foo\n    type: string\n',
    });

    const refs = extractTemplateRefs(path.join(root, 'template.yml'));
    assert.deepStrictEqual(refs, []);
  });

  it('returns empty array for a non-existent file', () => {
    const refs = extractTemplateRefs('/nonexistent/path/file.yml');
    assert.deepStrictEqual(refs, []);
  });
});

// ---------------------------------------------------------------------------
// buildWorkspaceGraph
// ---------------------------------------------------------------------------
describe('buildWorkspaceGraph()', () => {
  let root;
  afterEach(() => root && rmrf(root));

  it('returns empty nodes and edges for an empty workspace', () => {
    root = makeTempWorkspace({});
    const { nodes, edges } = buildWorkspaceGraph(root);
    assert.deepStrictEqual(nodes, []);
    assert.deepStrictEqual(edges, []);
  });

  it('registers every YAML file as a node', () => {
    root = makeTempWorkspace({
      'pipeline.yml':        'trigger: [main]\n',
      'templates/build.yml': 'parameters:\n  - name: project\n    type: string\n',
    });

    const { nodes } = buildWorkspaceGraph(root);
    const labels = nodes.map(n => n.label).sort();
    assert.deepStrictEqual(labels, ['build.yml', 'pipeline.yml']);
  });

  it('classifies pipeline root files correctly', () => {
    root = makeTempWorkspace({
      'pipeline.yml':        'trigger: [main]\n',
      'templates/build.yml': 'parameters:\n  - name: project\n    type: string\n',
    });

    const { nodes } = buildWorkspaceGraph(root);
    const pipeline = nodes.find(n => n.label === 'pipeline.yml');
    const template = nodes.find(n => n.label === 'build.yml');

    assert.strictEqual(pipeline.kind, 'pipeline');
    assert.strictEqual(template.kind, 'local');
  });

  it('creates an edge between pipeline and referenced template', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: templates/build.yml',
      ].join('\n'),
      'templates/build.yml': 'parameters:\n  - name: project\n    type: string\n',
    });

    const { edges } = buildWorkspaceGraph(root);
    assert.strictEqual(edges.length, 1);

    const pipelinePath = path.join(root, 'pipeline.yml');
    const buildPath    = path.join(root, 'templates', 'build.yml');
    assert.strictEqual(edges[0].source, pipelinePath);
    assert.strictEqual(edges[0].target, buildPath);
  });

  it('deduplicates edges when the same template is referenced multiple times', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: templates/build.yml',
        '- template: templates/build.yml',
      ].join('\n'),
      'templates/build.yml': 'parameters: []\n',
    });

    const { edges } = buildWorkspaceGraph(root);
    assert.strictEqual(edges.length, 1);
  });

  it('creates a missing node for a template that does not exist on disk', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: templates/gone.yml',
      ].join('\n'),
    });

    const { nodes } = buildWorkspaceGraph(root);
    const missing = nodes.find(n => n.kind === 'missing');
    assert.ok(missing, 'expected a missing node');
    assert.strictEqual(missing.label, 'gone.yml');
  });

  it('creates an unknown-alias node for an unresolvable @alias reference', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: templates/build.yml@unknownRepo',
      ].join('\n'),
    });

    const { nodes } = buildWorkspaceGraph(root);
    const unknown = nodes.find(n => n.kind === 'unknown');
    assert.ok(unknown, 'expected an unknown-alias node');
    assert.strictEqual(unknown.alias, 'unknownRepo');
  });

  it('skips variable-expression template refs', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: $(dynamicTemplate)',
      ].join('\n'),
    });

    const { edges } = buildWorkspaceGraph(root);
    // Variable expressions cannot be resolved — no edge should be created
    assert.strictEqual(edges.length, 0);
  });

  it('fills in paramCount for local template nodes', () => {
    root = makeTempWorkspace({
      'pipeline.yml': [
        'trigger: [main]',
        '- template: templates/build.yml',
      ].join('\n'),
      'templates/build.yml': [
        'parameters:',
        '  - name: project',
        '    type: string',
        '    default: Release',
        '  - name: config',
        '    type: string',
      ].join('\n'),
    });

    const { nodes } = buildWorkspaceGraph(root);
    const build = nodes.find(n => n.label === 'build.yml');
    assert.ok(build, 'build.yml node should exist');
    assert.strictEqual(build.paramCount, 2);
    assert.strictEqual(build.requiredCount, 1);
  });
});
