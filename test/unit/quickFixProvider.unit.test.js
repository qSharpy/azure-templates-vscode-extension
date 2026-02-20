'use strict';

/**
 * Pure-Node unit tests for quickFixProvider.js
 *
 * Tests:
 *   - canonicalLiteralForType
 *   - buildAddMissingParamFix
 *   - buildRemoveUnknownParamFix
 *   - buildFixTypeMismatchFix
 *   - quickFixProvider.provideCodeActions (integration)
 *
 * Run with:  npx mocha test/unit/quickFixProvider.unit.test.js
 */

const assert = require('assert');
const path   = require('path');

// ---------------------------------------------------------------------------
// Stub the 'vscode' module before requiring any extension code.
// ---------------------------------------------------------------------------
const Module = require('module');
const _orig  = Module._load;

/** Minimal in-memory WorkspaceEdit that records operations for assertions. */
class FakeWorkspaceEdit {
  constructor() {
    this._inserts  = []; // { uri, position, text }
    this._deletes  = []; // { uri, range }
    this._replaces = []; // { uri, range, text }
  }
  insert(uri, position, text)       { this._inserts.push({ uri, position, text }); }
  delete(uri, range)                { this._deletes.push({ uri, range }); }
  replace(uri, range, text)         { this._replaces.push({ uri, range, text }); }
}

class FakeRange {
  constructor(startLine, startChar, endLine, endChar) {
    // Two-argument form: new Range(startPosition, endPosition)
    if (startLine instanceof FakePosition && startChar instanceof FakePosition) {
      this.start = startLine;
      this.end   = startChar;
    } else {
      // Four-argument form: new Range(startLine, startChar, endLine, endChar)
      this.start = { line: startLine, character: startChar };
      this.end   = { line: endLine,   character: endChar };
    }
  }
}

class FakePosition {
  constructor(line, character) { this.line = line; this.character = character; }
}

class FakeCodeAction {
  constructor(title, kind) {
    this.title       = title;
    this.kind        = kind;
    this.edit        = null;
    this.diagnostics = [];
    this.isPreferred = false;
  }
}

class FakeDiagnostic {
  constructor(range, message, severity) {
    this.range    = range;
    this.message  = message;
    this.severity = severity;
    this.source   = '';
    this.code     = '';
  }
}

const CodeActionKind = {
  QuickFix: 'quickfix',
  Empty: '',
};

// eslint-disable-next-line no-unused-vars
Module._load = function (request) {
  if (request === 'vscode') {
    return {
      MarkdownString: class {
        constructor() { this.isTrusted = false; this.supportHtml = false; }
        appendMarkdown() { return this; }
      },
      Range:    FakeRange,
      Position: FakePosition,
      Hover:    class { constructor(md, range) { this.contents = md; this.range = range; } },
      Location: class {},
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      Diagnostic: FakeDiagnostic,
      CodeAction: FakeCodeAction,
      CodeActionKind,
      WorkspaceEdit: FakeWorkspaceEdit,
      languages: {
        createDiagnosticCollection: () => ({
          set: () => {}, delete: () => {}, dispose: () => {},
        }),
        registerCodeActionsProvider: () => ({ dispose: () => {} }),
      },
      workspace: {
        getConfiguration: () => ({ get: () => '#c92d35' }),
        textDocuments: [],
        onDidOpenTextDocument:   () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} }),
        onDidSaveTextDocument:   () => ({ dispose: () => {} }),
        onDidCloseTextDocument:  () => ({ dispose: () => {} }),
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
      ThemeIcon:  class { constructor(id, color) { this.id = id; this.color = color; } },
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
  quickFixProvider,
  buildAddMissingParamFix,
  buildRemoveUnknownParamFix,
  buildFixTypeMismatchFix,
  buildRemoveUnusedParamFix,
  canonicalLiteralForType,
  findParametersLine,
  findLastParamLine,
} = require('../../quickFixProvider');

Module._load = _orig;

// ---------------------------------------------------------------------------
// Fixture paths (used for template resolution in add-missing-param tests)
// ---------------------------------------------------------------------------
const FIXTURES     = path.resolve(__dirname, '..', 'fixtures');
const MAIN_REPO    = path.join(FIXTURES, 'main-repo');
const CURRENT_FILE = path.join(MAIN_REPO, 'pipelines', 'azure-pipelines.yml');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal fake TextDocument from an array of line strings.
 *
 * @param {string[]} lines
 * @param {string}   [fsPath]
 * @returns {import('vscode').TextDocument}
 */
