'use strict';

const vscode = require('vscode');
const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require('./hoverProvider');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the indentation string (leading whitespace) of a document line.
 *
 * @param {vscode.TextDocument} document
 * @param {number} lineIndex  0-based
 * @returns {string}
 */
function lineIndent(document, lineIndex) {
  const text = document.lineAt(lineIndex).text;
  return text.slice(0, text.length - text.trimStart().length);
}

/**
 * Walks forward from `templateLine` to find the `parameters:` sub-block.
 * Returns the 0-based line index of the `parameters:` line, or -1 if absent.
 *
 * @param {vscode.TextDocument} document
 * @param {number} templateLine
 * @returns {number}
 */
function findParametersLine(document, templateLine) {
  const templateIndent = lineIndent(document, templateLine).length;

  for (let i = templateLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const stripped = text.trimStart();
    if (stripped === '') continue;

    const indent = text.length - stripped.length;
    if (indent <= templateIndent) break; // left the template block

    if (/^parameters\s*:/.test(stripped)) return i;
  }
  return -1;
}

/**
 * Finds the last parameter line inside the `parameters:` sub-block that
 * starts at `paramsLine`.  Returns the 0-based line index of the last
 * key: value line, or `paramsLine` itself when the block is empty.
 *
 * @param {vscode.TextDocument} document
 * @param {number} paramsLine  0-based line of the `parameters:` key
 * @returns {number}
 */
function findLastParamLine(document, paramsLine) {
  const paramsIndent = lineIndent(document, paramsLine).length;
  let last = paramsLine;

  for (let i = paramsLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const stripped = text.trimStart();
    if (stripped === '') continue;

    const indent = text.length - stripped.length;
    if (indent <= paramsIndent) break; // left the parameters block

    last = i;
  }
  return last;
}

/**
 * Resolves the declared parameters for the template referenced on `templateLine`.
 *
 * @param {vscode.TextDocument} document
 * @param {number} templateLine
 * @returns {{ name: string, type: string, default: string|undefined, required: boolean }[]}
 */
function getDeclaredParams(document, templateLine) {
  const lineText = document.lineAt(templateLine).text;
  const stripped = lineText.replace(/(^\s*#.*|\s#.*)$/, '');
  const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(stripped);
  if (!match) return [];

  const templateRef = match[1].trim();
  const docText = document.getText();
  const repoAliases = parseRepositoryAliases(docText);
  const resolved = resolveTemplatePath(templateRef, document.uri.fsPath, repoAliases);

  if (!resolved || resolved.unknownAlias || !resolved.filePath) return [];

  let templateText;
  try {
    templateText = fs.readFileSync(resolved.filePath, 'utf8');
  } catch {
    return [];
  }

  return parseParameters(templateText);
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-fix builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Add missing parameter" quick-fix.
 *
 * Inserts `<paramName>: ` at the correct indentation level inside the
 * `parameters:` sub-block of the template call.  If no `parameters:` block
 * exists yet, one is created.
 *
 * The inserted text uses a SnippetString so the cursor lands on the value
 * placeholder after the fix is applied.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic}   diagnostic
 * @returns {vscode.CodeAction | undefined}
 */
function buildAddMissingParamFix(document, diagnostic) {
  // Extract the parameter name from the diagnostic message:
  //   "Missing required parameter 'foo' (type: string) for template '...'"
  const msgMatch = /Missing required parameter '([\w-]+)'\s+\(type:\s*([\w]+)\)/.exec(
    diagnostic.message
  );
  if (!msgMatch) return undefined;

  const paramName = msgMatch[1];
  const paramType = msgMatch[2];

  const templateLine = diagnostic.range.start.line;

  // Determine the indentation for the new parameter line.
  // The template line itself is the reference; parameters are indented 2 more
  // spaces than the template line's own indent.
  const templateIndentStr = lineIndent(document, templateLine);
  const paramIndentStr = templateIndentStr + '    '; // 4 spaces deeper (2 for params: + 2 for key)

  // Find or plan the insertion point
  const paramsLine = findParametersLine(document, templateLine);

  let edit;
  let insertPosition;

  if (paramsLine === -1) {
    // No `parameters:` block yet — insert after the template line
    const paramsIndentStr = templateIndentStr + '  '; // 2 spaces deeper than template
    const newText = `\n${paramsIndentStr}parameters:\n${paramIndentStr}${paramName}: `;
    insertPosition = new vscode.Position(
      templateLine,
      document.lineAt(templateLine).text.length
    );
    edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, insertPosition, newText);
  } else {
    // Append after the last existing parameter in the block
    const lastParamLine = findLastParamLine(document, paramsLine);
    insertPosition = new vscode.Position(
      lastParamLine,
      document.lineAt(lastParamLine).text.length
    );
    edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, insertPosition, `\n${paramIndentStr}${paramName}: `);
  }

  const action = new vscode.CodeAction(
    `Add missing parameter '${paramName}' (${paramType})`,
    vscode.CodeActionKind.QuickFix
  );
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  return action;
}

/**
 * "Remove unknown parameter" quick-fix.
 *
 * Deletes the entire line that contains the unknown parameter key.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic}   diagnostic
 * @returns {vscode.CodeAction | undefined}
 */
