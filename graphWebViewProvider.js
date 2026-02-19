'use strict';

const vscode = require('vscode');
const {
  buildWorkspaceGraph,
  buildFileGraph,
} = require('./graphDataBuilder');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {string} */
const GRAPH_VIEW_ID = 'azure-templates-navigator.graphView';

// ---------------------------------------------------------------------------
// WebView provider
// ---------------------------------------------------------------------------

/**
 * VS Code WebviewViewProvider for the Template Graph sidebar panel.
 *
 * @implements {vscode.WebviewViewProvider}
 */
class TemplateGraphProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._context = context;
    /** @type {vscode.WebviewView|null} */
    this._view = null;
    /**
     * In-memory override of the root path for the current session.
     * When null the VS Code workspace setting is used instead.
     * @type {string|null}
     */
    this._rootPathOverride = null;
    /**
     * Absolute path of the currently active YAML file.
     * When set (and _fileScopeEnabled is true), the graph is scoped to that
     * file's direct template references only.
     * @type {string|null}
     */
    this._activeFile = null;
    /**
     * Whether the "scope to current file" mode is enabled.
     * Defaults to true so the graph automatically scopes to the open file.
     * @type {boolean}
     */
    this._fileScopeEnabled = true;
  }

  /**
   * Called by VS Code when the view becomes visible.
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, { isPanel: false });

    // Handle messages from the WebView
    webviewView.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg, webviewView.webview),
      undefined,
      this._context.subscriptions
    );

    // Send initial graph data once the view is ready
    setTimeout(() => this._sendGraphData(webviewView.webview), 300);
  }

  /**
   * Rebuilds the graph data and posts it to the sidebar WebView.
   */
  refresh() {
    if (this._view) {
      this._sendGraphData(this._view.webview);
    }
  }

  /**
   * Called when the active text editor changes.
   * Updates the active file and refreshes the graph if file-scope mode is on.
   * @param {vscode.TextEditor|undefined} editor
   */
  onActiveEditorChanged(editor) {
    const newFile = (editor && editor.document.languageId === 'yaml')
      ? editor.document.uri.fsPath
      : null;

    const changed = newFile !== this._activeFile;
    this._activeFile = newFile;

    if (changed && this._fileScopeEnabled && this._view) {
      this._sendGraphData(this._view.webview);
    }
  }

  /**
   * Opens the graph in a full-width editor panel.
   */
  openPanel() {
    const panel = vscode.window.createWebviewPanel(
      'azure-templates-navigator.graphPanel',
      'Template Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._context.extensionUri, 'media'),
        ],
      }
    );

    panel.webview.html = this._getHtmlForWebview(panel.webview, { isPanel: true });

    panel.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg, panel.webview),
      undefined,
      this._context.subscriptions
    );

    // Send data once the panel WebView signals ready
    // (the 'ready' message will trigger _sendGraphData via _handleMessage)
  }

  /**
   * @private
   * @param {{ type: string, filePath?: string, text?: string, rootPath?: string }} msg
   * @param {vscode.Webview} webview  – the webview that sent the message
   */
  _handleMessage(msg, webview) {
    switch (msg.type) {
      case 'setFileScope': {
        // Toggle file-scope mode on/off from the WebView toolbar button.
        this._fileScopeEnabled = !!msg.enabled;
        this._sendGraphData(webview);
        break;
      }

      case 'openFile':
        if (msg.filePath) {
          vscode.commands.executeCommand(
            'azure-templates-navigator.openTemplate',
            { filePath: msg.filePath, beside: false }
          );
        }
        break;

      case 'openFileBeside':
        if (msg.filePath) {
          vscode.commands.executeCommand(
            'azure-templates-navigator.openTemplate',
            { filePath: msg.filePath, beside: true }
          );
        }
        break;

      case 'copyPath':
        if (msg.text) {
          vscode.env.clipboard.writeText(msg.text).then(() => {
            vscode.window.showInformationMessage(`Copied: ${msg.text}`);
          });
        }
        break;

      case 'expand':
        // Open the graph in a full editor panel
        this.openPanel();
        break;

      case 'ready':
        // WebView signals it has finished initialising — send data now
        this._sendGraphData(webview);
        break;

      case 'setRootPath': {
        // The user typed a new path in the toolbar input.
        // 1. Keep an in-memory override for the current session.
        this._rootPathOverride = (msg.rootPath || '').trim();

        // 2. Persist to the workspace-scoped VS Code setting so it survives
        //    reloads and is per-repo (workspace scope).
        const config = vscode.workspace.getConfiguration('azure-templates-navigator');
        config.update('graph.rootPath', this._rootPathOverride, vscode.ConfigurationTarget.Workspace)
          .then(undefined, () => {
            // Workspace settings may not be writable in some environments
            // (e.g. no .vscode/settings.json yet) — silently ignore.
          });

        // 3. Rebuild and push new graph data immediately.
        this._sendGraphData(webview);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Returns the effective root-path sub-directory to scan.
   * Priority: in-memory override → workspace setting → '' (full workspace).
   * @private
   * @returns {string}
   */
  _getEffectiveRootPath() {
    if (this._rootPathOverride !== null) {
      return this._rootPathOverride;
    }
    const config = vscode.workspace.getConfiguration('azure-templates-navigator');
    return (config.get('graph.rootPath') || '').trim();
  }

  /**
   * @private
   * @param {vscode.Webview} webview
   */
  _sendGraphData(webview) {
    if (!webview) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      webview.postMessage({ type: 'noWorkspace' });
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // ── File-scope mode: show only the active file + its direct children ────
    if (this._fileScopeEnabled && this._activeFile) {
      try {
        const { nodes, edges } = buildFileGraph(this._activeFile, workspaceRoot);
        webview.postMessage({
          type: 'graphData',
          nodes,
          edges,
          rootPath: '',
          fileScopeEnabled: true,
          scopedFile: this._activeFile,
        });
      } catch (err) {
        webview.postMessage({
          type: 'error',
          message: err.message || String(err),
        });
      }
      return;
    }

    // ── Workspace / path-scoped mode ─────────────────────────────────────────
    const subPath = this._getEffectiveRootPath();

    try {
      const { nodes, edges } = buildWorkspaceGraph(workspaceRoot, subPath);
      webview.postMessage({
        type: 'graphData',
        nodes,
        edges,
        rootPath: subPath,
        fileScopeEnabled: false,
        scopedFile: null,
      });
    } catch (err) {
      webview.postMessage({
        type: 'error',
        message: err.message || String(err),
      });
    }
  }

  /**
   * Returns the HTML content for the WebView, with a nonce-based CSP.
   * @param {vscode.Webview} webview
   * @param {{ isPanel: boolean }} options
   * @returns {string}
   * @private
   */
  _getHtmlForWebview(webview, { isPanel = false } = {}) {
    const nonce = getNonce();

    const d3Uri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'd3.min.js')
    );
    const graphUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'graph.js')
    );

    // In the full panel the "Expand" button is hidden (already expanded)
    const expandBtnStyle = isPanel ? 'display:none' : '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src 'unsafe-inline';
                 img-src ${webview.cspSource} data:;">
  <title>Template Graph</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Toolbar row 1: action buttons ──────────────────────────────────── */
    #toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    #toolbar button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      padding: 2px 7px;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* Path toggle button — highlights when a path is active */
    #btn-toggle-path {
      position: relative;
    }
    #btn-toggle-path.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #btn-toggle-path.active:hover {
      background: var(--vscode-button-hoverBackground);
    }
    /* Small dot indicator when path is set */
    #btn-toggle-path .path-dot {
      display: none;
      position: absolute;
      top: 2px;
      right: 2px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--vscode-notificationsInfoIcon-foreground, #4e9de0);
    }
    #btn-toggle-path.has-path .path-dot {
      display: block;
    }

    /* File-scope toggle button — highlights when file scope is active */
    #btn-file-scope.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #btn-file-scope.active:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #btn-file-scope:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    #stats {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      margin-left: auto;  /* pushes stats + expand to the right */
    }

    #btn-expand {
      flex-shrink: 0;
    }

    /* ── Toolbar row 2: filter (always visible, prominent) ───────────────── */
    #filter-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    #filter-bar label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
      user-select: none;
    }

    #search {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    #search:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    #search::placeholder { color: var(--vscode-input-placeholderForeground); }

    #btn-clear-search {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-radius: 3px;
      padding: 2px 5px;
      cursor: pointer;
      font-size: 12px;
      flex-shrink: 0;
      line-height: 1;
      display: none;
    }
    #btn-clear-search:hover {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #btn-clear-search.visible { display: block; }

    /* ── Path bar (collapsible, hidden by default) ───────────────────────── */
    #path-bar {
      display: none;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #path-bar.open {
      display: flex;
    }

    #root-path-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
    }

    #root-path {
      flex: 1;
      min-width: 60px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 3px 7px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      outline: none;
      transition: border-color 0.15s;
    }
    #root-path:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    #root-path::placeholder { color: var(--vscode-input-placeholderForeground); }
    #root-path.has-value {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    #btn-apply-path {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #btn-apply-path:hover {
      background: var(--vscode-button-hoverBackground);
    }

    #btn-clear-path {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-radius: 3px;
      padding: 2px 5px;
      cursor: pointer;
      font-size: 12px;
      flex-shrink: 0;
      line-height: 1;
    }
    #btn-clear-path:hover {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-button-secondaryHoverBackground);
    }

    #graph-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    /* Tooltip */
    #tooltip {
      position: absolute;
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      color: var(--vscode-editorHoverWidget-foreground);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11px;
      line-height: 1.5;
      pointer-events: none;
      max-width: 280px;
      word-break: break-all;
      display: none;
      z-index: 100;
    }

    /* Context menu */
    #ctx-menu {
      position: absolute;
      display: none;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 4px 0;
      min-width: 160px;
      z-index: 200;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .ctx-item {
      padding: 5px 14px;
      font-size: 11px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
      white-space: nowrap;
    }
    .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }

    /* Empty state */
    #empty-state {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
      padding: 20px;
    }
    #empty-state .icon { font-size: 32px; }

    /* Legend */
    #legend {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 10px;
      line-height: 1.8;
      pointer-events: none;
      opacity: 0.85;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <!-- Row 1: action buttons -->
  <div id="toolbar">
    <button id="btn-refresh" title="Refresh graph">↺ Refresh</button>
    <button id="btn-fit"     title="Fit graph to view">⊡ Fit</button>
    <button id="btn-reset"   title="Reset node positions">⟳ Reset</button>
    <button id="btn-file-scope" title="Scope graph to the currently open file (shows parent + direct children only)" class="active">📄 File</button>
    <button id="btn-toggle-path" title="Set a sub-directory path to scope the graph">📁 Path<span class="path-dot"></span></button>
    <span id="stats"></span>
    <button id="btn-expand" title="Open graph in full editor panel" style="${expandBtnStyle}">⤢ Expand</button>
  </div>

  <!-- Row 2: filter nodes (always visible, prominent) -->
  <div id="filter-bar">
    <label for="search">🔍</label>
    <input id="search" type="text" placeholder="Filter by filename or @alias…" autocomplete="off">
    <button id="btn-clear-search" title="Clear filter">✕</button>
  </div>

  <!-- Row 3: path bar (collapsible, hidden by default) -->
  <div id="path-bar">
    <label for="root-path" id="root-path-label">📁</label>
    <input id="root-path" type="text" placeholder="Sub-directory to scope graph (e.g. templates)" autocomplete="off" spellcheck="false">
    <button id="btn-apply-path" title="Apply path and rebuild graph">Apply</button>
    <button id="btn-clear-path" title="Clear path — show entire workspace">✕</button>
  </div>

  <div id="graph-container">
    <svg id="svg">
      <defs>
        <marker id="arrow" viewBox="0 -4 10 8" refX="20" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-4L10,0L0,4" fill="#888" />
        </marker>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.3"/>
        </filter>
      </defs>
      <g id="zoom-layer">
        <g id="edges-layer"></g>
        <g id="edge-labels-layer"></g>
        <g id="nodes-layer"></g>
      </g>
    </svg>

    <div id="tooltip"></div>
    <div id="ctx-menu"></div>

    <div id="empty-state">
      <div class="icon">🗂️</div>
      <div>No YAML template files found in the workspace.</div>
      <div>Open a folder containing Azure Pipeline YAML files.</div>
    </div>

    <div id="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#4e9de0"></div>Pipeline root</div>
      <div class="legend-item"><div class="legend-dot" style="background:#3dba8a"></div>Local template</div>
      <div class="legend-item"><div class="legend-dot" style="background:#9b6fd4"></div>External (cross-repo)</div>
      <div class="legend-item"><div class="legend-dot" style="background:#e05c5c"></div>Missing file</div>
      <div class="legend-item"><div class="legend-dot" style="background:#e09a3d"></div>Unknown alias</div>
    </div>
  </div>

  <script nonce="${nonce}" src="${d3Uri}"></script>
  <script nonce="${nonce}" src="${graphUri}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random nonce string for the CSP.
 * @returns {string}
 */
function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the Template Graph WebView sidebar panel and the expand command.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {TemplateGraphProvider}
 */
function createGraphViewProvider(context) {
  const provider = new TemplateGraphProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GRAPH_VIEW_ID,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Manual refresh command (sidebar title bar button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.refreshTemplateGraph',
      () => provider.refresh()
    )
  );

  // Expand command — opens graph in a full editor panel
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'azure-templates-navigator.expandTemplateGraph',
      () => provider.openPanel()
    )
  );

  // Active-editor listener: refresh graph when the user switches to a YAML file
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(
      editor => provider.onActiveEditorChanged(editor)
    )
  );

  // Seed with the currently active editor (if any)
  provider.onActiveEditorChanged(vscode.window.activeTextEditor);

  return provider;
}

module.exports = {
  createGraphViewProvider,
  TemplateGraphProvider,
  GRAPH_VIEW_ID,
};