function makeDocument(lines, fsPath = CURRENT_FILE) {
  const text = lines.join('\n');
  return {
    getText: () => text,
    uri: { fsPath, toString: () => fsPath },
    languageId: 'yaml',
    lineCount: lines.length,
    lineAt(index) {
      return { text: lines[index], lineNumber: index };
    },
  };
}

/**
 * Builds a fake Diagnostic with the given code and message, placed on `line`.
 *
 * @param {string} code
 * @param {string} message
 * @param {number} [line]
 * @returns {FakeDiagnostic}
 */
function makeDiag(code, message, line = 0) {
  const range = new FakeRange(line, 0, line, message.length);
  const diag  = new FakeDiagnostic(range, message, 1);
  diag.source = 'Azure Templates Navigator';
  diag.code   = code;
  return diag;
}

// ---------------------------------------------------------------------------
// canonicalLiteralForType
// ---------------------------------------------------------------------------

describe('canonicalLiteralForType', () => {

  it('returns "true" for boolean', () => {
    assert.strictEqual(canonicalLiteralForType('boolean'), 'true');
  });

  it('returns "0" for number', () => {
    assert.strictEqual(canonicalLiteralForType('number'), '0');
  });

  it('returns "{}" for object', () => {
    assert.strictEqual(canonicalLiteralForType('object'), '{}');
  });

  it('returns "[]" for step / stepList / job / jobList / stage / stageList', () => {
    for (const t of ['step', 'stepList', 'job', 'jobList', 'stage', 'stageList', 'deployment', 'deploymentList']) {
      assert.strictEqual(canonicalLiteralForType(t), '[]', `Expected [] for type "${t}"`);
    }
  });

  it("returns \"''\" for string and unknown types", () => {
    assert.strictEqual(canonicalLiteralForType('string'), "''");
    assert.strictEqual(canonicalLiteralForType('unknown'), "''");
  });

  it('is case-insensitive', () => {
    assert.strictEqual(canonicalLiteralForType('Boolean'), 'true');
    assert.strictEqual(canonicalLiteralForType('NUMBER'),  '0');
  });
});

// ---------------------------------------------------------------------------
// findParametersLine
// ---------------------------------------------------------------------------

describe('findParametersLine', () => {

  it('returns the line index of the parameters: key', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    env: prod',
    ]);
    assert.strictEqual(findParametersLine(doc, 0), 1);
  });

  it('returns -1 when there is no parameters: block', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '- template: bar.yml',
    ]);
    assert.strictEqual(findParametersLine(doc, 0), -1);
  });

  it('stops at a sibling template line (same indent)', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '- template: bar.yml',
      '  parameters:',
      '    env: prod',
    ]);
    // The parameters: on line 2 belongs to bar.yml (line 1), not foo.yml (line 0)
    assert.strictEqual(findParametersLine(doc, 0), -1);
  });
});

// ---------------------------------------------------------------------------
// findLastParamLine
// ---------------------------------------------------------------------------

describe('findLastParamLine', () => {

  it('returns the last parameter line index', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    env: prod',
      '    region: eastus',
    ]);
    assert.strictEqual(findLastParamLine(doc, 1), 3);
  });

  it('returns the parameters: line itself when the block is empty', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '- template: bar.yml',
    ]);
    assert.strictEqual(findLastParamLine(doc, 1), 1);
  });
});

// ---------------------------------------------------------------------------
// buildRemoveUnknownParamFix
// ---------------------------------------------------------------------------

