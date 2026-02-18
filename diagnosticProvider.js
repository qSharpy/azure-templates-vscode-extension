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
    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(line);
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
 * Creates and returns the diagnostic provider object that manages the
 * DiagnosticCollection lifecycle and document event subscriptions.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {{ collection: vscode.DiagnosticCollection, dispose: () => void }}
 */
function createDiagnosticProvider(context) {
  const collection = vscode.languages.createDiagnosticCollection('azure-templates-navigator');

  /** @type {NodeJS.Timeout|null} */
  let debounceTimer = null;

  /**
   * Schedules a diagnostic refresh for the given document, debounced by 500ms.
   * @param {vscode.TextDocument} doc
   */
  function scheduleDiagnostics(doc) {
    if (doc.languageId !== 'yaml') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const diags = getDiagnosticsForDocument(doc);
        collection.set(doc.uri, diags);
      } catch (err) {
        console.error('[Azure Templates Navigator] Diagnostic error:', err);
        collection.set(doc.uri, []);
      }
    }, 500);
  }

  // Run on all currently open YAML documents at activation
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'yaml') {
      try {
        collection.set(doc.uri, getDiagnosticsForDocument(doc));
      } catch {
        // ignore errors during initial scan
      }
    }
  }

  // Subscribe to document events
  const subs = [
    vscode.workspace.onDidOpenTextDocument(scheduleDiagnostics),
    vscode.workspace.onDidChangeTextDocument(e => scheduleDiagnostics(e.document)),
    vscode.workspace.onDidSaveTextDocument(scheduleDiagnostics),
    vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
  ];

  subs.forEach(s => context.subscriptions.push(s));
  context.subscriptions.push(collection);

  return {
    collection,
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      collection.dispose();
    },
  };
}

module.exports = {
  createDiagnosticProvider,
  getDiagnosticsForDocument,
  validateCallSite,
  inferValueType,
};
