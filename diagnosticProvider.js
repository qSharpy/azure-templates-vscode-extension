'use strict';

const fs = require('fs');
const vscode = require('vscode');
const {
  parseParameters,
  parseRepositoryAliases,
  parsePassedParameters,
  resolveTemplatePath,
} = require('./hoverProvider');

/**
 * Infers the "kind" of a YAML scalar value for basic type-checking.
 *
 * Returns one of: 'boolean' | 'number' | 'object' | 'string'
 *
 * This is intentionally simple — we only flag obvious mismatches
 * (e.g. passing the literal string "yes" to a boolean parameter).
 *
 * @param {string} value
 * @returns {'boolean'|'number'|'object'|'string'}
 */
function inferValueType(value) {
  if (value === '') return 'string';
  if (/^\[/.test(value) || /^\{/.test(value)) return 'object';
  if (/^(true|false|yes|no|on|off)$/i.test(value)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number';
  // Quoted strings are always strings
  if (/^['"]/.test(value)) return 'string';
  // Pipeline expressions like $(var) or ${{ ... }} — skip type checking
  if (/^\$/.test(value)) return 'string';
  return 'string';
}

/**
 * Maps Azure Pipelines parameter types to the set of inferred value types
 * that are considered compatible.
 *
 * @type {Record<string, string[]>}
 */
const COMPATIBLE_TYPES = {
  string:  ['string'],
  number:  ['number', 'string'],   // numbers can be quoted
  boolean: ['boolean'],
  object:  ['object', 'string'],   // objects can be multi-line (we can't fully parse)
  step:    ['object', 'string'],
  stepList: ['object', 'string'],
  job:     ['object', 'string'],
  jobList: ['object', 'string'],
  deployment: ['object', 'string'],
  deploymentList: ['object', 'string'],
  stage:   ['object', 'string'],
  stageList: ['object', 'string'],
};

/**
 * Validates a single template call site and returns an array of VS Code Diagnostics.
 *
 * @param {string[]}  lines          All lines of the document
 * @param {number}    templateLine   0-based line index of the "- template:" line
 * @param {string}    templateRef    The raw template reference string
 * @param {string}    currentFile    Absolute path of the document being validated
 * @param {Record<string, string>} repoAliases  alias → repo folder name
 * @returns {vscode.Diagnostic[]}
 */
function validateCallSite(lines, templateLine, templateRef, currentFile, repoAliases) {
  const diagnostics = [];

  // Resolve the template file
  const resolved = resolveTemplatePath(templateRef, currentFile, repoAliases);
  if (!resolved || resolved.unknownAlias || !resolved.filePath) return diagnostics;

  const { filePath } = resolved;

  // Read the template
  let templateText;
  try {
    templateText = fs.readFileSync(filePath, 'utf8');
  } catch {
    return diagnostics; // file not found — hoverProvider already handles this
  }

  // Parse declared parameters from the template
  const declared = parseParameters(templateText);
  if (declared.length === 0) return diagnostics;

  const declaredMap = Object.fromEntries(declared.map(p => [p.name, p]));

  // Parse parameters actually passed at this call site
  const passed = parsePassedParameters(lines, templateLine);

  // ── Check 1: Missing required parameters ──────────────────────────────────
  for (const p of declared) {
    if (p.required && !(p.name in passed)) {
      const templateLineText = lines[templateLine];
      const templateKeyStart = templateLineText.indexOf('template:');
      const range = new vscode.Range(
        templateLine, templateKeyStart >= 0 ? templateKeyStart : 0,
        templateLine, templateLineText.length
      );
      const diag = new vscode.Diagnostic(
        range,
        `Missing required parameter '${p.name}' (type: ${p.type}) for template '${templateRef.trim()}'`,
        vscode.DiagnosticSeverity.Error
      );
      diag.source = 'Azure Templates Navigator';
      diag.code = 'missing-required-param';
      diagnostics.push(diag);
    }
  }

  // ── Check 2: Unknown parameters ───────────────────────────────────────────
  for (const [name, info] of Object.entries(passed)) {
    if (!(name in declaredMap)) {
      const passedLineText = lines[info.line];
      const nameStart = passedLineText.indexOf(name);
      const range = new vscode.Range(
        info.line, nameStart >= 0 ? nameStart : 0,
        info.line, nameStart >= 0 ? nameStart + name.length : passedLineText.length
      );
      const diag = new vscode.Diagnostic(
        range,
        `Unknown parameter '${name}' — not declared in template '${templateRef.trim()}'`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'Azure Templates Navigator';
      diag.code = 'unknown-param';
      diagnostics.push(diag);
    }
  }

  // ── Check 3: Type mismatches ──────────────────────────────────────────────
  for (const [name, info] of Object.entries(passed)) {
    const decl = declaredMap[name];
    if (!decl) continue; // already flagged as unknown

    // Skip type checking for pipeline expressions — they're runtime values
    if (/^\$/.test(info.value)) continue;
    // Skip empty values
    if (info.value === '') continue;

    const paramType = decl.type.toLowerCase();
    const compatible = COMPATIBLE_TYPES[paramType];
    if (!compatible) continue; // unknown type — skip

    const inferredType = inferValueType(info.value);
    if (!compatible.includes(inferredType)) {
      const passedLineText = lines[info.line];
      const nameStart = passedLineText.indexOf(name);
      const range = new vscode.Range(
        info.line, nameStart >= 0 ? nameStart : 0,
        info.line, passedLineText.length
      );
      const diag = new vscode.Diagnostic(
        range,
        `Type mismatch for parameter '${name}': template expects '${decl.type}', got value '${info.value}' (inferred as '${inferredType}')`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'Azure Templates Navigator';
      diag.code = 'type-mismatch';
      diagnostics.push(diag);
    }
  }

  return diagnostics;
}

/**
 * Scans an entire YAML document for template call sites and returns all diagnostics.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function getDiagnosticsForDocument(document) {
  const docText = document.getText();
  const lines = docText.split('\n');
  const currentFile = document.uri.fsPath;
  const repoAliases = parseRepositoryAliases(docText);

  const allDiagnostics = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip YAML line comments before matching to avoid false positives from
    // lines like:  # ── Step template: build the .NET project ──
    const stripped = line.replace(/(^\s*#.*|\s#.*)$/, '');
    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(stripped);
    if (!match) continue;

    const templateRef = match[1].trim();
    // Skip template expressions with variables — can't resolve at edit time
    if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;

    const siteDiagnostics = validateCallSite(lines, i, templateRef, currentFile, repoAliases);
    allDiagnostics.push(...siteDiagnostics);
  }

  return allDiagnostics;
}

/**
 * Scans a YAML file on disk (by path) and returns all diagnostics.
 * Used for workspace-wide scanning of files that are not open in the editor.
 *
 * @param {string} fsPath  Absolute path to the YAML file
 * @returns {vscode.Diagnostic[]}
 */
function getDiagnosticsForFile(fsPath) {
  let text;
  try {
    text = fs.readFileSync(fsPath, 'utf8');
  } catch {
    return [];
  }
  const doc = {
    getText: () => text,
    uri: vscode.Uri.file(fsPath),
    languageId: 'yaml',
  };
  return getDiagnosticsForDocument(doc);
}

/**
 * Scans every YAML file in the workspace and populates the DiagnosticCollection.
 * Returns a map of fsPath → Diagnostic[] for consumers (e.g. the sidebar panel).
 *
 * @param {vscode.DiagnosticCollection} collection
 * @returns {Promise<Map<string, vscode.Diagnostic[]>>}
 */
async function scanWorkspace(collection) {
  const results = new Map();

  const uris = await vscode.workspace.findFiles(
    '**/*.{yml,yaml}',
    '{**/node_modules/**,**/.git/**}'
  );

  for (const uri of uris) {
    try {
      const diags = getDiagnosticsForFile(uri.fsPath);
      collection.set(uri, diags);
      if (diags.length > 0) {
        results.set(uri.fsPath, diags);
      }
    } catch (err) {
      console.error(`[Azure Templates Navigator] Error scanning ${uri.fsPath}:`, err);
    }
  }

  // Clear diagnostics for files that no longer have issues
  // (collection.set with empty array removes them from Problems tab)
  return results;
}

/**
 * Creates and returns the diagnostic provider object that manages the
 * DiagnosticCollection lifecycle, document event subscriptions, and
 * workspace-wide file watching.
 *
 * @param {vscode.ExtensionContext} context
 * @param {{ onDidUpdate?: (results: Map<string, vscode.Diagnostic[]>) => void }} [opts]
 * @returns {{ collection: vscode.DiagnosticCollection, refresh: () => Promise<void>, dispose: () => void }}
 */
function createDiagnosticProvider(context, opts = {}) {
  const collection = vscode.languages.createDiagnosticCollection('azure-templates-navigator');

  /** @type {NodeJS.Timeout|null} */
  let debounceTimer = null;

  /** @type {Map<string, vscode.Diagnostic[]>} Latest workspace-wide results */
  let latestResults = new Map();

  /**
   * Notifies the optional listener with the latest results.
   */
  function notifyUpdate() {
    if (typeof opts.onDidUpdate === 'function') {
      opts.onDidUpdate(latestResults);
    }
  }

  /**
   * Runs a full workspace scan and fires the update callback.
   */
  async function runFullScan() {
    try {
      latestResults = await scanWorkspace(collection);
      notifyUpdate();
    } catch (err) {
      console.error('[Azure Templates Navigator] Workspace scan error:', err);
    }
  }

  /**
   * Schedules a diagnostic refresh for the given document, debounced by 500ms.
   * After updating the single document, also refreshes the results map so the
   * sidebar panel stays in sync.
   * @param {vscode.TextDocument} doc
   */
  function scheduleDiagnostics(doc) {
    if (doc.languageId !== 'yaml') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const diags = getDiagnosticsForDocument(doc);
        collection.set(doc.uri, diags);
        // Keep latestResults in sync
        if (diags.length > 0) {
          latestResults.set(doc.uri.fsPath, diags);
        } else {
          latestResults.delete(doc.uri.fsPath);
        }
        notifyUpdate();
      } catch (err) {
        console.error('[Azure Templates Navigator] Diagnostic error:', err);
        collection.set(doc.uri, []);
      }
    }, 500);
  }

  // ── Initial workspace scan ─────────────────────────────────────────────────
  runFullScan();

  // ── Subscribe to open-document events (fast, in-memory) ───────────────────
  const subs = [
    vscode.workspace.onDidOpenTextDocument(scheduleDiagnostics),
    vscode.workspace.onDidChangeTextDocument(e => scheduleDiagnostics(e.document)),
    vscode.workspace.onDidSaveTextDocument(scheduleDiagnostics),
    vscode.workspace.onDidCloseTextDocument(doc => {
      // Re-scan from disk so Problems tab stays accurate after closing
      try {
        const diags = getDiagnosticsForFile(doc.uri.fsPath);
        collection.set(doc.uri, diags);
        if (diags.length > 0) {
          latestResults.set(doc.uri.fsPath, diags);
        } else {
          latestResults.delete(doc.uri.fsPath);
        }
        notifyUpdate();
      } catch {
        collection.delete(doc.uri);
      }
    }),
  ];

  // ── File-system watcher: pick up changes to files not open in the editor ──
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml}');

  const onFileChange = (uri) => {
    // If the file is already open in an editor, the document-change event
    // handles it; skip to avoid double-scanning.
    const isOpen = vscode.workspace.textDocuments.some(
      d => d.uri.fsPath === uri.fsPath
    );
    if (isOpen) return;

    try {
      const diags = getDiagnosticsForFile(uri.fsPath);
      collection.set(uri, diags);
      if (diags.length > 0) {
        latestResults.set(uri.fsPath, diags);
      } else {
        latestResults.delete(uri.fsPath);
      }
      notifyUpdate();
    } catch (err) {
      console.error(`[Azure Templates Navigator] Watcher error for ${uri.fsPath}:`, err);
    }
  };

  watcher.onDidChange(onFileChange);
  watcher.onDidCreate(onFileChange);
  watcher.onDidDelete((uri) => {
    collection.delete(uri);
    latestResults.delete(uri.fsPath);
    notifyUpdate();
  });

  subs.forEach(s => context.subscriptions.push(s));
  context.subscriptions.push(collection);
  context.subscriptions.push(watcher);

  return {
    collection,
    /** Re-runs a full workspace scan on demand. */
    async refresh() {
      await runFullScan();
    },
    /** Returns the latest results map (fsPath → Diagnostic[]). */
    getResults() {
      return latestResults;
    },
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      collection.dispose();
      watcher.dispose();
    },
  };
}

module.exports = {
  createDiagnosticProvider,
  getDiagnosticsForDocument,
  getDiagnosticsForFile,
  scanWorkspace,
  validateCallSite,
  inferValueType,
};