describe('buildRemoveUnknownParamFix', () => {

  it('returns undefined for a non-matching message', () => {
    const doc  = makeDocument(['    typoParam: someValue']);
    const diag = makeDiag('unknown-param', 'Something else entirely', 0);
    const action = buildRemoveUnknownParamFix(doc, diag);
    assert.strictEqual(action, undefined);
  });

  it('creates a CodeAction that deletes the parameter line', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    env: prod',
      '    typoParam: someValue',
      '    region: eastus',
    ]);
    const diag = makeDiag(
      'unknown-param',
      "Unknown parameter 'typoParam' — not declared in template 'foo.yml'",
      3
    );
    const action = buildRemoveUnknownParamFix(doc, diag);

    assert.ok(action, 'Expected a CodeAction');
    assert.ok(action.title.includes('typoParam'));
    assert.strictEqual(action.kind, CodeActionKind.QuickFix);
    assert.strictEqual(action.isPreferred, true);

    // The edit should delete line 3 (0-based)
    const edit = action.edit;
    assert.ok(edit instanceof FakeWorkspaceEdit);
    assert.strictEqual(edit._deletes.length, 1);
    const del = edit._deletes[0];
    assert.strictEqual(del.range.start.line, 3);
    assert.strictEqual(del.range.end.line,   4); // next line start (lineIndex + 1)
  });

  it('handles deletion of the last line gracefully', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    typoParam: someValue',
    ]);
    const diag = makeDiag(
      'unknown-param',
      "Unknown parameter 'typoParam' — not declared in template 'foo.yml'",
      2
    );
    const action = buildRemoveUnknownParamFix(doc, diag);
    assert.ok(action, 'Expected a CodeAction for last-line deletion');
    assert.strictEqual(action.edit._deletes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// buildFixTypeMismatchFix
// ---------------------------------------------------------------------------

describe('buildFixTypeMismatchFix', () => {

  it('returns undefined for a non-matching message', () => {
    const doc  = makeDocument(['    enabled: yes']);
    const diag = makeDiag('type-mismatch', 'Something unrelated', 0);
    const action = buildFixTypeMismatchFix(doc, diag);
    assert.strictEqual(action, undefined);
  });

  it('replaces the value with the canonical boolean literal', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    enabled: yes',
    ]);
    const diag = makeDiag(
      'type-mismatch',
      "Type mismatch for parameter 'enabled': template expects 'boolean', got value 'yes' (inferred as 'string')",
      2
    );
    const action = buildFixTypeMismatchFix(doc, diag);

    assert.ok(action, 'Expected a CodeAction');
    assert.ok(action.title.includes('boolean'));
    assert.ok(action.title.includes('true'));
    assert.strictEqual(action.kind, CodeActionKind.QuickFix);
    assert.strictEqual(action.isPreferred, true);

    const edit = action.edit;
    assert.ok(edit instanceof FakeWorkspaceEdit);
    assert.strictEqual(edit._replaces.length, 1);
    assert.strictEqual(edit._replaces[0].text, 'true');
  });

  it('replaces the value with the canonical number literal', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    retries: notANumber',
    ]);
    const diag = makeDiag(
      'type-mismatch',
      "Type mismatch for parameter 'retries': template expects 'number', got value 'notANumber' (inferred as 'string')",
      2
    );
    const action = buildFixTypeMismatchFix(doc, diag);
    assert.ok(action);
    assert.strictEqual(action.edit._replaces[0].text, '0');
  });

  it('replaces the value with the canonical string literal', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    env: 42',
    ]);
    const diag = makeDiag(
      'type-mismatch',
      "Type mismatch for parameter 'env': template expects 'string', got value '42' (inferred as 'number')",
      2
    );
    const action = buildFixTypeMismatchFix(doc, diag);
    assert.ok(action);
    assert.strictEqual(action.edit._replaces[0].text, "''");
  });
});

// ---------------------------------------------------------------------------
// buildAddMissingParamFix — uses real fixture template files
// ---------------------------------------------------------------------------

