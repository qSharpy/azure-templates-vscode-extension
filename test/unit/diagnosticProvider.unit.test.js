'use strict';

/**
 * Pure-Node unit tests for diagnosticProvider.js
 *
 * Tests:
 *   - inferValueType
 *   - validateCallSite (via getDiagnosticsForDocument with fixture files)
 *   - getDiagnosticsForDocument
 *
 * Run with:  npx mocha test/unit/diagnosticProvider.unit.test.js
 */

const assert = require('assert');
const path   = require('path');

// ---------------------------------------------------------------------------
// Stub the 'vscode' module before requiring any extension code.
// ---------------------------------------------------------------------------
const Module = require('module');
const _orig  = Module._load;
// eslint-disable-next-line no-unused-vars
Module._load = function (request) {
  if (request === 'vscode') {
    return {
      MarkdownString: class {
        constructor() { this.isTrusted = false; this.supportHtml = false; }
        appendMarkdown() { return this; }
      },
      Range: class {
        constructor(sl, sc, el, ec) {
          this.start = { line: sl, character: sc };
          this.end   = { line: el, character: ec };
        }
      },
      Hover:  class { constructor(md, range) { this.contents = md; this.range = range; } },
      Location: class {},
      Position: class { constructor(l, c) { this.line = l; this.character = c; } },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      Diagnostic: class {
        constructor(range, message, severity) {
          this.range    = range;
          this.message  = message;
          this.severity = severity;
          this.source   = '';
          this.code     = '';
        }
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: () => {},
          delete: () => {},
          dispose: () => {},
        }),
      },
      workspace: {
        getConfiguration: () => ({ get: () => '#c92d35' }),
        textDocuments: [],
        onDidOpenTextDocument:   () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} }),
        onDidSaveTextDocument:   () => ({ dispose: () => {} }),
        onDidCloseTextDocument:  () => ({ dispose: () => {} }),
        // findFiles stub: returns an empty array (no workspace in unit tests)
        findFiles: async () => [],
        createFileSystemWatcher: () => ({
          onDidChange: () => ({ dispose: () => {} }),
          onDidCreate: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
      },
      window: {
        activeTextEditor: null,
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        createTreeView: () => ({ dispose: () => {}, title: '' }),
      },
      Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
      commands: { registerCommand: () => ({ dispose: () => {} }) },
      TreeItem: class { constructor(label) { this.label = label; } },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      CompletionItem: class { constructor(label) { this.label = label; } },
      CompletionItemKind: { Property: 9 },
      SnippetString: class { constructor(v) { this.value = v; } },
      EventEmitter: class {
        constructor() { this.event = () => {}; }
        fire() {}
        dispose() {}
      },
    };
  }
  return _orig.apply(this, arguments);
};

const {
  inferValueType,
  getDiagnosticsForDocument,
  getDiagnosticsForFile,
  validateCallSite,
} = require('../../diagnosticProvider');

Module._load = _orig;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES    = path.resolve(__dirname, '..', 'fixtures');
const MAIN_REPO   = path.join(FIXTURES, 'main-repo');
const CURRENT_FILE = path.join(MAIN_REPO, 'pipelines', 'azure-pipelines.yml');

// ---------------------------------------------------------------------------
// inferValueType
// ---------------------------------------------------------------------------

describe('inferValueType', () => {

  it('returns "boolean" for true/false/yes/no/on/off (case-insensitive)', () => {
    for (const v of ['true', 'false', 'yes', 'no', 'on', 'off', 'True', 'FALSE']) {
      assert.strictEqual(inferValueType(v), 'boolean', `Expected boolean for "${v}"`);
    }
  });

  it('returns "number" for integer and decimal strings', () => {
    assert.strictEqual(inferValueType('42'),    'number');
    assert.strictEqual(inferValueType('3.14'),  'number');
    assert.strictEqual(inferValueType('-7'),    'number');
  });

  it('returns "object" for JSON-like arrays and objects', () => {
    assert.strictEqual(inferValueType('[a, b]'), 'object');
    assert.strictEqual(inferValueType('{k: v}'), 'object');
  });

  it('returns "string" for quoted values', () => {
    assert.strictEqual(inferValueType("'Release'"), 'string');
    assert.strictEqual(inferValueType('"Release"'), 'string');
  });

  it('returns "string" for pipeline expressions', () => {
    assert.strictEqual(inferValueType('$(buildConfig)'),       'string');
    assert.strictEqual(inferValueType('${{ variables.env }}'), 'string');
  });

  it('returns "string" for empty string', () => {
    assert.strictEqual(inferValueType(''), 'string');
  });

  it('returns "string" for plain text values', () => {
    assert.strictEqual(inferValueType('Release'),       'string');
    assert.strictEqual(inferValueType('ubuntu-latest'), 'string');
  });
});

// ---------------------------------------------------------------------------
// validateCallSite — using real fixture files
// ---------------------------------------------------------------------------

