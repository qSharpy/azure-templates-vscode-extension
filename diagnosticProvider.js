'use strict';

const fs        = require('fs');
const vscode    = require('vscode');
const fileCache = require('./fileCache');
const {
  parseParameters,
  parseRepositoryAliases,
  parsePassedParameters,
  resolveTemplatePath,
} = require('./hoverProvider');

// ─────────────────────────────────────────────────────────────────────────────
// Unused-parameter detection (template-side inspection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the set of parameter names that are actually referenced in the
 * template body via `${{ parameters.name }}` (or the shorthand
 * `${{ parameters['name'] }}`).
 *
 * We intentionally scan the *entire* file text so that references inside
 * multi-line scripts, condition expressions, and nested YAML values are all
 * captured.
 *
 * @param {string} text  Raw template file contents
 * @returns {Set<string>}
 */
function collectParameterReferences(text) {
  const refs = new Set();
  // Match both:
  //   ${{ parameters.name }}
  //   ${{ parameters['name'] }}  or  ${{ parameters["name"] }}
  //   parameters.name  (bare, inside if-expressions like eq(parameters.foo, 'x'))
  const pattern = /\$\{\{[^}]*parameters\.(\w+)[^}]*\}\}|\$\{\{[^}]*parameters\[['"](\w+)['"]\][^}]*\}\}|(?<!\w)parameters\.(\w+)/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name) refs.add(name);
  }
  return refs;
}

/**
 * Detects parameters declared in the `parameters:` block of a template file
 * that are never referenced in the template body.
 *
 * Only runs when the file looks like a **template** (i.e. it has a top-level
 * `parameters:` block but no top-level `trigger:` / `pr:` / `schedules:` /
 * `stages:` / `jobs:` / `steps:` at the root level that would indicate it is
 * a pipeline entry-point rather than a reusable template).
 *
 * Actually, Azure Pipelines templates *can* have top-level `steps:`, `jobs:`,
 * or `stages:` — that is exactly what makes them templates.  We therefore
 * check for `parameters:` at the top level and run the inspection regardless.
 * Pipeline entry-points that also declare parameters are valid targets too
 * (they can have unused parameters after refactoring).
 *
 * @param {string} text      Raw file contents
 * @param {string} filePath  Absolute path (used to build diagnostic ranges)
 * @returns {vscode.Diagnostic[]}
 */
function getUnusedParameterDiagnostics(text, filePath) {
  const diagnostics = [];

  const declared = parseParameters(text);
  if (declared.length === 0) return diagnostics;

  const refs = collectParameterReferences(text);

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (const param of declared) {
    if (refs.has(param.name)) continue; // referenced — OK

    // Find the exact column of the parameter name on its declaration line.
    // param.line is the 0-based line of "  - name: <paramName>"
    const lineText = lines[param.line] || '';
    const nameIdx = lineText.indexOf(param.name);
    const startChar = nameIdx >= 0 ? nameIdx : 0;
    const endChar   = nameIdx >= 0 ? nameIdx + param.name.length : lineText.length;

    const range = new vscode.Range(
      param.line, startChar,
      param.line, endChar
    );

    const diag = new vscode.Diagnostic(
      range,
      `Parameter '${param.name}' is declared but never referenced in the template body`,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'Azure Templates Navigator';
    diag.code   = 'unused-param';
    diagnostics.push(diag);
  }

  return diagnostics;
}

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
  if (!resolved || resolved.unknownAlias || !resolved.filePath) {
    return diagnostics;
  }

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
  // A parameter is required when it has no default value (Azure Pipelines
  // runtime behaviour). If it is missing at the call site, that is an error.
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
 * Also runs the unused-parameter inspection when the document itself is a template
 * (i.e. it has a top-level `parameters:` block).
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function getDiagnosticsForDocument(document) {
  const docText = document.getText();
  // Normalize CRLF → LF so that regex $ anchors work on Windows-authored files
  const lines = docText.replace(/\r\n/g, '\n').split('\n');
  const currentFile = document.uri.fsPath;
  const repoAliases = parseRepositoryAliases(docText);

  const allDiagnostics = [];

  // ── Caller-side checks: validate every template call site ─────────────────
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

  // ── Template-side check: detect unused declared parameters ────────────────
  // Run whenever the file has a top-level `parameters:` block.
  if (/^parameters\s*:/m.test(docText)) {
    const unusedDiags = getUnusedParameterDiagnostics(docText, currentFile);
    allDiagnostics.push(...unusedDiags);
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
    // Invalidate the file cache so the next read gets fresh content
    fileCache.invalidate(uri.fsPath);

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
    fileCache.invalidate(uri.fsPath);
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
  getUnusedParameterDiagnostics,
  collectParameterReferences,
};