describe('buildAddMissingParamFix', () => {

  it('returns undefined for a non-matching message', () => {
    const doc  = makeDocument(['- template: ../templates/local-template.yml']);
    const diag = makeDiag('missing-required-param', 'Something unrelated', 0);
    const action = buildAddMissingParamFix(doc, diag);
    assert.strictEqual(action, undefined);
  });

  it('inserts a new parameters: block when none exists', () => {
    const doc = makeDocument([
      '- template: ../templates/local-template.yml',
    ]);
    const diag = makeDiag(
      'missing-required-param',
      "Missing required parameter 'environment' (type: string) for template '../templates/local-template.yml'",
      0
    );
    const action = buildAddMissingParamFix(doc, diag);

    assert.ok(action, 'Expected a CodeAction');
    assert.ok(action.title.includes('environment'));
    assert.strictEqual(action.kind, CodeActionKind.QuickFix);
    assert.strictEqual(action.isPreferred, true);

    const edit = action.edit;
    assert.ok(edit instanceof FakeWorkspaceEdit);
    assert.strictEqual(edit._inserts.length, 1);
    const inserted = edit._inserts[0].text;
    assert.ok(inserted.includes('parameters:'), 'Should create a parameters: block');
    assert.ok(inserted.includes('environment:'), 'Should include the parameter name');
  });

  it('appends to an existing parameters: block', () => {
    const doc = makeDocument([
      '- template: ../templates/local-template.yml',
      '  parameters:',
      '    region: eastus',
    ]);
    const diag = makeDiag(
      'missing-required-param',
      "Missing required parameter 'environment' (type: string) for template '../templates/local-template.yml'",
      0
    );
    const action = buildAddMissingParamFix(doc, diag);

    assert.ok(action, 'Expected a CodeAction');
    const edit = action.edit;
    assert.ok(edit instanceof FakeWorkspaceEdit);
    assert.strictEqual(edit._inserts.length, 1);

    // Insertion should be at the end of the last param line (line 2)
    const insert = edit._inserts[0];
    assert.strictEqual(insert.position.line, 2, 'Should insert after the last param line');
    assert.ok(insert.text.includes('environment:'), 'Should include the parameter name');
    // Should NOT re-create parameters: block
    assert.ok(!insert.text.includes('parameters:'), 'Should not duplicate parameters: key');
  });
});

// ---------------------------------------------------------------------------
// quickFixProvider.provideCodeActions — integration
// ---------------------------------------------------------------------------

describe('quickFixProvider.provideCodeActions', () => {

  it('returns [] when no diagnostics match the extension source', () => {
    const doc = makeDocument(['- template: foo.yml']);
    const diag = makeDiag('missing-required-param', 'Some message', 0);
    diag.source = 'some-other-extension';

    const actions = quickFixProvider.provideCodeActions(doc, null, { diagnostics: [diag] });
    assert.deepStrictEqual(actions, []);
  });

  it('returns [] for an unrecognised diagnostic code', () => {
    const doc = makeDocument(['- template: foo.yml']);
    const diag = makeDiag('unknown-code', 'Some message', 0);
    diag.source = 'Azure Templates Navigator';

    const actions = quickFixProvider.provideCodeActions(doc, null, { diagnostics: [diag] });
    assert.deepStrictEqual(actions, []);
  });

  it('returns a remove-unknown-param action for unknown-param diagnostic', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    typoParam: val',
    ]);
    const diag = makeDiag(
      'unknown-param',
      "Unknown parameter 'typoParam' — not declared in template 'foo.yml'",
      2
    );
    diag.source = 'Azure Templates Navigator';

    const actions = quickFixProvider.provideCodeActions(doc, null, { diagnostics: [diag] });
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].title.includes('typoParam'));
  });

  it('returns a fix-type-mismatch action for type-mismatch diagnostic', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    enabled: yes',
    ]);
    const diag = makeDiag(
      'type-mismatch',
      "Type mismatch for parameter 'enabled': template expects 'boolean', got value 'yes' (inferred as 'string')",
      2
    );
    diag.source = 'Azure Templates Navigator';

    const actions = quickFixProvider.provideCodeActions(doc, null, { diagnostics: [diag] });
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].title.includes('boolean'));
  });

  it('handles multiple diagnostics in one pass', () => {
    const doc = makeDocument([
      '- template: foo.yml',
      '  parameters:',
      '    typoParam: val',
      '    enabled: yes',
    ]);

    const diagUnknown = makeDiag(
      'unknown-param',
      "Unknown parameter 'typoParam' — not declared in template 'foo.yml'",
      2
    );
    diagUnknown.source = 'Azure Templates Navigator';

    const diagType = makeDiag(
      'type-mismatch',
      "Type mismatch for parameter 'enabled': template expects 'boolean', got value 'yes' (inferred as 'string')",
      3
    );
    diagType.source = 'Azure Templates Navigator';

    const actions = quickFixProvider.provideCodeActions(
      doc, null, { diagnostics: [diagUnknown, diagType] }
    );
    assert.strictEqual(actions.length, 2);
  });

  it('returns a remove-unused-param action for unused-param diagnostic', () => {
    const doc = makeDocument([
      'parameters:',
      '  - name: usedParam',
      '    type: string',
      '  - name: deadParam',
      '    type: string',
      '    default: legacy',
      'steps:',
      '  - script: echo ${{ parameters.usedParam }}',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'deadParam' is declared but never referenced in the template body",
      3  // line of "  - name: deadParam"
    );
    diag.source = 'Azure Templates Navigator';

    const actions = quickFixProvider.provideCodeActions(doc, null, { diagnostics: [diag] });
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].title.includes('deadParam'));
    assert.ok(actions[0].title.includes('Remove'));
  });
});