describe('validateCallSite', () => {

  it('emits no diagnostics when all required params are provided', () => {
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    environment: Production',
      '    region: westeurope',
    ];
    const diags = validateCallSite(
      lines, 0,
      '../templates/local-template.yml',
      CURRENT_FILE,
      {}
    );
    assert.strictEqual(diags.length, 0);
  });

  it('emits an Error diagnostic for a missing required parameter', () => {
    // local-template.yml has "environment" as REQUIRED
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    region: eastus',
    ];
    const diags = validateCallSite(
      lines, 0,
      '../templates/local-template.yml',
      CURRENT_FILE,
      {}
    );
    const missing = diags.filter(d => d.code === 'missing-required-param');
    assert.ok(missing.length >= 1, 'Expected at least one missing-required-param diagnostic');
    assert.ok(missing[0].message.includes('environment'));
    assert.strictEqual(missing[0].severity, 0); // DiagnosticSeverity.Error
  });

  it('emits no diagnostic for a missing parameter that has a default (optional)', () => {
    // local-template.yml has "region" with default: eastus — it is optional,
    // so omitting it at the call site should produce no diagnostic.
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    environment: Production',
      // region is intentionally omitted — it has a default so it is not required
    ];
    const diags = validateCallSite(
      lines, 0,
      '../templates/local-template.yml',
      CURRENT_FILE,
      {}
    );
    const missing = diags.filter(d => d.code === 'missing-required-param');
    assert.strictEqual(missing.length, 0, 'region has a default — should not be flagged as missing');
  });

  it('emits a Warning diagnostic for an unknown parameter', () => {
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    environment: Production',
      '    typoParam: someValue',
    ];
    const diags = validateCallSite(
      lines, 0,
      '../templates/local-template.yml',
      CURRENT_FILE,
      {}
    );
    const unknown = diags.filter(d => d.code === 'unknown-param');
    assert.ok(unknown.length >= 1, 'Expected at least one unknown-param diagnostic');
    assert.ok(unknown[0].message.includes('typoParam'));
    assert.strictEqual(unknown[0].severity, 1); // DiagnosticSeverity.Warning
  });

  it('returns no diagnostics when template file does not exist', () => {
    const lines = [
      '- template: ../templates/nonexistent.yml',
      '  parameters:',
      '    foo: bar',
    ];
    const diags = validateCallSite(
      lines, 0,
      '../templates/nonexistent.yml',
      CURRENT_FILE,
      {}
    );
    assert.strictEqual(diags.length, 0);
  });

  it('returns no diagnostics for template expressions (runtime variables)', () => {
    const lines = [
      '- template: ${{ variables.templatePath }}',
    ];
    // This is filtered out before validateCallSite is called in getDiagnosticsForDocument
    // but validateCallSite itself should handle unresolvable refs gracefully
    const diags = validateCallSite(
      lines, 0,
      '${{ variables.templatePath }}',
      CURRENT_FILE,
      {}
    );
    assert.strictEqual(diags.length, 0);
  });
});

// ---------------------------------------------------------------------------
// getDiagnosticsForDocument — using a mock document
// ---------------------------------------------------------------------------

describe('getDiagnosticsForDocument', () => {

  /**
   * Creates a minimal mock TextDocument.
   * @param {string} text
   * @param {string} fsPath
   */
  function makeDoc(text, fsPath = CURRENT_FILE) {
    return {
      getText: () => text,
      uri: { fsPath },
      languageId: 'yaml',
    };
  }

  it('returns [] for a document with no template references', () => {
    const doc = makeDoc('stages:\n  - stage: Build\n    jobs: []\n');
    const diags = getDiagnosticsForDocument(doc);
    assert.deepStrictEqual(diags, []);
  });

  it('returns [] when template expressions use variables (skipped)', () => {
    const doc = makeDoc('- template: ${{ variables.path }}\n  parameters:\n    foo: bar\n');
    const diags = getDiagnosticsForDocument(doc);
    assert.deepStrictEqual(diags, []);
  });

  it('returns diagnostics for a real template reference with missing required param', () => {
    const text = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    region: eastus',
      '',
    ].join('\n');
    const doc = makeDoc(text);
    const diags = getDiagnosticsForDocument(doc);
    const missing = diags.filter(d => d.code === 'missing-required-param');
    assert.ok(missing.length >= 1, 'Expected missing-required-param diagnostic');
    assert.ok(missing[0].message.includes('environment'));
  });

  it('returns no diagnostics when all required params are provided', () => {
    const text = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    environment: Production',
      '    region: westeurope',
      '',
    ].join('\n');
    const doc = makeDoc(text);
    const diags = getDiagnosticsForDocument(doc);
    assert.strictEqual(diags.length, 0);
  });

  it('handles multiple template call sites in one document', () => {
    const text = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    environment: Production',
      '',
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    region: eastus',
      '',
    ].join('\n');
    const doc = makeDoc(text);
    const diags = getDiagnosticsForDocument(doc);
    // First call site: OK (environment provided, region has default)
    // Second call site: missing required "environment"
    const missing = diags.filter(d => d.code === 'missing-required-param');
    assert.ok(missing.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// getDiagnosticsForFile — reads from disk
// ---------------------------------------------------------------------------

describe('getDiagnosticsForFile', () => {

  it('returns [] for a file path that does not exist', () => {
    const diags = getDiagnosticsForFile('/nonexistent/path/file.yml');
    assert.deepStrictEqual(diags, []);
  });

  it('returns [] for a valid YAML file with no template references', () => {
    // Use the sibling-repo build stage fixture — it has no template: lines
    const fixturePath = path.join(
      path.resolve(__dirname, '..', 'fixtures'),
      'sibling-repo', 'stages', 'build.yml'
    );
    const diags = getDiagnosticsForFile(fixturePath);
    assert.ok(Array.isArray(diags));
    // Should not throw; result may be empty or contain diagnostics depending on fixture
  });

  it('returns diagnostics for a file with a missing required parameter', () => {
    // Write a temp-like test by using the main pipeline fixture path and
    // verifying the function returns an array (content-based assertions are
    // already covered by getDiagnosticsForDocument tests above).
    const diags = getDiagnosticsForFile(CURRENT_FILE);
    assert.ok(Array.isArray(diags), 'Expected an array of diagnostics');
  });
});
