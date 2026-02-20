'use strict';

const path = require('path');
const vscode = require('vscode');
const {
  buildWorkspaceGraph,
  buildFileGraph,
  collectYamlFiles,
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
    /**
     * Graph depth for file-scope mode (1–10).
     * Controls how many BFS levels upstream/downstream are rendered.
     * @type {number}
     */
    this._graphDepth = 1;
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

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

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

    panel.webview.html = this._getHtmlForWebview(panel.webview);

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

      case 'setDepth': {
        // Depth change from the −/+ toolbar buttons in file-scope mode.
        const d = Number(msg.depth);
        if (Number.isFinite(d)) {
          this._graphDepth = Math.max(1, Math.min(10, d));
        }
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
        this._sendSearchData(webview);
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

    // ── File-scope mode: show the active file + BFS up to _graphDepth levels ─
    if (this._fileScopeEnabled && this._activeFile) {
      try {
        const { nodes, edges } = buildFileGraph(this._activeFile, workspaceRoot, this._graphDepth);
        webview.postMessage({
          type: 'graphData',
          nodes,
          edges,
          rootPath: '',
          workspaceRoot,
          fileScopeEnabled: true,
          scopedFile: this._activeFile,
          graphDepth: this._graphDepth,
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
        workspaceRoot,
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
   * Sends the full list of workspace YAML files to the webview for the search bar.
   * @private
   * @param {vscode.Webview} webview
   */
  _sendSearchData(webview) {
    if (!webview) return;
    const wf = vscode.workspace.workspaceFolders;
    if (!wf || wf.length === 0) return;
    const workspaceRoot = wf[0].uri.fsPath;
    try {
      const allFiles = collectYamlFiles(workspaceRoot);
      const items = allFiles.map(fp => {
        const rel = path.relative(workspaceRoot, fp).replace(/\\/g, '/');
        const dir = path.dirname(rel).replace(/\\/g, '/');
        return {
          filePath: fp,
          filename: path.basename(fp),
          relativePath: rel,
          directory: dir === '.' ? '' : dir,
        };
      });
      webview.postMessage({ type: 'searchData', items });
    } catch { /* ignore */ }
  }

  /**
   * Returns the HTML content for the WebView, with a nonce-based CSP.
   * @param {vscode.Webview} webview
   * @returns {string}
   * @private
   */
  _getHtmlForWebview(webview) {
    const nonce = getNonce();

    const d3Uri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'd3.min.js')
    );
    const graphUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'graph.js')
    );

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

    /* ── Search bar ─────────────────────────────────────────────────────── */
    #search-bar {
      padding: 4px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      position: relative;
    }

    #search-input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }
    #search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    #search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    /* Floating results dropdown — overlays the graph canvas */
    #search-results {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-panel-border);
      border-top: none;
      z-index: 500;
      max-height: 260px;
      overflow-y: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    #search-results.open { display: block; }

    .sr-item {
      display: flex;
      flex-direction: column;
      padding: 4px 10px;
      cursor: pointer;
      user-select: none;
    }
    .sr-item:hover, .sr-item.focused {
      background: var(--vscode-list-hoverBackground);
    }
    .sr-name {
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sr-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #search-empty {
      padding: 6px 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
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

    #toolbar-spacer {
      flex: 1;
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

    /* Full-path toggle button — highlights when full paths are shown */
    #btn-full-path.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #btn-full-path.active:hover {
      background: var(--vscode-button-hoverBackground);
    }

    /* Depth controls — only visible in file-scope mode */
    #depth-controls {
      display: none;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    #depth-controls.visible {
      display: flex;
    }
    #depth-controls label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      user-select: none;
      padding: 0 2px;
    }
    #depth-controls button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      padding: 1px 6px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1.4;
      flex-shrink: 0;
    }
    #depth-controls button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #depth-controls button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    #depth-value {
      font-size: 11px;
      font-weight: 600;
      min-width: 14px;
      text-align: center;
      color: var(--vscode-editor-foreground);
      user-select: none;
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
      font-size: 10px;
      line-height: 1.8;
      opacity: 0.9;
      user-select: none;
    }
    #legend-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 10px;
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
    #legend-toggle:hover {
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
    }
    #legend-arrow {
      font-size: 8px;
      transition: transform 0.15s ease;
      display: inline-block;
    }
    #legend.open #legend-arrow {
      transform: rotate(90deg);
    }
    #legend-body {
      display: none;
      padding: 0 10px 6px 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #legend.open #legend-body {
      display: block;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
    .legend-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <!-- Search bar: full-width input above the toolbar -->
  <div id="search-bar">
    <input id="search-input" type="text" placeholder="Search templates…" autocomplete="off" spellcheck="false" />
    <div id="search-results">
      <div id="search-empty" style="display:none">No templates found.</div>
    </div>
  </div>

  <!-- Toolbar: Fit · File/Workspace · Depth · [spacer] · Full Path -->
  <div id="toolbar">
    <button id="btn-fit"        title="Fit graph to view">⊡ Fit</button>
    <button id="btn-file-scope" title="Scope graph to the currently open file" class="active">📄 File</button>
    <!-- Depth controls: only shown in file-scope mode -->
    <div id="depth-controls" title="Graph depth: how many upstream/downstream levels to render (1–10)">
      <label>Depth</label>
      <button id="btn-depth-dec" title="Decrease depth">−</button>
      <span id="depth-value">1</span>
      <button id="btn-depth-inc" title="Increase depth">+</button>
    </div>
    <div id="toolbar-spacer"></div>
    <button id="btn-full-path"  title="Toggle between filename and full workspace-relative path labels">⊞ Full Path</button>
  </div>

  <div id="graph-container">
    <svg id="svg">
      <defs>
        <marker id="arrow" viewBox="0 -4 10 8" refX="20" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-4L10,0L0,4" fill="#888" />
        </marker>
        <marker id="arrow-upstream" viewBox="0 -4 10 8" refX="20" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-4L10,0L0,4" fill="#e09a3d" />
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

    <div id="ctx-menu"></div>

    <div id="empty-state">
      <div class="icon">🗂️</div>
      <div>No YAML template files found in the workspace.</div>
      <div>Open a folder containing Azure Pipeline YAML files.</div>
    </div>

    <div id="legend">
      <div id="legend-toggle" title="Toggle legend">
        <span id="legend-arrow">▶</span> Legend
      </div>
      <div id="legend-body">
        <div class="legend-item"><div class="legend-dot" style="background:#4e9de0"></div>Pipeline root</div>
        <div class="legend-item"><div class="legend-dot" style="background:#3dba8a"></div>Local template</div>
        <div class="legend-item"><div class="legend-dot" style="background:#9b6fd4"></div>External (cross-repo)</div>
        <div class="legend-item"><div class="legend-dot" style="background:#e05c5c"></div>Missing file</div>
        <div class="legend-item"><div class="legend-dot" style="background:#e09a3d"></div>Unknown alias</div>
        <div style="margin-top:5px;border-top:1px solid var(--vscode-panel-border);padding-top:5px">
          <div class="legend-item"><div style="width:18px;height:2px;background:#4e9de0;flex-shrink:0"></div>↓ downstream</div>
          <div class="legend-item"><div style="width:18px;height:2px;background:#e09a3d;flex-shrink:0;border-top:2px dashed #e09a3d;margin-top:-2px"></div>↑ upstream</div>
        </div>
      </div>
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
