'use strict';

const path = require('path');
const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

/**
 * Represents either a "file" group node or an individual "issue" leaf node
 * in the Diagnostics sidebar panel.
 *
 * @typedef {'file' | 'issue'} DiagNodeKind
 */

class DiagNode {
  /**
   * @param {object} opts
   * @param {DiagNodeKind}          opts.kind
   * @param {string}                opts.label
   * @param {string|null}           opts.fsPath      Absolute path (both kinds)
   * @param {vscode.Diagnostic|null} opts.diagnostic  Only for 'issue' nodes
   */
  constructor({ kind, label, fsPath = null, diagnostic = null }) {
    this.kind       = kind;
    this.label      = label;
    this.fsPath     = fsPath;
    this.diagnostic = diagnostic;
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

/**
 * VS Code TreeDataProvider for the "Template Diagnostics" sidebar panel.
 *
 * Displays all Azure Templates Navigator diagnostics grouped by file,
 * mirroring what appears in the VS Code Problems tab but scoped to this
 * extension and always visible in the sidebar.
 *
 * @implements {vscode.TreeDataProvider<DiagNode>}
 */
class DiagnosticsPanelProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    /** @type {vscode.Event<DiagNode | undefined>} */
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** @type {Map<string, vscode.Diagnostic[]>} fsPath → diagnostics */
    this._results = new Map();
  }

  /**
   * Updates the displayed results and refreshes the tree.
   * @param {Map<string, vscode.Diagnostic[]>} results
   */
  update(results) {
    this._results = results;
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider interface ─────────────────────────────────────────────

  /**
   * @param {DiagNode} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    if (node.kind === 'file') {
      return this._buildFileItem(node);
    }
    return this._buildIssueItem(node);
  }

  /**
   * @param {DiagNode|undefined} node
   * @returns {DiagNode[]}
   */
  getChildren(node) {
    // ── Root: return one file-group node per file that has diagnostics ──────
    if (!node) {
      if (this._results.size === 0) {
        return [];
      }

      // Sort: errors-first files, then alphabetically by basename
      const entries = [...this._results.entries()].filter(([, diags]) => diags.length > 0);
      entries.sort(([aPath, aDiags], [bPath, bDiags]) => {
        const aErrors = aDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        const bErrors = bDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        if (bErrors !== aErrors) return bErrors - aErrors;
        return path.basename(aPath).localeCompare(path.basename(bPath));
      });

      return entries.map(([fsPath, diags]) => {
        const errorCount   = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        const warningCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
        const parts = [];
        if (errorCount   > 0) parts.push(`${errorCount} error${errorCount   !== 1 ? 's' : ''}`);
        if (warningCount > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);
        const label = `${path.basename(fsPath)}  (${parts.join(', ')})`;
        return new DiagNode({ kind: 'file', label, fsPath });
      });
    }

    // ── File node: return its individual diagnostics as leaf nodes ───────────
    if (node.kind === 'file' && node.fsPath) {
      const diags = this._results.get(node.fsPath) || [];
      // Sort: errors before warnings, then by line number
      const sorted = [...diags].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity - b.severity;
        return a.range.start.line - b.range.start.line;
      });
      return sorted.map(d => {
        const line   = d.range.start.line + 1;
        const col    = d.range.start.character + 1;
        const prefix = d.severity === vscode.DiagnosticSeverity.Error ? '$(error)' : '$(warning)';
        const label  = `${prefix} [${line}:${col}] ${d.message}`;
        return new DiagNode({ kind: 'issue', label, fsPath: node.fsPath, diagnostic: d });
      });
    }

    return [];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Builds a TreeItem for a file-group node.
   * @param {DiagNode} node
   * @returns {vscode.TreeItem}
   */
  _buildFileItem(node) {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const diags        = this._results.get(node.fsPath) || [];
    const errorCount   = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warningCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;

    // Icon: error badge if any errors, else warning
    if (errorCount > 0) {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    } else if (warningCount > 0) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    }

