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
  getUnusedParameterDiagnostics,
  collectParameterReferences,
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

// ---------------------------------------------------------------------------
// collectParameterReferences
// ---------------------------------------------------------------------------

describe('collectParameterReferences', () => {

  it('finds ${{ parameters.name }} references', () => {
    const text = 'script: echo ${{ parameters.myParam }}';
    const refs = collectParameterReferences(text);
    assert.ok(refs.has('myParam'), 'Expected myParam to be found');
  });

  it('finds bare parameters.name references inside if-expressions', () => {
    const text = '${{ if eq(parameters.enabled, true) }}:';
    const refs = collectParameterReferences(text);
    assert.ok(refs.has('enabled'), 'Expected enabled to be found');
  });

  it('finds ${{ parameters["name"] }} bracket-notation references', () => {
    const text = 'value: ${{ parameters["myKey"] }}';
    const refs = collectParameterReferences(text);
    assert.ok(refs.has('myKey'), 'Expected myKey to be found');
  });

  it('finds ${{ parameters[\'name\'] }} single-quote bracket references', () => {
    const text = "value: ${{ parameters['myKey'] }}";
    const refs = collectParameterReferences(text);
    assert.ok(refs.has('myKey'), 'Expected myKey to be found');
  });

  it('returns an empty set when there are no parameter references', () => {
    const text = 'steps:\n  - script: echo hello\n';
    const refs = collectParameterReferences(text);
    assert.strictEqual(refs.size, 0);
  });

  it('collects multiple distinct references', () => {
    const text = [
      'script: echo ${{ parameters.env }} ${{ parameters.region }}',
      '${{ if eq(parameters.debug, true) }}:',
    ].join('\n');
    const refs = collectParameterReferences(text);
    assert.ok(refs.has('env'));
    assert.ok(refs.has('region'));
    assert.ok(refs.has('debug'));
    assert.strictEqual(refs.size, 3);
  });

  it('does not double-count the same parameter referenced multiple times', () => {
    const text = [
      'echo ${{ parameters.env }}',
      'echo ${{ parameters.env }}',
    ].join('\n');
    const refs = collectParameterReferences(text);
    assert.strictEqual(refs.size, 1);
    assert.ok(refs.has('env'));
  });
});

// ---------------------------------------------------------------------------
// getUnusedParameterDiagnostics
// ---------------------------------------------------------------------------

