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
 * Walks backwards from `cursorLine` to find the nearest `- template:` line
 * that is at a shallower indentation level than the cursor line.
 *
 * Returns the template reference string and its line index, or null if not found.
 *
 * @param {string[]} lines
 * @param {number}   cursorLine   0-based
 * @returns {{ templateRef: string, templateLine: number } | null}
 */
function findEnclosingTemplate(lines, cursorLine) {
  const cursorRaw = lines[cursorLine] || '';
  const cursorIndent = cursorRaw.length - cursorRaw.trimStart().length;

  // Track the shallowest indent we've seen so far while walking backwards.
  // Once we find a template: line at a shallower indent than the cursor, return it.
  // Stop only when we hit a top-level (indent 0) non-template line, which means
  // we've left the enclosing block entirely.
  let shallowestSeen = cursorIndent;

  for (let i = cursorLine - 1; i >= 0; i--) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    const stripped = trimmed.trimStart();
    if (stripped === '') continue;

    const lineIndent = trimmed.length - stripped.length;

    // Check if this is a template: line at a shallower indent than the cursor
    if (lineIndent < cursorIndent) {
      // Strip YAML line comments first to avoid matching "# ── Step template: ..."
      const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(
        trimmed.replace(/(^\s*#.*|\s#.*)$/, '')
      );
      if (match) {
        return { templateRef: match[1].trim(), templateLine: i };
      }

      // Update shallowest seen
      if (lineIndent < shallowestSeen) {
        shallowestSeen = lineIndent;
      }

      // If we've reached a top-level (indent 0) non-template line, stop —
      // we've left any possible enclosing template block
      if (lineIndent === 0) {
        break;
      }
    }
  }

  return null;
}

/**
 * Determines whether the cursor is inside the `parameters:` sub-block of a
 * template call site.
 *
 * @param {string[]} lines
 * @param {number}   cursorLine
 * @param {number}   templateLine
 * @returns {boolean}
 */
function isCursorInParametersBlock(lines, cursorLine, templateLine) {
  const templateRaw = lines[templateLine];
  const templateIndent = templateRaw.length - templateRaw.trimStart().length;

  for (let i = templateLine + 1; i <= cursorLine; i++) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    const stripped = trimmed.trimStart();
    if (stripped === '') continue;

    const lineIndent = trimmed.length - stripped.length;

    // If we've gone back to the template's indent or shallower, we're outside
    if (lineIndent <= templateIndent) return false;

    // Found the parameters: block
    if (/^\s+parameters\s*:/.test(trimmed)) {
      return true;
    }

    // Hit something else at the same level as parameters: — not in params block
    break;
  }

  return false;
}

/**
 * The completion provider registered for YAML files.
 *
 * Triggers when the user is typing inside the `parameters:` block under a
 * `- template:` line. Offers completion items for each parameter declared in
 * the referenced template that has not yet been typed.
 */
const completionProvider = {
  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position}     position
   * @returns {vscode.CompletionItem[] | undefined}
   */
  provideCompletionItems(document, position) {
    const docText = document.getText();
    // Normalize CRLF → LF so that regex $ anchors work on Windows-authored files
    const lines = docText.replace(/\r\n/g, '\n').split('\n');
    const cursorLine = position.line;

    // ── Step 1: Find the enclosing template: line ─────────────────────────
    const enclosing = findEnclosingTemplate(lines, cursorLine);
    if (!enclosing) return undefined;

    const { templateRef, templateLine } = enclosing;

    // Skip template expressions with variables — can't resolve at edit time
    if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) return undefined;

    // ── Step 2: Confirm cursor is inside the parameters: block ────────────
    if (!isCursorInParametersBlock(lines, cursorLine, templateLine)) return undefined;

    // ── Step 3: Resolve the template file ─────────────────────────────────
    const repoAliases = parseRepositoryAliases(docText);
    const resolved = resolveTemplatePath(templateRef, document.uri.fsPath, repoAliases);
    if (!resolved || resolved.unknownAlias || !resolved.filePath) return undefined;

    const { filePath } = resolved;

    let templateText;
    try {
      templateText = fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }

    // ── Step 4: Parse declared parameters ────────────────────────────────
    const declared = parseParameters(templateText);
    if (declared.length === 0) return undefined;

    // ── Step 5: Find already-passed parameters to avoid duplicates ────────
    const passed = parsePassedParameters(lines, templateLine);
    const alreadyPassed = new Set(Object.keys(passed));

    // ── Step 6: Build CompletionItems ─────────────────────────────────────
    const items = [];

    for (const param of declared) {
      const item = new vscode.CompletionItem(
        param.name,
        vscode.CompletionItemKind.Property
      );

      // Detail shown on the right side of the completion list
      item.detail = `${param.type}${param.required ? ' (required)' : ''}`;

      // Documentation shown in the popup panel
      const docMd = new vscode.MarkdownString();
      docMd.appendMarkdown(`**Parameter:** \`${param.name}\`\n\n`);
      docMd.appendMarkdown(`**Type:** \`${param.type}\`\n\n`);
      if (param.required) {
        docMd.appendMarkdown(`**⚠️ Required** — no default value\n\n`);
      } else if (param.default !== undefined) {
        docMd.appendMarkdown(`**Default:** \`${param.default}\`\n\n`);
      }
      docMd.appendMarkdown(`_From template:_ \`${templateRef}\``);
      item.documentation = docMd;

      // Insert text: "paramName: " with cursor positioned after the colon
      item.insertText = new vscode.SnippetString(`${param.name}: $0`);

      // Sort: required params first, then alphabetical
      item.sortText = param.required ? `0_${param.name}` : `1_${param.name}`;

      // Mark already-passed params as lower priority (still show them for overwriting)
      if (alreadyPassed.has(param.name)) {
        item.sortText = `2_${param.name}`;
        item.detail += ' (already set)';
      }

      // Tag required params with a special label suffix
      if (param.required) {
        item.label = {
          label: param.name,
          description: '⚠ required',
        };
      }

      items.push(item);
    }

    return items;
  }
};

module.exports = {
  completionProvider,
  // Export internals for unit testing
  findEnclosingTemplate,
  isCursorInParametersBlock,
};
