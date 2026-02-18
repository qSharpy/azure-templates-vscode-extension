'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * Parses Azure Pipeline template parameters from raw YAML text.
 * We intentionally avoid a YAML library so there are zero runtime dependencies
 * and the extension works straight from the marketplace without `npm install`.
 *
 * Azure Pipeline parameter blocks are well-structured:
 *
 *   parameters:
 *     # REQUIRED          ← optional marker on the line BEFORE "- name:"
 *     - name: myParam
 *       type: string
 *       default: 'foo'
 *
 * @param {string} text  Raw file contents
 * @returns {{ name: string, type: string, default: string|undefined, required: boolean }[]}
 */
function parseParameters(text) {
  const lines = text.split('\n');
  const params = [];

  // Find the "parameters:" block
  let inParamsBlock = false;
  let baseIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    // Detect the top-level "parameters:" key
    if (!inParamsBlock) {
      if (/^parameters\s*:/.test(trimmed)) {
        inParamsBlock = true;
      }
      continue;
    }

    // Once inside the block, a non-indented non-empty line that isn't a list
    // item means we've left the parameters block
    if (trimmed.length > 0 && !/^\s/.test(trimmed) && !/^parameters\s*:/.test(trimmed)) {
      break;
    }

    // Match a parameter entry: "  - name: foo"
    const nameMatch = /^(\s*)-\s+name\s*:\s*(.+)$/.exec(trimmed);
    if (!nameMatch) continue;

    const indent = nameMatch[1].length;
    if (baseIndent === -1) baseIndent = indent;

    // Only process items at the same indent level (direct children)
    if (indent !== baseIndent) continue;

    const paramName = nameMatch[2].trim();

    // Check if the line immediately before (skipping blank lines) is "# REQUIRED"
    let required = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim();
      if (prev === '') continue;
      if (/^#\s*REQUIRED\s*$/i.test(prev)) required = true;
      break;
    }

    // Scan forward for type and default within this parameter's sub-block
    let type = 'string';
    let defaultValue;

    for (let j = i + 1; j < lines.length; j++) {
      const sub = lines[j].trimEnd();
      if (sub.trim() === '') continue;

      // If we hit another list item at the same indent, stop
      const nextName = /^(\s*)-\s+name\s*:/.exec(sub);
      if (nextName && nextName[1].length === baseIndent) break;

      // If we hit a line with less or equal indent that isn't a sub-property, stop
      const subIndent = sub.length - sub.trimStart().length;
      if (subIndent <= baseIndent && sub.trim() !== '') break;

      const typeMatch = /^\s+type\s*:\s*(.+)$/.exec(sub);
      if (typeMatch) {
        type = typeMatch[1].trim();
        continue;
      }

      const defaultMatch = /^\s+default\s*:\s*(.*)$/.exec(sub);
      if (defaultMatch) {
        defaultValue = defaultMatch[1].trim();
        continue;
      }
    }

    params.push({ name: paramName, type, default: defaultValue, required });
  }

  return params;
}

/**
 * Walks up the directory tree from `startDir` to find the nearest directory
 * that contains a `.git` folder (i.e. the repo root).
 * Falls back to `startDir` if no `.git` is found.
 *
 * @param {string} startDir
 * @returns {string}
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolves the absolute path of a template reference.
 *
 * Azure Pipelines path rules:
 *   - Starts with "/"  → relative to the repository root (where .git lives),
 *                        NOT the VS Code workspace root (which may be a subfolder)
 *   - Otherwise        → relative to the directory of the file being hovered
 *
 * @param {string} templateRef   The raw string after "template:"
 * @param {string} currentFile   Absolute path of the file being hovered
 * @returns {string|null}
 */
function resolveTemplatePath(templateRef, currentFile) {
  const ref = templateRef.trim();
  if (!ref) return null;

  if (ref.startsWith('/')) {
    // Absolute path: resolve from the repo root (nearest .git ancestor)
    const repoRoot = findRepoRoot(path.dirname(currentFile));
    return path.join(repoRoot, ref.slice(1));
  }

  // Relative path: resolve from the directory of the current file
  return path.join(path.dirname(currentFile), ref);
}

/**
 * Builds the MarkdownString shown in the hover tooltip.
 *
 * @param {string} templateRef
 * @param {{ name: string, type: string, default: string|undefined, required: boolean }[]} params
 * @param {string} requiredColor  CSS hex color for required params
 * @returns {vscode.MarkdownString}
 */
function buildHoverMarkdown(templateRef, params, requiredColor) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = true;

  // Header
  md.appendMarkdown(`**📄 Template:** \`${templateRef.trim()}\`\n\n`);

  if (params.length === 0) {
    md.appendMarkdown('_No parameters defined_');
    return md;
  }

  md.appendMarkdown('**Parameters:**\n\n');

  for (const p of params) {
    const nameHtml = p.required
      ? `<span style="color:${requiredColor};">**${p.name}**</span>`
      : `**${p.name}**`;

    const badge = p.required ? ' _(required)_' : '';
    const defaultPart = p.default !== undefined ? ` — default: \`${p.default}\`` : '';

    md.appendMarkdown(`- ${nameHtml}: \`${p.type}\`${defaultPart}${badge}\n`);
  }

  return md;
}

/**
 * The hover provider registered for YAML files.
 */
const hoverProvider = {
  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @returns {vscode.Hover | undefined}
   */
  provideHover(document, position) {
    const line = document.lineAt(position).text;

    // Match:  "- template: path/to/template.yml"
    // Also handles indented variants and optional leading "- "
    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(line);
    if (!match) return undefined;

    const templateRef = match[1];
    const filePath = resolveTemplatePath(templateRef, document.uri.fsPath);

    if (!filePath) return undefined;

    // Read the template file
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // File doesn't exist or can't be read — show a helpful message
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⚠️ Template not found:**\n\n\`${filePath}\``);
      return new vscode.Hover(md);
    }

    const config = vscode.workspace.getConfiguration('azure-templates-navigator');
    const requiredColor = config.get('requiredParameterColor', '#c92d35');

    const params = parseParameters(text);
    const hoverMarkdown = buildHoverMarkdown(templateRef, params, requiredColor);

    // Provide a code lens range covering the whole "template:" token
    const templateKeyStart = line.indexOf('template:');
    const range = new vscode.Range(
      position.line, templateKeyStart,
      position.line, line.length
    );

    return new vscode.Hover(hoverMarkdown, range);
  }
};

module.exports = hoverProvider;