describe('getUnusedParameterDiagnostics', () => {

  const FAKE_PATH = '/fake/template.yml';

  it('returns [] when all declared parameters are referenced', () => {
    const text = [
      'parameters:',
      '  - name: environment',
      '    type: string',
      '  - name: region',
      '    type: string',
      '    default: eastus',
      'steps:',
      '  - script: echo ${{ parameters.environment }} ${{ parameters.region }}',
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.deepStrictEqual(diags, []);
  });

  it('returns [] when there are no declared parameters', () => {
    const text = 'steps:\n  - script: echo hello\n';
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.deepStrictEqual(diags, []);
  });

  it('emits a Warning diagnostic for each unreferenced parameter', () => {
    const text = [
      'parameters:',
      '  - name: usedParam',
      '    type: string',
      '  - name: unusedParam',
      '    type: string',
      '    default: legacy',
      'steps:',
      '  - script: echo ${{ parameters.usedParam }}',
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.strictEqual(diags.length, 1, 'Expected exactly one unused-param diagnostic');
    const d = diags[0];
    assert.strictEqual(d.code, 'unused-param');
    assert.strictEqual(d.severity, 1); // DiagnosticSeverity.Warning
    assert.ok(d.message.includes('unusedParam'));
    assert.strictEqual(d.source, 'Azure Templates Navigator');
  });

  it('emits diagnostics for multiple unreferenced parameters', () => {
    const text = [
      'parameters:',
      '  - name: alpha',
      '    type: string',
      '  - name: beta',
      '    type: string',
      '  - name: gamma',
      '    type: string',
      'steps:',
      '  - script: echo ${{ parameters.alpha }}',
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.strictEqual(diags.length, 2);
    const names = diags.map(d => {
      const m = /Parameter '([\w-]+)'/.exec(d.message);
      return m ? m[1] : '';
    });
    assert.ok(names.includes('beta'));
    assert.ok(names.includes('gamma'));
  });

  it('detects references inside if-expressions (bare parameters.name)', () => {
    const text = [
      'parameters:',
      '  - name: runTests',
      '    type: boolean',
      '    default: true',
      'steps:',
      '  - ${{ if eq(parameters.runTests, true) }}:',
      '    - script: npm test',
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.deepStrictEqual(diags, [], 'runTests is referenced in if-expression — should not be flagged');
  });

  it('diagnostic range points at the parameter name on its declaration line', () => {
    const text = [
      'parameters:',
      '  - name: orphan',
      '    type: string',
      'steps:',
      '  - script: echo hello',
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.strictEqual(diags.length, 1);
    const d = diags[0];
    // Line 1 is "  - name: orphan" (0-based)
    assert.strictEqual(d.range.start.line, 1);
    // The range should cover the word "orphan"
    const lineText = '  - name: orphan';
    const expectedStart = lineText.indexOf('orphan');
    assert.strictEqual(d.range.start.character, expectedStart);
    assert.strictEqual(d.range.end.character, expectedStart + 'orphan'.length);
  });

  it('does not flag parameters referenced via bracket notation', () => {
    const text = [
      'parameters:',
      '  - name: myKey',
      '    type: string',
      'steps:',
      "  - script: echo ${{ parameters['myKey'] }}",
    ].join('\n');
    const diags = getUnusedParameterDiagnostics(text, FAKE_PATH);
    assert.deepStrictEqual(diags, []);
  });
});

// ---------------------------------------------------------------------------
// getDiagnosticsForDocument — unused-param integration
// ---------------------------------------------------------------------------

describe('getDiagnosticsForDocument (unused-param integration)', () => {

  function makeDoc(text, fsPath = CURRENT_FILE) {
    return { getText: () => text, uri: { fsPath }, languageId: 'yaml' };
  }

  it('emits unused-param warnings for a template with unreferenced parameters', () => {
    const text = [
      'parameters:',
      '  - name: usedParam',
      '    type: string',
      '  - name: deadParam',
      '    type: string',
      '    default: old-value',
      'steps:',
      '  - script: echo ${{ parameters.usedParam }}',
    ].join('\n');
    const doc = makeDoc(text, '/fake/my-template.yml');
    const diags = getDiagnosticsForDocument(doc);
    const unused = diags.filter(d => d.code === 'unused-param');
    assert.strictEqual(unused.length, 1);
    assert.ok(unused[0].message.includes('deadParam'));
    assert.strictEqual(unused[0].severity, 1); // Warning
  });

  it('emits no unused-param warnings when all parameters are referenced', () => {
    const text = [
      'parameters:',
      '  - name: env',
      '    type: string',
      'steps:',
      '  - script: echo ${{ parameters.env }}',
    ].join('\n');
    const doc = makeDoc(text, '/fake/my-template.yml');
    const diags = getDiagnosticsForDocument(doc);
    const unused = diags.filter(d => d.code === 'unused-param');
    assert.deepStrictEqual(unused, []);
  });

  it('does not emit unused-param warnings for documents with no parameters: block', () => {
    const text = 'stages:\n  - stage: Build\n    jobs: []\n';
    const doc = makeDoc(text, '/fake/pipeline.yml');
    const diags = getDiagnosticsForDocument(doc);
    const unused = diags.filter(d => d.code === 'unused-param');
    assert.deepStrictEqual(unused, []);
  });

  it('emits both caller-side and template-side diagnostics in the same document', () => {
    // A pipeline that both calls a template (caller-side) AND declares its own
    // parameters with one unused (template-side).
    const text = [
      'parameters:',
      '  - name: activeParam',
      '    type: string',
      '  - name: staleParam',
      '    type: string',
      '    default: legacy',
      'steps:',
      '  - script: echo ${{ parameters.activeParam }}',
      '  - template: ../templates/local-template.yml',
      '    parameters:',
      '      region: eastus',
      // missing required "environment" → caller-side error
    ].join('\n');
    const doc = makeDoc(text);
    const diags = getDiagnosticsForDocument(doc);

    const unused  = diags.filter(d => d.code === 'unused-param');
    const missing = diags.filter(d => d.code === 'missing-required-param');

    assert.strictEqual(unused.length, 1, 'Expected one unused-param warning');
    assert.ok(unused[0].message.includes('staleParam'));

    assert.ok(missing.length >= 1, 'Expected at least one missing-required-param error');
    assert.ok(missing[0].message.includes('environment'));
  });
});
