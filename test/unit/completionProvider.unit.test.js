'use strict';

/**
 * Pure-Node unit tests for completionProvider.js
 *
 * Tests:
 *   - findEnclosingTemplate
 *   - isCursorInParametersBlock
 *   - provideCompletionItems (via mock document)
 *
 * Run with:  npx mocha test/unit/completionProvider.unit.test.js
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
        constructor() { this.isTrusted = false; }
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
          this.range = range; this.message = message; this.severity = severity;
        }
      },
      languages: {
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, dispose: () => {} }),
      },
      workspace: {
        getConfiguration: () => ({ get: () => '#c92d35' }),
        textDocuments: [],
        onDidOpenTextDocument:   () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} }),
        onDidSaveTextDocument:   () => ({ dispose: () => {} }),
        onDidCloseTextDocument:  () => ({ dispose: () => {} }),
      },
      window: {
        activeTextEditor: null,
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        createTreeView: () => ({ dispose: () => {}, title: '' }),
      },
      Uri: { file: (p) => ({ fsPath: p }) },
      commands: { registerCommand: () => ({ dispose: () => {} }) },
      TreeItem: class { constructor(label) { this.label = label; } },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(id) { this.id = id; } },
      CompletionItem: class {
        constructor(label, kind) {
          this.label = label;
          this.kind  = kind;
          this.detail = '';
          this.documentation = null;
          this.insertText = null;
          this.sortText = '';
        }
      },
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

const { findEnclosingTemplate, isCursorInParametersBlock, completionProvider } =
  require('../../completionProvider');

Module._load = _orig;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES    = path.resolve(__dirname, '..', 'fixtures');
const MAIN_REPO   = path.join(FIXTURES, 'main-repo');
const CURRENT_FILE = path.join(MAIN_REPO, 'pipelines', 'azure-pipelines.yml');

// ---------------------------------------------------------------------------
// findEnclosingTemplate
// ---------------------------------------------------------------------------

describe('findEnclosingTemplate', () => {

  it('returns null when there is no template: line above the cursor', () => {
    const lines = [
      'stages:',
      '  - stage: Build',
      '    jobs: []',
    ];
    assert.strictEqual(findEnclosingTemplate(lines, 2), null);
  });

  it('finds a template: line directly above the cursor', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: foo',  // cursor here (line 2)
    ];
    const result = findEnclosingTemplate(lines, 2);
    assert.ok(result, 'Expected a result');
    assert.strictEqual(result.templateRef, 'templates/build.yml');
    assert.strictEqual(result.templateLine, 0);
  });

  it('finds a template: line several lines above the cursor', () => {
    const lines = [
      '- template: templates/deploy.yml',
      '  parameters:',
      '    environment: Production',
      '    azureSubscription: my-sub',  // cursor here (line 3)
    ];
    const result = findEnclosingTemplate(lines, 3);
    assert.ok(result);
    assert.strictEqual(result.templateRef, 'templates/deploy.yml');
    assert.strictEqual(result.templateLine, 0);
  });

  it('returns null when cursor is at the same indent as the template: line', () => {
    const lines = [
      '- template: templates/build.yml',
      '- template: templates/deploy.yml',  // cursor here — same indent, not a child
    ];
    assert.strictEqual(findEnclosingTemplate(lines, 1), null);
  });

  it('handles cross-repo template references', () => {
    const lines = [
      '- template: stages/build.yml@templates',
      '  parameters:',
      '    buildConfiguration: Release',  // cursor here
    ];
    const result = findEnclosingTemplate(lines, 2);
    assert.ok(result);
    assert.strictEqual(result.templateRef, 'stages/build.yml@templates');
  });
});

// ---------------------------------------------------------------------------
// isCursorInParametersBlock
// ---------------------------------------------------------------------------

describe('isCursorInParametersBlock', () => {

  it('returns true when cursor is inside the parameters: block', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: foo',  // cursor here (line 2)
    ];
    assert.strictEqual(isCursorInParametersBlock(lines, 2, 0), true);
  });

  it('returns false when there is no parameters: block', () => {
    const lines = [
      '- template: templates/build.yml',
      '  someOtherKey: value',
      '    nested: thing',  // cursor here
    ];
    assert.strictEqual(isCursorInParametersBlock(lines, 2, 0), false);
  });

  it('returns false when cursor is on the template: line itself', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: foo',
    ];
    assert.strictEqual(isCursorInParametersBlock(lines, 0, 0), false);
  });

  it('returns true when cursor is on the parameters: line', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',  // cursor here (line 1)
      '    project: foo',
    ];
    assert.strictEqual(isCursorInParametersBlock(lines, 1, 0), true);
  });
});

// ---------------------------------------------------------------------------
// completionProvider.provideCompletionItems — using mock documents
// ---------------------------------------------------------------------------

describe('completionProvider.provideCompletionItems', () => {

  /**
   * Creates a minimal mock TextDocument.
   * @param {string[]} lines
   * @param {number}   cursorLine
   * @param {string}   fsPath
   */
  function makeDoc(lines, cursorLine, fsPath = CURRENT_FILE) {
    const text = lines.join('\n');
    return {
      getText: () => text,
      uri: { fsPath },
      languageId: 'yaml',
      lineAt: (line) => ({ text: lines[line] || '' }),
    };
  }

  function makePosition(line, character) {
    return { line, character };
  }

  it('returns undefined when cursor is not inside a parameters block', () => {
    const lines = [
      'stages:',
      '  - stage: Build',
    ];
    const doc = makeDoc(lines, 1);
    const result = completionProvider.provideCompletionItems(doc, makePosition(1, 10));
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when template ref contains a variable expression', () => {
    const lines = [
      '- template: ${{ variables.templatePath }}',
      '  parameters:',
      '    ',  // cursor here
    ];
    const doc = makeDoc(lines, 2);
    const result = completionProvider.provideCompletionItems(doc, makePosition(2, 4));
    assert.strictEqual(result, undefined);
  });

  it('returns completion items for a resolvable local template', () => {
    // local-template.yml has: environment (required), region (default: eastus)
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    ',  // cursor here (line 2)
    ];
    const doc = makeDoc(lines, 2);
    const result = completionProvider.provideCompletionItems(doc, makePosition(2, 4));

    assert.ok(Array.isArray(result), 'Expected an array of completion items');
    assert.ok(result.length >= 2, `Expected at least 2 items, got ${result.length}`);

    // Check that "environment" is present and marked required
    const envItem = result.find(i =>
      (typeof i.label === 'string' ? i.label : i.label.label) === 'environment'
    );
    assert.ok(envItem, 'Expected "environment" completion item');
    assert.ok(envItem.detail.includes('required'), `Expected detail to include "required", got: ${envItem.detail}`);

    // Check that "region" is present
    const regionItem = result.find(i =>
      (typeof i.label === 'string' ? i.label : i.label.label) === 'region'
    );
    assert.ok(regionItem, 'Expected "region" completion item');
  });

  it('sorts required parameters before optional ones', () => {
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    ',  // cursor here
    ];
    const doc = makeDoc(lines, 2);
    const result = completionProvider.provideCompletionItems(doc, makePosition(2, 4));
    assert.ok(Array.isArray(result));

    // Required params have sortText starting with "0_", optional with "1_"
    const envItem = result.find(i =>
      (typeof i.label === 'string' ? i.label : i.label.label) === 'environment'
    );
    const regionItem = result.find(i =>
      (typeof i.label === 'string' ? i.label : i.label.label) === 'region'
    );
    assert.ok(envItem.sortText < regionItem.sortText,
      `Required param should sort before optional: ${envItem.sortText} vs ${regionItem.sortText}`);
  });

  it('returns undefined when template file does not exist', () => {
    const lines = [
      '- template: ../templates/nonexistent-template.yml',
      '  parameters:',
      '    ',  // cursor here
    ];
    const doc = makeDoc(lines, 2);
    const result = completionProvider.provideCompletionItems(doc, makePosition(2, 4));
    assert.strictEqual(result, undefined);
  });

  it('inserts a snippet with the parameter name and cursor after colon', () => {
    const lines = [
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    ',
    ];
    const doc = makeDoc(lines, 2);
    const result = completionProvider.provideCompletionItems(doc, makePosition(2, 4));
    assert.ok(Array.isArray(result) && result.length > 0);

    for (const item of result) {
      const name = typeof item.label === 'string' ? item.label : item.label.label;
      assert.ok(item.insertText, `Expected insertText for item "${name}"`);
      assert.ok(item.insertText.value.includes(name),
        `Expected insertText to include param name "${name}"`);
      assert.ok(item.insertText.value.includes(': '),
        `Expected insertText to include ": " for "${name}"`);
    }
  });
});