    // Tooltip: full path
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**📄 File:** \`${node.fsPath}\`\n\n`);
    if (errorCount   > 0) md.appendMarkdown(`- 🔴 **${errorCount}** error${errorCount   !== 1 ? 's' : ''}\n`);
    if (warningCount > 0) md.appendMarkdown(`- 🟡 **${warningCount}** warning${warningCount !== 1 ? 's' : ''}\n`);
    item.tooltip = md;

    // Click: open the file
    item.command = {
      command: 'azure-templates-navigator.openTemplate',
      title: 'Open File',
      arguments: [{ filePath: node.fsPath, beside: false }],
    };

    item.contextValue = 'diagFile';
    return item;
  }

  /**
   * Builds a TreeItem for an individual issue leaf node.
   * @param {DiagNode} node
   * @returns {vscode.TreeItem}
   */
  _buildIssueItem(node) {
    const d    = node.diagnostic;
    const line = d.range.start.line + 1;
    const col  = d.range.start.character + 1;

    const isError = d.severity === vscode.DiagnosticSeverity.Error;

    // Use a plain label (no codicons in label — they go in the icon)
    const item = new vscode.TreeItem(
      `[${line}:${col}] ${d.message}`,
      vscode.TreeItemCollapsibleState.None
    );

    item.iconPath = isError
      ? new vscode.ThemeIcon('error',   new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));

    // Description: the diagnostic code (e.g. "missing-required-param")
    if (d.code) {
      item.description = String(d.code);
    }

    // Tooltip: full message + code
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**${isError ? '🔴 Error' : '🟡 Warning'}** — \`${d.code || ''}\`\n\n`);
    md.appendMarkdown(`${d.message}\n\n`);
    md.appendMarkdown(`_Line ${line}, column ${col}_`);
    item.tooltip = md;

    // Click: open the file and jump to the exact line
    item.command = {
      command: 'azure-templates-navigator.openDiagnosticLocation',
      title: 'Go to Issue',
      arguments: [{ filePath: node.fsPath, line: d.range.start.line, character: d.range.start.character }],
    };

    item.contextValue = isError ? 'diagError' : 'diagWarning';
    return item;
  }
}

// ---------------------------------------------------------------------------
// Factory / registration
// ---------------------------------------------------------------------------

/**
 * Creates and registers the "Template Diagnostics" sidebar panel.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {DiagnosticsPanelProvider}
 */
function createDiagnosticsPanelProvider(context) {
  const provider = new DiagnosticsPanelProvider();

  const treeView = vscode.window.createTreeView(
    'azure-templates-navigator.diagnosticsPanel',
    {
      treeDataProvider: provider,
      showCollapseAll: true,
    }
  );

  // Keep the view title badge in sync with the total issue count
  function updateBadge(results) {
    let errors   = 0;
    let warnings = 0;
    for (const diags of results.values()) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error)   errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
    }
    const total = errors + warnings;
    treeView.badge = total > 0
      ? { value: total, tooltip: `${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}` }
      : undefined;
  }

  // Wrap update so we also refresh the badge
  const originalUpdate = provider.update.bind(provider);
  provider.update = (results) => {
    originalUpdate(results);
    updateBadge(results);
  };

  // ── Command: navigate to the exact location of a diagnostic ───────────────
  const goToCmd = vscode.commands.registerCommand(
    'azure-templates-navigator.openDiagnosticLocation',
    async ({ filePath, line, character } = {}) => {
      if (!filePath) return;
      const uri = vscode.Uri.file(filePath);
      const pos = new vscode.Position(line, character);
      await vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(pos, pos),
        preserveFocus: false,
      });
    }
  );

  context.subscriptions.push(treeView, goToCmd);

  return provider;
}

module.exports = {
  createDiagnosticsPanelProvider,
  DiagnosticsPanelProvider,
  DiagNode,
};
