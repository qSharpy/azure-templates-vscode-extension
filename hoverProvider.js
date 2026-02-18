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
 * Parses the `resources.repositories` block from a pipeline YAML document and
 * returns a map of  alias → repo-name  (the last segment of `name: org/repo`).
 *
 * Example YAML:
 *   resources:
 *     repositories:
 *       - repository: templates
 *         name: myorg/template-repo-name
 *         type: git
 *
 * Returns: { templates: 'template-repo-name' }
 *
 * @param {string} text  Raw file contents of the pipeline YAML
 * @returns {Record<string, string>}  alias → repo folder name
 */
function parseRepositoryAliases(text) {
  const lines = text.split('\n');
  const aliases = {};

  let inResources = false;
  let inRepositories = false;
  let repoIndent = -1;

  let currentAlias = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    const stripped = trimmed.trimStart();

    // Detect top-level "resources:" key
    if (!inResources) {
      if (/^resources\s*:/.test(trimmed)) {
        inResources = true;
      }
      continue;
    }

    // If we hit another top-level key, we've left the resources block
    if (trimmed.length > 0 && !/^\s/.test(trimmed)) {
      break;
    }

    // Detect "  repositories:" inside resources
    if (!inRepositories) {
      if (/^\s+repositories\s*:/.test(trimmed)) {
        inRepositories = true;
      }
      continue;
    }

    // If we hit a sibling key inside resources (same or less indent than "repositories:"),
    // we've left the repositories block
    const lineIndent = trimmed.length - stripped.length;

    // Detect a new repository list item: "    - repository: alias"
    const repoMatch = /^(\s*)-\s+repository\s*:\s*(.+)$/.exec(trimmed);
    if (repoMatch) {
      const indent = repoMatch[1].length;
      if (repoIndent === -1) repoIndent = indent;

      // A list item at a shallower indent means we've left repositories
      if (indent < repoIndent) break;

      // Only process items at the base repository list indent
      if (indent === repoIndent) {
        currentAlias = repoMatch[2].trim();
      }
      continue;
    }

    // If we're inside a repository item, look for "name: org/repo"
    if (currentAlias !== null) {
      const nameMatch = /^\s+name\s*:\s*(.+)$/.exec(trimmed);
      if (nameMatch) {
        const fullName = nameMatch[1].trim();
        // Extract just the repo name (last segment after "/")
        const repoName = fullName.includes('/')
          ? fullName.split('/').pop()
          : fullName;
        aliases[currentAlias] = repoName;
        continue;
      }

      // If we hit a line at the same or shallower indent as the list item
      // that isn't a sub-property, reset currentAlias
      if (repoIndent !== -1 && lineIndent <= repoIndent && stripped !== '') {
        currentAlias = null;
      }
    }
  }

  return aliases;
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
 *   - Contains "@alias"  → external repository; resolved as
 *                          {repoRoot}/../{repo-name}/{templatePath}
 *                          where repo-name comes from `resources.repositories`
 *   - Starts with "/"   → relative to the repository root (where .git lives),
 *                          NOT the VS Code workspace root (which may be a subfolder)
 *   - Otherwise         → relative to the directory of the file being hovered
 *
 * @param {string} templateRef        The raw string after "template:"
 * @param {string} currentFile        Absolute path of the file being hovered
 * @param {Record<string, string>} repoAliases  alias → repo folder name map
 * @returns {{ filePath: string, repoName: string|null }|null}
 */
function resolveTemplatePath(templateRef, currentFile, repoAliases) {
  const ref = templateRef.trim();
  if (!ref) return null;

  // Check for cross-repo reference: "path/to/template.yml@alias"
  const atIndex = ref.lastIndexOf('@');
  if (atIndex !== -1) {
    const templatePath = ref.slice(0, atIndex).trim();
    const alias = ref.slice(atIndex + 1).trim();

    // Special alias "self" means the current repository — treat as normal
    if (alias === 'self') {
      return resolveLocalPath(templatePath, currentFile);
    }

    const repoName = repoAliases && repoAliases[alias];
    if (!repoName) {
      // Alias not found in resources.repositories — return null so the caller
      // can show a "repository alias not found" message
      return { filePath: null, repoName: null, alias, unknownAlias: true };
    }

    // Resolve: {repoRoot}/../{repo-name}/{templatePath}
    const repoRoot = findRepoRoot(path.dirname(currentFile));
    const parentDir = path.dirname(repoRoot);
    const filePath = path.join(parentDir, repoName, templatePath.startsWith('/') ? templatePath.slice(1) : templatePath);
    return { filePath, repoName, alias };
  }

  return resolveLocalPath(ref, currentFile);
}