// ---------------------------------------------------------------------------
// buildRemoveUnusedParamFix
// ---------------------------------------------------------------------------

describe('buildRemoveUnusedParamFix', () => {

  it('returns undefined for a non-matching message', () => {
    const doc  = makeDocument(['  - name: orphan', '    type: string']);
    const diag = makeDiag('unused-param', 'Something unrelated', 0);
    const action = buildRemoveUnusedParamFix(doc, diag);
    assert.strictEqual(action, undefined);
  });

  it('creates a CodeAction with the correct title and kind', () => {
    const doc = makeDocument([
      'parameters:',
      '  - name: orphan',
      '    type: string',
      '    default: old',
      'steps:',
      '  - script: echo hello',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'orphan' is declared but never referenced in the template body",
      1  // line of "  - name: orphan"
    );
    const action = buildRemoveUnusedParamFix(doc, diag);

    assert.ok(action, 'Expected a CodeAction');
    assert.ok(action.title.includes('orphan'), 'Title should mention the param name');
    assert.ok(action.title.includes('Remove'), 'Title should say Remove');
    assert.strictEqual(action.kind, CodeActionKind.QuickFix);
    assert.strictEqual(action.isPreferred, true);
  });

  it('deletes the name line and all sub-property lines of the parameter entry', () => {
    // Lines:
    //   0: parameters:
    //   1:   - name: orphan
    //   2:     type: string
    //   3:     default: old
    //   4: steps:
    //   5:   - script: echo hello
    const doc = makeDocument([
      'parameters:',
      '  - name: orphan',
      '    type: string',
      '    default: old',
      'steps:',
      '  - script: echo hello',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'orphan' is declared but never referenced in the template body",
      1
    );
    const action = buildRemoveUnusedParamFix(doc, diag);

    assert.ok(action);
    const edit = action.edit;
    assert.ok(edit instanceof FakeWorkspaceEdit);
    assert.strictEqual(edit._deletes.length, 1);

    const del = edit._deletes[0];
    // Should start at line 1 (the "- name: orphan" line)
    assert.strictEqual(del.range.start.line, 1);
    // Should end at line 4 (start of "steps:" — i.e. one past the last sub-property)
    assert.strictEqual(del.range.end.line, 4);
  });

  it('deletes only the single-line entry when there are no sub-properties', () => {
    // Lines:
    //   0: parameters:
    //   1:   - name: orphan
    //   2:   - name: used
    //   3:     type: string
    //   4: steps:
    //   5:   - script: echo ${{ parameters.used }}
    const doc = makeDocument([
      'parameters:',
      '  - name: orphan',
      '  - name: used',
      '    type: string',
      'steps:',
      '  - script: echo ${{ parameters.used }}',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'orphan' is declared but never referenced in the template body",
      1
    );
    const action = buildRemoveUnusedParamFix(doc, diag);

    assert.ok(action);
    const del = action.edit._deletes[0];
    // "  - name: orphan" is line 1; next sibling "  - name: used" is at same indent → endLine = 1
    // Delete range: line 1 col 0 → line 2 col 0
    assert.strictEqual(del.range.start.line, 1);
    assert.strictEqual(del.range.end.line, 2);
  });

  it('handles deletion of the last parameter (last lines in file)', () => {
    const doc = makeDocument([
      'parameters:',
      '  - name: orphan',
      '    type: string',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'orphan' is declared but never referenced in the template body",
      1
    );
    const action = buildRemoveUnusedParamFix(doc, diag);
    assert.ok(action, 'Expected a CodeAction even for last-line deletion');
    assert.strictEqual(action.edit._deletes.length, 1);
  });

  it('sets action.diagnostics to the triggering diagnostic', () => {
    const doc = makeDocument([
      'parameters:',
      '  - name: orphan',
      '    type: string',
      'steps:',
      '  - script: echo hello',
    ]);
    const diag = makeDiag(
      'unused-param',
      "Parameter 'orphan' is declared but never referenced in the template body",
      1
    );
    const action = buildRemoveUnusedParamFix(doc, diag);
    assert.ok(action);
    assert.deepStrictEqual(action.diagnostics, [diag]);
  });
});
