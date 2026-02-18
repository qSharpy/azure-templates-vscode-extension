'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require('./hoverProvider');

/**
 * Represents a single node in the template dependency tree.
 */
class TemplateNode {
  /**
   * @param {object} opts
   * @param {string}      opts.label        Display label
   * @param {string|null} opts.filePath     Absolute path to the template file (null if unresolved)
   * @param {string|null} opts.templateRef  Raw template reference string (e.g. "templates/build.yml@alias")
   * @param {string|null} opts.repoName     External repo name, or null for local templates
   * @param {boolean}     opts.isRoot       True for the root pipeline file node
   * @param {boolean}     opts.notFound     True when the file could not be resolved/read
   * @param {boolean}     opts.unknownAlias True when the @alias is not in resources.repositories
   * @param {string|null} opts.alias        The alias string when unknownAlias is true
   * @param {number}      opts.paramCount   Number of parameters declared in the template
   * @param {number}      opts.requiredCount Number of required parameters
   */
  constructor({
    label,
    filePath = null,
    templateRef = null,
    repoName = null,
    isRoot = false,
    notFound = false,
    unknownAlias = false,
    alias = null,
    paramCount = 0,
    requiredCount = 0,
  }) {
    this.label = label;
    this.filePath = filePath;
    this.templateRef = templateRef;
    this.repoName = repoName;
    this.isRoot = isRoot;
    this.notFound = notFound;
    this.unknownAlias = unknownAlias;
    this.alias = alias;
    this.paramCount = paramCount;
    this.requiredCount = requiredCount;
  }
}

/**
 * Scans a YAML file for `- template:` references and returns an array of
 * TemplateNode objects representing each call site.
 *
 * @param {string} filePath      Absolute path of the file to scan
 * @param {Set<string>} visited  Set of already-visited file paths (cycle guard)
 * @returns {TemplateNode[]}
 */
function getTemplateChildren(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split('\n');
  const repoAliases = parseRepositoryAliases(text);
  const children = [];

  for (const line of lines) {
    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(line);
    if (!match) continue;

    const templateRef = match[1].trim();

    // Skip template expressions with variables — can't resolve at edit time
    if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) {
      children.push(new TemplateNode({
        label: templateRef,
        templateRef,
        notFound: true,
      }));
      continue;
    }

    const resolved = resolveTemplatePath(templateRef, filePath, repoAliases);

    if (!resolved) continue;

    if (resolved.unknownAlias) {
      children.push(new TemplateNode({
        label: `${templateRef}`,
        templateRef,
        unknownAlias: true,
        alias: resolved.alias,
      }));
      continue;
    }

    const { filePath: resolvedPath, repoName } = resolved;

    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      children.push(new TemplateNode({
        label: templateRef,
        templateRef,
        filePath: resolvedPath,
        repoName,
        notFound: true,
      }));
      continue;
    }

    // Parse parameters for the badge
    let paramCount = 0;
    let requiredCount = 0;
    try {
      const tplText = fs.readFileSync(resolvedPath, 'utf8');
      const params = parseParameters(tplText);
      paramCount = params.length;
      requiredCount = params.filter(p => p.required).length;
    } catch {
      // ignore
    }

    // Build a short display label
    const shortName = path.basename(resolvedPath);
    const label = repoName ? `${shortName} @${repoName}` : shortName;

    children.push(new TemplateNode({
      label,
      filePath: resolvedPath,
      templateRef,
      repoName,
      paramCount,
      requiredCount,
    }));
  }

  return children;
}

/**
 * VS Code TreeDataProvider for the Template Dependencies sidebar view.
 *
 * @implements {vscode.TreeDataProvider<TemplateNode>}
 */
class TemplateDependencyProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    /** @type {vscode.Event<TemplateNode | undefined>} */
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** @type {string|null} Active document file path */
    this._activeFile = null;
  }

  /**
   * Refreshes the tree, optionally for a specific file.
   * @param {string|null} filePath
   */
  refresh(filePath) {
    this._activeFile = filePath;
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @param {TemplateNode} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    const item = new vscode.TreeItem(
      node.label,
      node.isRoot
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    // ── Icon ──────────────────────────────────────────────────────────────
    if (node.isRoot) {
      item.iconPath = new vscode.ThemeIcon('file-code');
    } else if (node.unknownAlias) {
      item.iconPath = new vscode.ThemeIcon('question');
    } else if (node.notFound) {
      item.iconPath = new vscode.ThemeIcon('warning');
    } else if (node.repoName) {
      item.iconPath = new vscode.ThemeIcon('repo');
    } else {
      item.iconPath = new vscode.ThemeIcon('file-code');
    }

    // ── Tooltip ───────────────────────────────────────────────────────────
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;

    if (node.isRoot) {
      md.appendMarkdown(`**📄 Pipeline file**\n\n\`${node.filePath}\``);
    } else if (node.unknownAlias) {
      md.appendMarkdown(`**⚠️ Unknown alias:** \`@${node.alias}\`\n\n`);
      md.appendMarkdown(`Add a \`resources.repositories\` entry with \`repository: ${node.alias}\`.`);
    } else if (node.notFound) {
      md.appendMarkdown(`**⚠️ Template not found**\n\n\`${node.templateRef}\``);
      if (node.repoName) {
        md.appendMarkdown(`\n\n_Clone \`${node.repoName}\` next to this workspace._`);
      }
    } else {
      md.appendMarkdown(`**📄 Template:** \`${node.templateRef}\`\n\n`);
      if (node.repoName) {
        md.appendMarkdown(`**🔗 External repo:** \`${node.repoName}\`\n\n`);
      }
      md.appendMarkdown(`**File:** \`${node.filePath}\`\n\n`);
      if (node.paramCount > 0) {
        md.appendMarkdown(`**Parameters:** ${node.paramCount} total, ${node.requiredCount} required`);
      } else {
        md.appendMarkdown(`_No parameters_`);
      }
    }

    item.tooltip = md;

    // ── Description (shown dimmed after the label) ─────────────────────────
    if (!node.isRoot && !node.notFound && !node.unknownAlias) {
      const parts = [];
      if (node.paramCount > 0) {
        parts.push(`${node.paramCount} param${node.paramCount !== 1 ? 's' : ''}`);
      }
      if (node.requiredCount > 0) {
        parts.push(`${node.requiredCount} required`);
      }
      if (parts.length > 0) {
        item.description = parts.join(', ');
      }
    } else if (node.unknownAlias) {
      item.description = `unknown alias @${node.alias}`;
    } else if (node.notFound) {
      item.description = 'not found';
    }

    // ── Click command: open the file ──────────────────────────────────────
    if (node.filePath && !node.notFound) {
      item.command = {
        command: 'azure-templates-navigator.openTemplate',
        title: 'Open Template',
        arguments: [{ filePath: node.filePath, beside: false }],
      };
    }

    // ── Context value for future context-menu contributions ───────────────
    item.contextValue = node.isRoot ? 'pipelineRoot'
      : node.notFound ? 'templateNotFound'
      : node.unknownAlias ? 'templateUnknownAlias'
      : node.repoName ? 'templateExternal'
      : 'templateLocal';

    return item;
  }

  /**
   * @param {TemplateNode|undefined} node
   * @returns {TemplateNode[]}
   */
  getChildren(node) {
    // ── Root level: show the active pipeline file ─────────────────────────
    if (!node) {
      if (!this._activeFile) {
        return [];
      }
      const fileName = path.basename(this._activeFile);
      const root = new TemplateNode({
        label: fileName,
        filePath: this._activeFile,
        isRoot: true,
      });
      return [root];
    }

    // ── Root node: scan the pipeline file for template references ─────────
    if (node.isRoot && node.filePath) {
      return getTemplateChildren(node.filePath);
    }

    // ── Template node: scan the template file for nested template refs ─────
    if (node.filePath && !node.notFound && !node.unknownAlias) {
      return getTemplateChildren(node.filePath);
    }

    return [];
  }
}

/**
 * Registers the Template Dependencies tree view and wires up the active-editor
 * change listener to refresh it automatically.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {TemplateDependencyProvider}
 */
function createTreeViewProvider(context) {
  const provider = new TemplateDependencyProvider();

  const treeView = vscode.window.createTreeView(
    'azure-templates-navigator.templateTree',
    {
      treeDataProvider: provider,
      showCollapseAll: true,
    }
  );

  /**
   * Updates the tree for the given text editor (if it's a YAML file).
   * @param {vscode.TextEditor|undefined} editor
   */
  function updateForEditor(editor) {
    if (editor && editor.document.languageId === 'yaml') {
      provider.refresh(editor.document.uri.fsPath);
      treeView.title = `Templates: ${path.basename(editor.document.uri.fsPath)}`;
    } else {
      provider.refresh(null);
      treeView.title = 'Template Dependencies';
    }
  }

  // Refresh when the active editor changes
  const editorSub = vscode.window.onDidChangeActiveTextEditor(updateForEditor);
  context.subscriptions.push(editorSub);
  context.subscriptions.push(treeView);

  // Register a manual refresh command
  const refreshCmd = vscode.commands.registerCommand(
    'azure-templates-navigator.refreshTemplateTree',
    () => updateForEditor(vscode.window.activeTextEditor)
  );
  context.subscriptions.push(refreshCmd);

  // Initialize with the currently active editor
  updateForEditor(vscode.window.activeTextEditor);

  return provider;
}

module.exports = {
  createTreeViewProvider,
  TemplateDependencyProvider,
  TemplateNode,
  getTemplateChildren,
};