/**
 * Resolves a local (non-cross-repo) template path.
 *
 * @param {string} ref
 * @param {string} currentFile
 * @returns {{ filePath: string, repoName: null }}
 */
function resolveLocalPath(ref, currentFile) {
  if (ref.startsWith('/')) {
    // Absolute path: resolve from the repo root (nearest .git ancestor)
    const repoRoot = findRepoRoot(path.dirname(currentFile));
    return { filePath: path.join(repoRoot, ref.slice(1)), repoName: null };
  }

  // Relative path: resolve from the directory of the current file
  return { filePath: path.join(path.dirname(currentFile), ref), repoName: null };
}

/**
 * Builds the MarkdownString shown in the hover tooltip.
 *
 * @param {string} templateRef
 * @param {{ name: string, type: string, default: string|undefined, required: boolean }[]} params
 * @param {string} requiredColor  CSS hex color for required params
 * @param {string|null} repoName  External repo name (if cross-repo reference)
 * @param {string|null} filePath  Absolute path to the resolved template file (for navigation links)
 * @returns {vscode.MarkdownString}
 */
function buildHoverMarkdown(templateRef, params, requiredColor, repoName, filePath) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = true;

  // Header
  md.appendMarkdown(`**📄 Template:** \`${templateRef.trim()}\`\n\n`);

  if (repoName) {
    md.appendMarkdown(`**🔗 External repository:** \`${repoName}\`\n\n`);
  }

  // Navigation links — only when we have a resolved file path.
  // We route both links through our own registered command so that
  // ViewColumn.Beside (= 3) is resolved at runtime by the extension host,
  // not serialised into the command: URI where vscode.open ignores it.
  if (filePath) {
    const openArgs = encodeURIComponent(JSON.stringify([{ filePath, beside: false }]));
    const openCmd = `command:azure-templates-navigator.openTemplate?${openArgs}`;

    const sideArgs = encodeURIComponent(JSON.stringify([{ filePath, beside: true }]));
    const sideCmd = `command:azure-templates-navigator.openTemplate?${sideArgs}`;

    md.appendMarkdown(`[$(go-to-file) Open](${openCmd}) · [$(split-horizontal) Open to side](${sideCmd})\n\n`);
  }

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

    const templateRef = match[1].trim();

    // Parse repository aliases from the full document text
    const docText = document.getText();
    const repoAliases = parseRepositoryAliases(docText);

    const resolved = resolveTemplatePath(templateRef, document.uri.fsPath, repoAliases);

    if (!resolved) return undefined;

    // Unknown alias — inform the user
    if (resolved.unknownAlias) {
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⚠️ Repository alias not found:** \`@${resolved.alias}\`\n\n`);
      md.appendMarkdown(`_Add a \`resources.repositories\` entry with \`repository: ${resolved.alias}\` to enable cross-repo template resolution._`);
      return new vscode.Hover(md);
    }

    const { filePath, repoName } = resolved;

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
      if (repoName) {
        md.appendMarkdown(`\n\n_Make sure the \`${repoName}\` repository is cloned next to this workspace._`);
      }
      return new vscode.Hover(md);
    }

    const config = vscode.workspace.getConfiguration('azure-templates-navigator');
    const requiredColor = config.get('requiredParameterColor', '#c92d35');

    const params = parseParameters(text);
    const hoverMarkdown = buildHoverMarkdown(templateRef, params, requiredColor, repoName, filePath);

    // Provide a code lens range covering the whole "template:" token
    const templateKeyStart = line.indexOf('template:');
    const range = new vscode.Range(
      position.line, templateKeyStart,
      position.line, line.length
    );

    return new vscode.Hover(hoverMarkdown, range);
  }
};

/**
 * Definition provider: powers F12 / Cmd+Click / Ctrl+Click on a "template:" line.
 * Returns a Location pointing at the first character of the resolved template file.
 */
const definitionProvider = {
  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @returns {vscode.Location | undefined}
   */
  provideDefinition(document, position) {
    const line = document.lineAt(position).text;

    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(line);
    if (!match) return undefined;

    const templateRef = match[1].trim();
    const docText = document.getText();
    const repoAliases = parseRepositoryAliases(docText);
    const resolved = resolveTemplatePath(templateRef, document.uri.fsPath, repoAliases);

    if (!resolved || resolved.unknownAlias || !resolved.filePath) return undefined;

    const { filePath } = resolved;
    if (!fs.existsSync(filePath)) return undefined;

    const targetUri = vscode.Uri.file(filePath);
    return new vscode.Location(targetUri, new vscode.Position(0, 0));
  }
};

module.exports = {
  hoverProvider,
  definitionProvider,
  // Export internals for unit testing
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
  buildHoverMarkdown,
};
