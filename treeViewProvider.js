'use strict';

const fs        = require('fs');
const path      = require('path');
const vscode    = require('vscode');
const fileCache = require('./fileCache');
const { workspaceIndex } = require('./workspaceIndex');
const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require('./hoverProvider');
const {
  collectYamlFiles,
  extractTemplateRefs,
} = require('./graphDataBuilder');
const { FuzzySearch } = require('./fuzzySearch');

// ─────────────────────────────────────────────────────────────────────────────
// Node model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every node in the Dependencies tree.
 *
 * kind values:
 *   'section'   — "Called by" or "Is calling" section header
 *   'file'      — a real YAML file node (upstream or downstream)
 *   'notFound'  — unresolvable template reference
 *   'cycle'     — cycle sentinel
 */
class DepNode {
  constructor({
    kind,
    label,
    relativePath = null,
    filePath = null,
    templateRef = null,
    repoName = null,
    isCycle = false,
    notFound = false,
    unknownAlias = false,
    alias = null,
    paramCount = 0,
    requiredCount = 0,
    hasChildren = false,
    // section-specific
    sectionType = null,   // 'calledBy' | 'isCalling'
    childNodes = null,    // pre-computed children (sections only)
    // upstream chain children (for trie nodes)
    upstreamChildren = null,
    // severity for root node coloring
    severity = null,
  }) {
    this.kind = kind;
    this.label = label;
    this.relativePath = relativePath;
    this.filePath = filePath;
    this.templateRef = templateRef;
    this.repoName = repoName;
    this.isCycle = isCycle;
    this.notFound = notFound;
    this.unknownAlias = unknownAlias;
    this.alias = alias;
    this.paramCount = paramCount;
    this.requiredCount = requiredCount;
    this.hasChildren = hasChildren;
    this.sectionType = sectionType;
    this.childNodes = childNodes;
    this.upstreamChildren = upstreamChildren;
    this.severity = severity;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream tree builder — index-based (replaces findChain / trie approach)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts the raw node objects returned by workspaceIndex.buildUpstreamTree()
 * into proper DepNode instances (with severity, icons, etc.).
 *
 * @param {object[]} rawNodes
 * @returns {DepNode[]}
 */
function _rawNodesToDepNodes(rawNodes) {
  return rawNodes.map(n => {
    const childNodes = n.childNodes && n.childNodes.length > 0
      ? _rawNodesToDepNodes(n.childNodes)
      : [];
    return new DepNode({
      kind: 'file',
      label: n.label,
      relativePath: n.relativePath,
      filePath: n.filePath,
      paramCount: n.paramCount,
      requiredCount: n.requiredCount,
      hasChildren: childNodes.length > 0,
      childNodes,
    });
  });
}

/**
 * Builds the "Called by" upstream tree for `targetFile`.
 *
 * Uses the WorkspaceIndex (pre-computed reverse adjacency map) when ready,
 * falling back to a lightweight direct-callers-only scan when the index is
 * not yet available (e.g. immediately after activation).
 *
 * @param {string} targetFile
 * @param {string} workspaceRoot
 * @returns {{ nodes: DepNode[], directCallerCount: number }}
 */
function buildUpstreamTree(targetFile, workspaceRoot) {
  if (workspaceIndex.isReady()) {
    // Fast path: O(callers) BFS over in-memory maps
    const { nodes: rawNodes, directCallerCount } =
      workspaceIndex.buildUpstreamTree(targetFile, workspaceRoot);
    const nodes = _rawNodesToDepNodes(rawNodes);
    return { nodes, directCallerCount };
  }

  // Fallback (index not yet built): show only direct callers, no deep chain.
  // This is fast (single pass over cached file contents) and avoids blocking.
  const allYaml = collectYamlFiles(workspaceRoot);
  const directCallerNodes = [];
  for (const yamlFile of allYaml) {
    if (yamlFile === targetFile) continue;
    const text = fileCache.readFile(yamlFile);
    if (!text) continue;
    const aliases = parseRepositoryAliases(text);
    const refs = extractTemplateRefs(yamlFile);
    for (const { templateRef } of refs) {
      if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) continue;
      const resolved = resolveTemplatePath(templateRef, yamlFile, aliases);
      if (resolved && resolved.filePath === targetFile) {
        const rel = path.relative(workspaceRoot, yamlFile).replace(/\\/g, '/');
        directCallerNodes.push(new DepNode({
          kind: 'file',
          label: path.basename(yamlFile),
          relativePath: rel,
          filePath: yamlFile,
          hasChildren: false,
          childNodes: [],
        }));
        break;
      }
    }
  }
  return { nodes: directCallerNodes, directCallerCount: directCallerNodes.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Downstream tree builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively builds the "Is calling" downstream tree for `filePath`.
 *
 * @param {string}      filePath
 * @param {Set<string>} visited        Cycle guard (absolute paths already in chain)
 * @param {string|null} workspaceRoot
 * @returns {DepNode[]}
 */
function buildDownstreamNodes(filePath, visited = new Set(), workspaceRoot = null) {
  const text = fileCache.readFile(filePath);
  if (!text) return [];

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const repoAliases = parseRepositoryAliases(text);
  const children = [];

  for (const line of lines) {
    const stripped = line.replace(/(^\s*#.*|\s#.*)$/, '');
    const match = /(?:^|\s)-?\s*template\s*:\s*(.+)$/.exec(stripped);
    if (!match) continue;

    const templateRef = match[1].trim();

    if (/\$\{/.test(templateRef) || /\$\(/.test(templateRef)) {
      children.push(new DepNode({ kind: 'notFound', label: templateRef, templateRef, notFound: true }));
      continue;
    }

    const resolved = resolveTemplatePath(templateRef, filePath, repoAliases);
    if (!resolved) continue;

    if (resolved.unknownAlias) {
      children.push(new DepNode({
        kind: 'notFound',
        label: templateRef,
        templateRef,
        unknownAlias: true,
        alias: resolved.alias,
      }));
      continue;
    }

    const { filePath: resolvedPath, repoName } = resolved;

    if (!resolvedPath || !fileCache.fileExists(resolvedPath)) {
      children.push(new DepNode({
        kind: 'notFound',
        label: templateRef,
        templateRef,
        filePath: resolvedPath,
        repoName,
        notFound: true,
      }));
      continue;
    }

    // Cycle detection
    if (visited.has(resolvedPath)) {
      const shortName = path.basename(resolvedPath);
      children.push(new DepNode({
        kind: 'cycle',
        label: repoName ? `${shortName} @${repoName}` : shortName,
        relativePath: workspaceRoot ? path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/') : null,
        filePath: resolvedPath,
        templateRef,
        repoName,
        isCycle: true,
      }));
      continue;
    }

    let paramCount = 0;
    let requiredCount = 0;
    let hasChildren = false;
    const tplText = fileCache.readFile(resolvedPath);
    if (tplText) {
      const params = parseParameters(tplText);
      paramCount = params.length;
      requiredCount = params.filter(p => p.required).length;
      const templateLineRe = /(?:^|\s)-?\s*template\s*:\s*(.+)$/;
      hasChildren = tplText.replace(/\r\n/g, '\n').split('\n').some(
        l => templateLineRe.test(l.replace(/(^\s*#.*|\s#.*)$/, ''))
      );
    }

    const shortName = path.basename(resolvedPath);
    const label = repoName ? `${shortName} @${repoName}` : shortName;
    const rel = workspaceRoot ? path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/') : null;

    // Build children recursively
    const newVisited = new Set(visited);
    newVisited.add(resolvedPath);
    const childNodes = hasChildren
      ? buildDownstreamNodes(resolvedPath, newVisited, workspaceRoot)
      : [];

    children.push(new DepNode({
      kind: 'file',
      label,
      relativePath: rel,
      filePath: resolvedPath,
      templateRef,
      repoName,
      paramCount,
      requiredCount,
      hasChildren: childNodes.length > 0,
      childNodes,
    }));
  }

  return children;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy search index builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a FuzzySearch index from all YAML files in the workspace.
 *
 * @param {string} workspaceRoot
 * @returns {FuzzySearch}
 */
function buildSearchIndex(workspaceRoot) {
  const engine = new FuzzySearch();
  const yamlFiles = collectYamlFiles(workspaceRoot);

  const entries = yamlFiles.map(filePath => {
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    const filename = path.basename(filePath);
    const directory = path.dirname(relativePath).replace(/\\/g, '/');
    return { filePath, filename, relativePath, directory };
  });

  engine.buildIndex(entries);
  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree data provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VS Code TreeDataProvider for the "Dependencies" sidebar panel.
 *
 * @implements {vscode.TreeDataProvider<DepNode>}
 */
class DependenciesProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    /** @type {vscode.Event<DepNode | undefined>} */
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** @type {string|null} */
    this._activeFile = null;

    /** @type {boolean} Show workspace-relative paths instead of basenames */
    this.showFullPath = false;

    /** @type {boolean} Expand/collapse all toggle state */
    this.allExpanded = true;

    /** @type {boolean} When true, only error nodes are highlighted (warnings shown plain) */
    this.errorsOnly = false;

    /**
     * Diagnostics map: absolute fsPath → vscode.Diagnostic[]
     * Injected from extension.js via setDiagnostics().
     * @type {Map<string, vscode.Diagnostic[]>}
     */
    this._diagnostics = new Map();

    /** @type {vscode.TreeView<DepNode>|null} */
    this._treeView = null;

    /** @type {DepNode[]} Cached root section nodes for expand-all */
    this._rootNodes = [];

    /**
     * Fuzzy search engine — rebuilt lazily when the search command is invoked.
     * @type {FuzzySearch|null}
     */
    this._searchEngine = null;

    /**
     * Timestamp of the last index build (ms). Used to avoid rebuilding too often.
     * @type {number}
     */
    this._searchIndexBuiltAt = 0;
  }

  /** @param {vscode.TreeView<DepNode>} treeView */
  setTreeView(treeView) {
    this._treeView = treeView;
  }

  /**
   * Returns a (possibly cached) FuzzySearch engine for the current workspace.
   * Rebuilds the index if it is older than 30 seconds or has never been built.
   * @returns {FuzzySearch|null}
   */
  getOrBuildSearchEngine() {
    const wf = vscode.workspace.workspaceFolders;
    if (!wf || wf.length === 0) return null;
    const workspaceRoot = wf[0].uri.fsPath;

    const now = Date.now();
    const stale = now - this._searchIndexBuiltAt > 30000;

    if (!this._searchEngine || stale) {
      this._searchEngine = buildSearchIndex(workspaceRoot);
      this._searchIndexBuiltAt = now;
    }

    return this._searchEngine;
  }

  /**
   * Invalidates the search index so it will be rebuilt on next search.
   */
  invalidateSearchIndex() {
    this._searchIndexBuiltAt = 0;
  }

  /**
   * Called by extension.js whenever diagnostics are updated.
   * @param {Map<string, vscode.Diagnostic[]>} diagMap
   */
  setDiagnostics(diagMap) {
    this._diagnostics = diagMap || new Map();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Refreshes the tree for the given file path (or clears it if null).
   * @param {string|null} filePath
   */
  refresh(filePath) {
    this._activeFile = filePath;
    this._onDidChangeTreeData.fire(undefined);
  }

  toggleFullPath() {
    this.showFullPath = !this.showFullPath;
    this._onDidChangeTreeData.fire(undefined);
  }

  toggleErrorsOnly() {
    this.errorsOnly = !this.errorsOnly;
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── Severity helpers ───────────────────────────────────────────────────────

  /**
   * Returns 'error', 'warning', or null for a given absolute file path.
   * @param {string|null} filePath
   * @returns {'error'|'warning'|null}
   */
  _severity(filePath) {
    if (!filePath) return null;
    const diags = this._diagnostics.get(filePath);
    if (!diags || diags.length === 0) return null;
    const hasError = diags.some(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (hasError) return 'error';
    return 'warning';
  }

  // ── TreeDataProvider ───────────────────────────────────────────────────────

  /** @param {DepNode} node */
  getTreeItem(node) {
    // ── Section header ─────────────────────────────────────────────────────
    if (node.kind === 'section') {
      return this._buildSectionItem(node);
    }

    // ── Cycle node ─────────────────────────────────────────────────────────
    if (node.kind === 'cycle') {
      return this._buildCycleItem(node);
    }

    // ── Not-found / unknown-alias node ─────────────────────────────────────
    if (node.kind === 'notFound') {
      return this._buildNotFoundItem(node);
    }

    // ── Regular file node ──────────────────────────────────────────────────
    return this._buildFileItem(node);
  }

  /** @param {DepNode|undefined} node */
  getChildren(node) {
    // Root level: two section nodes
    if (!node) {
      if (!this._activeFile) {
        this._rootNodes = [];
        return [];
      }

      const workspaceRoot = this._getWorkspaceRoot(this._activeFile);

      // ── "Called by" section ──────────────────────────────────────────────
      const { nodes: upstreamNodes, directCallerCount } = buildUpstreamTree(this._activeFile, workspaceRoot);
      this._setParents(upstreamNodes, null); // parent set below after section created
      const calledBySection = new DepNode({
        kind: 'section',
        label: 'Called by',
        sectionType: 'calledBy',
        childNodes: upstreamNodes,
        paramCount: directCallerCount,
      });
      for (const child of upstreamNodes) child._parent = calledBySection;

      // ── "Is calling" section ─────────────────────────────────────────────
      const visited = new Set([this._activeFile]);
      const downstreamNodes = buildDownstreamNodes(this._activeFile, visited, workspaceRoot);
      this._setParents(downstreamNodes, null);
      const isCallingSection = new DepNode({
        kind: 'section',
        label: 'Is calling',
        sectionType: 'isCalling',
        childNodes: downstreamNodes,
        paramCount: downstreamNodes.length,
      });
      for (const child of downstreamNodes) child._parent = isCallingSection;

      calledBySection._parent = null;
      isCallingSection._parent = null;

      this._rootNodes = [calledBySection, isCallingSection];
      return this._rootNodes;
    }

    // Section node: return pre-computed children
    if (node.kind === 'section') {
      return node.childNodes || [];
    }

    // File node: return pre-computed children (already built recursively)
    if (node.kind === 'file') {
      return node.childNodes || [];
    }

    return [];
  }

  /**
   * Required by VS Code for treeView.reveal() to work.
   * @param {DepNode} node
   * @returns {DepNode|null}
   */
  getParent(node) {
    return node._parent || null;
  }

  /**
   * Recursively sets _parent on all child nodes.
   * @param {DepNode[]} nodes
   * @param {DepNode|null} parent
   */
  _setParents(nodes, parent) {
    for (const n of nodes) {
      n._parent = parent;
      if (n.childNodes && n.childNodes.length > 0) {
        this._setParents(n.childNodes, n);
      }
    }
  }

  // ── Private item builders ──────────────────────────────────────────────────

  _buildSectionItem(node) {
    const count = node.paramCount || 0; // reused field for count
    const collapsible = count > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, collapsible);

    if (node.sectionType === 'calledBy') {
      item.iconPath = new vscode.ThemeIcon('arrow-up');
      item.description = count === 0
        ? 'no callers'
        : `${count} caller${count !== 1 ? 's' : ''}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⬆ Called by**\n\nPipelines that transitively depend on the current file.\n\nThe tree is shown root-first; shared branches are merged.`);
      item.tooltip = md;
    } else {
      item.iconPath = new vscode.ThemeIcon('arrow-down');
      item.description = count === 0
        ? 'no templates'
        : `${count} template${count !== 1 ? 's' : ''}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⬇ Is calling**\n\nTemplates this file references, recursively.\n\nCycles are shown with a ↩ label instead of being expanded.`);
      item.tooltip = md;
    }

    item.contextValue = 'depSection';
    return item;
  }

  _buildCycleItem(node) {
    const displayLabel = this.showFullPath && node.relativePath
      ? `${node.relativePath} (cycle)`
      : `${node.label} (cycle)`;

    const item = new vscode.TreeItem(displayLabel, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('issues', new vscode.ThemeColor('list.warningForeground'));
    item.description = '↩ circular';

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**🔄 Circular reference detected**\n\n`);
    md.appendMarkdown(`\`${node.templateRef}\` is already in the current dependency chain.\n\n`);
    md.appendMarkdown(`_Expanding this node would cause infinite recursion._`);
    item.tooltip = md;

    item.contextValue = 'depCycle';
    return item;
  }

  _buildNotFoundItem(node) {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);

    if (node.unknownAlias) {
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('list.warningForeground'));
      item.description = `unknown alias @${node.alias}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⚠️ Unknown alias:** \`@${node.alias}\`\n\n`);
      md.appendMarkdown(`Add a \`resources.repositories\` entry with \`repository: ${node.alias}\`.`);
      item.tooltip = md;
    } else {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground'));
      item.description = 'not found';
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**⚠️ Template not found**\n\n\`${node.templateRef}\``);
      if (node.repoName) {
        md.appendMarkdown(`\n\n_Clone \`${node.repoName}\` next to this workspace._`);
      }
      item.tooltip = md;
    }

    item.contextValue = 'depNotFound';
    return item;
  }

  _buildFileItem(node) {
    const severity = this._severity(node.filePath);

    // Collapsible state
    const hasKids = (node.childNodes && node.childNodes.length > 0);
    const collapsible = hasKids
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

    // Display label
    const baseLabel = this.showFullPath && node.relativePath
      ? node.relativePath
      : node.label;

    const item = new vscode.TreeItem(baseLabel, collapsible);

    // Icon — use YAML file icon always; colour it by severity
    if (severity === 'error') {
      item.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('list.errorForeground'));
    } else if (severity === 'warning' && !this.errorsOnly) {
      item.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('list.warningForeground'));
    } else if (node.repoName) {
      item.iconPath = new vscode.ThemeIcon('repo');
    } else {
      item.iconPath = new vscode.ThemeIcon('file-code');
    }

    // Click: open the file
    if (node.filePath) {
      item.command = {
        command: 'azure-templates-navigator.openTemplate',
        title: 'Open File',
        arguments: [{ filePath: node.filePath, beside: false }],
      };
    }

    // Context value — used by menus
    item.contextValue = node.repoName ? 'depFileExternal' : 'depFileLocal';

    return item;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _getWorkspaceRoot(filePath) {
    const wf = vscode.workspace.workspaceFolders;
    return (wf && wf.length > 0) ? wf[0].uri.fsPath : path.dirname(filePath);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers the Dependencies tree view and all its commands.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {DependenciesProvider}
 */
function createTreeViewProvider(context) {
  const provider = new DependenciesProvider();

  const treeView = vscode.window.createTreeView(
    'azure-templates-navigator.templateTree',
    {
      treeDataProvider: provider,
      showCollapseAll: false, // we manage expand/collapse ourselves
    }
  );
  provider.setTreeView(treeView);

  // ── Active editor listener ─────────────────────────────────────────────────

  function _relPath(filePath) {
    const wf = vscode.workspace.workspaceFolders;
    if (!wf || wf.length === 0) return path.basename(filePath);
    return path.relative(wf[0].uri.fsPath, filePath).replace(/\\/g, '/');
  }

  /** Builds the tree view title: filename (or rel-path) with a severity prefix emoji. */
  function _titleForFile(filePath) {
    const label = provider.showFullPath ? _relPath(filePath) : path.basename(filePath);
    const severity = provider._severity(filePath);
    if (severity === 'error') return `⛔ ${label}`;
    if (severity === 'warning' && !provider.errorsOnly) return `⚠️ ${label}`;
    return label;
  }

  function updateForEditor(editor) {
    if (editor && editor.document.languageId === 'yaml') {
      provider.refresh(editor.document.uri.fsPath);
      treeView.title = _titleForFile(editor.document.uri.fsPath);
    } else {
      provider.refresh(null);
      treeView.title = 'Dependencies';
    }
  }

  // Re-apply the title whenever diagnostics change (severity may have changed)
  const _origSetDiagnostics = provider.setDiagnostics.bind(provider);
  provider.setDiagnostics = (diagMap) => {
    _origSetDiagnostics(diagMap);
    if (provider._activeFile) {
      treeView.title = _titleForFile(provider._activeFile);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateForEditor),
    treeView
  );

  // ── Commands ───────────────────────────────────────────────────────────────

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.refreshTemplateTree',
      () => updateForEditor(vscode.window.activeTextEditor)
    )
  );

  // Toggle full path
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.toggleFullPathTree',
      () => {
        provider.toggleFullPath();
        // Also update the header title to reflect full/short path
        if (provider._activeFile) {
          treeView.title = _titleForFile(provider._activeFile);
        }
      }
    )
  );

  // Expand / Collapse All toggle
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.expandCollapseAll',
      async () => {
        provider.allExpanded = !provider.allExpanded;
        if (provider.allExpanded) {
          // Force a full rebuild so we get fresh node objects, then reveal
          // each root section with expand:3 to recursively expand the tree.
          provider.refresh(provider._activeFile);
          // Small delay to let the tree render the new nodes
          await new Promise(r => setTimeout(r, 100));
          for (const root of (provider._rootNodes || [])) {
            try {
              await treeView.reveal(root, { expand: 3, select: false, focus: false });
            } catch { /* node may not be visible */ }
          }
        } else {
          await vscode.commands.executeCommand(
            'workbench.actions.treeView.azure-templates-navigator.templateTree.collapseAll'
          );
        }
      }
    )
  );

  // Errors Only toggle
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.toggleErrorsOnly',
      () => {
        provider.toggleErrorsOnly();
      }
    )
  );

  // Copy current file path to clipboard (with brief checkmark feedback via title)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.copyCurrentFilePath',
      async () => {
        if (!provider._activeFile) return;
        const wf = vscode.workspace.workspaceFolders;
        const relPath = wf && wf.length > 0
          ? path.relative(wf[0].uri.fsPath, provider._activeFile).replace(/\\/g, '/')
          : provider._activeFile;
        await vscode.env.clipboard.writeText(relPath);
        // Brief visual feedback: swap title to checkmark for 500 ms
        const prevTitle = treeView.title;
        treeView.title = '✔ Copied!';
        setTimeout(() => { treeView.title = prevTitle; }, 500);
      }
    )
  );

  // Context menu: Open to Side
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.openTemplateBeside',
      (node) => {
        if (node && node.filePath) {
          vscode.commands.executeCommand(
            'azure-templates-navigator.openTemplate',
            { filePath: node.filePath, beside: true }
          );
        }
      }
    )
  );

  // Context menu: Copy Template Path
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.copyTemplatePath',
      (node) => {
        if (node && node.templateRef) {
          vscode.env.clipboard.writeText(node.templateRef).then(() => {
            vscode.window.showInformationMessage(`Copied: ${node.templateRef}`);
          });
        } else if (node && node.filePath) {
          vscode.env.clipboard.writeText(node.filePath).then(() => {
            vscode.window.showInformationMessage(`Copied: ${node.filePath}`);
          });
        }
      }
    )
  );

  // ── Fuzzy search command ───────────────────────────────────────────────────
  // Opens a QuickPick popup with debounced fuzzy search over all indexed YAML files.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.searchDependencyTree',
      async () => {
        const engine = provider.getOrBuildSearchEngine();
        if (!engine) {
          vscode.window.showWarningMessage('Azure Templates Navigator: No workspace folder open.');
          return;
        }

        const qp = vscode.window.createQuickPick();
        qp.placeholder = `Search ${engine.size} indexed templates… (typos OK)`;
        qp.matchOnDescription = false;
        qp.matchOnDetail = false;

        /** @type {NodeJS.Timeout|null} */
        let debounceTimer = null;

        qp.onDidChangeValue(value => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const results = engine.search(value, 20);
            qp.items = results.map(({ entry }) => ({
              label: entry.filename,
              description: entry.directory !== '.' ? entry.directory : '',
              detail: undefined,
              // Stash the full path for use on accept
              _filePath: entry.filePath,
            }));
          }, 150);
        });

        qp.onDidAccept(() => {
          const selected = qp.selectedItems[0];
          if (selected && selected._filePath) {
            qp.hide();
            vscode.commands.executeCommand(
              'azure-templates-navigator.openTemplate',
              { filePath: selected._filePath, beside: false }
            );
          }
        });

        qp.onDidHide(() => {
          if (debounceTimer) clearTimeout(debounceTimer);
          qp.dispose();
        });

        qp.show();
      }
    )
  );

  // Seed with the currently active editor
  updateForEditor(vscode.window.activeTextEditor);

  return provider;
}

module.exports = {
  createTreeViewProvider,
  DependenciesProvider,
  DepNode,
  buildDownstreamNodes,
};