function buildRemoveUnknownParamFix(document, diagnostic) {
  const msgMatch = /Unknown parameter '([\w-]+)'/.exec(diagnostic.message);
  if (!msgMatch) return undefined;

  const paramName = msgMatch[1];
  const lineIndex = diagnostic.range.start.line;

  // Delete the full line including its newline character
  const lineCount = document.lineCount;
  let deleteRange;
  if (lineIndex < lineCount - 1) {
    // Delete from start of this line to start of next line (removes the \n too)
    deleteRange = new vscode.Range(
      new vscode.Position(lineIndex, 0),
      new vscode.Position(lineIndex + 1, 0)
    );
  } else {
    // Last line — delete from end of previous line to end of this line
    const prevLineEnd = lineIndex > 0
      ? document.lineAt(lineIndex - 1).text.length
      : 0;
    deleteRange = new vscode.Range(
      new vscode.Position(Math.max(0, lineIndex - 1), prevLineEnd),
      new vscode.Position(lineIndex, document.lineAt(lineIndex).text.length)
    );
  }

  const edit = new vscode.WorkspaceEdit();
  edit.delete(document.uri, deleteRange);

  const action = new vscode.CodeAction(
    `Remove unknown parameter '${paramName}'`,
    vscode.CodeActionKind.QuickFix
  );
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  return action;
}

/**
 * Returns the canonical literal format for a given Azure Pipelines parameter type.
 *
 * @param {string} paramType
 * @returns {string}
 */
function canonicalLiteralForType(paramType) {
  switch (paramType.toLowerCase()) {
    case 'boolean':   return 'true';
    case 'number':    return '0';
    case 'object':    return '{}';
    case 'step':
    case 'steplist':  return '[]';
    case 'job':
    case 'joblist':   return '[]';
    case 'deployment':
    case 'deploymentlist': return '[]';
    case 'stage':
    case 'stagelist': return '[]';
    default:          return "''";
  }
}

/**
 * "Fix type mismatch" quick-fix.
 *
 * Replaces the current value on the parameter line with the canonical literal
 * for the expected type (e.g. `true` for boolean, `0` for number, `''` for string).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic}   diagnostic
 * @returns {vscode.CodeAction | undefined}
 */
function buildFixTypeMismatchFix(document, diagnostic) {
  // Message: "Type mismatch for parameter 'foo': template expects 'boolean', got value 'yes' (inferred as 'boolean')"
  const msgMatch = /Type mismatch for parameter '([\w-]+)':\s*template expects '([\w]+)'/.exec(
    diagnostic.message
  );
  if (!msgMatch) return undefined;

  const paramName = msgMatch[1];
  const expectedType = msgMatch[2];
  const lineIndex = diagnostic.range.start.line;
  const lineText = document.lineAt(lineIndex).text;

  // Find the colon separating key from value
  const colonIdx = lineText.indexOf(':', lineText.indexOf(paramName));
  if (colonIdx === -1) return undefined;

  // The value starts after the colon (and any whitespace)
  const valueStart = colonIdx + 1;
  const valueText = lineText.slice(valueStart);
  const leadingSpaces = valueText.length - valueText.trimStart().length;
  const valueCharStart = valueStart + leadingSpaces;
  const valueCharEnd = lineText.length;

  const suggestedLiteral = canonicalLiteralForType(expectedType);

  const replaceRange = new vscode.Range(
    new vscode.Position(lineIndex, valueCharStart),
    new vscode.Position(lineIndex, valueCharEnd)
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, replaceRange, suggestedLiteral);

  const action = new vscode.CodeAction(
    `Fix type mismatch: replace value with ${expectedType} literal (${suggestedLiteral})`,
    vscode.CodeActionKind.QuickFix
  );
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  return action;
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeActionProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VS Code CodeActionProvider that surfaces quick-fixes for diagnostics emitted
 * by the Azure Templates Navigator diagnostic provider.
 *
 * Handles three diagnostic codes:
 *   - `missing-required-param`  → "Add missing parameter"
 *   - `unknown-param`           → "Remove unknown parameter"
 *   - `type-mismatch`           → "Fix type mismatch"
 */
const quickFixProvider = {
  /**
   * @param {vscode.TextDocument}          document
   * @param {vscode.Range}                 _range
   * @param {vscode.CodeActionContext}     context
   * @returns {vscode.CodeAction[]}
   */
  provideCodeActions(document, _range, context) {
    /** @type {vscode.CodeAction[]} */
    const actions = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'Azure Templates Navigator') continue;

      let action;
      switch (diagnostic.code) {
        case 'missing-required-param':
          action = buildAddMissingParamFix(document, diagnostic);
          break;
        case 'unknown-param':
          action = buildRemoveUnknownParamFix(document, diagnostic);
          break;
        case 'type-mismatch':
          action = buildFixTypeMismatchFix(document, diagnostic);
          break;
        default:
          break;
      }

      if (action) actions.push(action);
    }

    return actions;
  },
};

module.exports = {
  quickFixProvider,
  // Export internals for unit testing
  buildAddMissingParamFix,
  buildRemoveUnknownParamFix,
  buildFixTypeMismatchFix,
  canonicalLiteralForType,
  findParametersLine,
  findLastParamLine,
};
