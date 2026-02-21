'use strict';
/**
 * bench/vscode-stub.js
 *
 * Minimal stub for the `vscode` module so that extension source files can be
 * required in a plain Node.js process (no VS Code host) for benchmarking.
 *
 * Only the symbols actually referenced at module-load time (not inside
 * function bodies) need to be present here.  Function-body references are
 * fine because the benchmark never calls those code paths.
 *
 * Usage:
 *   node --require ./bench/vscode-stub.js bench/perf-benchmark.js
 */

const stub = {
  // ── Languages ──────────────────────────────────────────────────────────────
  languages: {
    createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, dispose: () => {} }),
    registerHoverProvider:      () => ({ dispose: () => {} }),
    registerDefinitionProvider: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: () => ({ dispose: () => {} }),
    registerCodeActionsProvider: () => ({ dispose: () => {} }),
    getDiagnostics: () => [],
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
  },

  // ── Window ─────────────────────────────────────────────────────────────────
  window: {
    createTreeView:          () => ({ dispose: () => {}, reveal: async () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    createWebviewPanel:      () => ({
      webview: { html: '', onDidReceiveMessage: () => {}, postMessage: () => {}, asWebviewUri: u => u },
      dispose: () => {},
    }),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    showInformationMessage:  () => Promise.resolve(),
    showWarningMessage:      () => Promise.resolve(),
    showInputBox:            () => Promise.resolve(undefined),
    createQuickPick:         () => ({
      onDidChangeValue: () => {}, onDidAccept: () => {}, onDidHide: () => {},
      show: () => {}, hide: () => {}, dispose: () => {},
      items: [], selectedItems: [],
    }),
    tabGroups: { all: [] },
    activeTextEditor: undefined,
  },

  // ── Workspace ──────────────────────────────────────────────────────────────
  workspace: {
    workspaceFolders: [],
    findFiles:        () => Promise.resolve([]),
    getConfiguration: () => ({
      get:    (key, def) => def,
      update: () => Promise.resolve(),
    }),
    onDidOpenTextDocument:   () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidSaveTextDocument:   () => ({ dispose: () => {} }),
    onDidCloseTextDocument:  () => ({ dispose: () => {} }),
    createFileSystemWatcher: () => ({
      onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {},
      dispose: () => {},
    }),
    textDocuments: [],
  },

  // ── Commands ───────────────────────────────────────────────────────────────
  commands: {
    registerCommand:  () => ({ dispose: () => {} }),
    executeCommand:   () => Promise.resolve(),
  },

  // ── Uri ────────────────────────────────────────────────────────────────────
  Uri: {
    file:     p  => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    joinPath: (base, ...parts) => {
      const path = require('path');
      const joined = path.join(
        typeof base === 'string' ? base : (base.fsPath || ''),
        ...parts
      );
      return { fsPath: joined, scheme: 'file', toString: () => `file://${joined}` };
    },
  },

  // ── Enums / constants ──────────────────────────────────────────────────────
  ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: { value: 'quickfix' } },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },

  // ── Classes (used with `new`) ──────────────────────────────────────────────
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon:  class ThemeIcon  { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  MarkdownString: class MarkdownString {
    constructor(value, trusted) { this.value = value || ''; this.isTrusted = !!trusted; }
    appendMarkdown(s) { this.value += s; return this; }
    appendText(s)     { this.value += s; return this; }
  },
  Hover:      class Hover      { constructor(contents, range) { this.contents = contents; this.range = range; } },
  Location:   class Location   { constructor(uri, pos) { this.uri = uri; this.targetRange = pos; } },
  Position:   class Position   { constructor(line, char) { this.line = line; this.character = char; } },
  Range:      class Range      { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
  Diagnostic: class Diagnostic { constructor(range, msg, sev) { this.range = range; this.message = msg; this.severity = sev; } },
  CodeAction: class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } },
  WorkspaceEdit: class WorkspaceEdit { replace() {} insert() {} delete() {} },
  EventEmitter: class EventEmitter {
    constructor() { this._listeners = []; }
    get event() { return cb => { this._listeners.push(cb); return { dispose: () => {} }; }; }
    fire(data) { this._listeners.forEach(l => l(data)); }
    dispose() { this._listeners = []; }
  },

  // ── env ────────────────────────────────────────────────────────────────────
  env: {
    clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
  },
};

// Register as the `vscode` module so any `require('vscode')` resolves to this stub.
require.cache[require.resolve('module')] = require.cache[require.resolve('module')]; // no-op to ensure cache exists
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return stub;
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = stub;
