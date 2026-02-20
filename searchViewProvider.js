'use strict';

const vscode = require('vscode');
const path = require('path');
const { collectYamlFiles } = require('./graphDataBuilder');
const { FuzzySearch } = require('./fuzzySearch');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SEARCH_VIEW_ID = 'azure-templates-navigator.searchView';

// ---------------------------------------------------------------------------
// Search index builder
// ---------------------------------------------------------------------------

/**
 * Builds a FuzzySearch index from all YAML files in the workspace.
 * Each entry exposes both filename and relativePath so the engine can
 * match against the full path (e.g. "api/build/templates.yaml").
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

// ---------------------------------------------------------------------------
// WebView provider
// ---------------------------------------------------------------------------

/**
 * VS Code WebviewViewProvider that renders a persistent "Search templates…"
 * input box above the Dependencies tree.
 *
 * Results are shown as clickable items inside the webview itself.
 * Clicking a result opens the file via the openTemplate command.
 *
 * @implements {vscode.WebviewViewProvider}
 */
class SearchViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._context = context;
    /** @type {vscode.WebviewView|null} */
    this._view = null;
    /** @type {FuzzySearch|null} */
    this._engine = null;
    /** @type {number} */
    this._indexBuiltAt = 0;
  }

  /**
   * Returns a (possibly cached) search engine, rebuilding if stale (>30 s).
   * @returns {FuzzySearch|null}
   */
  _getEngine() {
    const wf = vscode.workspace.workspaceFolders;
    if (!wf || wf.length === 0) return null;
    const root = wf[0].uri.fsPath;
    const now = Date.now();
    if (!this._engine || now - this._indexBuiltAt > 30000) {
      this._engine = buildSearchIndex(root);
      this._indexBuiltAt = now;
    }
    return this._engine;
  }

  /** Force the index to be rebuilt on next search (call after file saves). */
  invalidateIndex() {
    this._indexBuiltAt = 0;
  }

  /**
   * Called by VS Code when the view becomes visible.
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg),
      undefined,
      this._context.subscriptions
    );
  }

  /**
   * @private
   * @param {{ type: string, query?: string, filePath?: string }} msg
   */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'search': {
        const engine = this._getEngine();
        if (!engine) {
          this._send({ type: 'results', items: [] });
          return;
        }
        const q = (msg.query || '').trim();
        if (!q) {
          this._send({ type: 'results', items: [] });
          return;
        }
        const hits = engine.search(q, 30);
        const items = hits.map(({ entry }) => ({
          filePath: entry.filePath,
          filename: entry.filename,
          relativePath: entry.relativePath,
          directory: entry.directory !== '.' ? entry.directory : '',
        }));
        this._send({ type: 'results', items });
        break;
      }

      case 'open': {
        if (msg.filePath) {
          vscode.commands.executeCommand(
            'azure-templates-navigator.openTemplate',
            { filePath: msg.filePath, beside: false }
          );
        }
        break;
      }

      case 'openBeside': {
        if (msg.filePath) {
          vscode.commands.executeCommand(
            'azure-templates-navigator.openTemplate',
            { filePath: msg.filePath, beside: true }
          );
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * @private
   * @param {object} msg
   */
  _send(msg) {
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
  }

  /**
   * @private
   * @param {vscode.Webview} webview
   * @returns {string}
   */
  _getHtml(webview) {
    const nonce = getNonce();
    // CSP: no external resources needed
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Search Templates</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-sideBar-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      overflow: hidden;
    }

    #search-wrap {
      padding: 6px 8px 4px;
    }

    #search-input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }
    #search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    #search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    #results {
      overflow-y: auto;
      max-height: calc(100vh - 42px);
    }

    .result-item {
      display: flex;
      flex-direction: column;
      padding: 4px 10px;
      cursor: pointer;
      border-bottom: 1px solid transparent;
      user-select: none;
    }
    .result-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .result-item:active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .result-name {
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .result-dir {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #empty {
      padding: 8px 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: none;
    }
  </style>
</head>
<body>
  <div id="search-wrap">
    <input id="search-input" type="text" placeholder="Search templates…" autocomplete="off" spellcheck="false" />
  </div>
  <div id="results"></div>
  <div id="empty">No templates found.</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input   = document.getElementById('search-input');
    const results = document.getElementById('results');
    const empty   = document.getElementById('empty');

    let debounce = null;

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: input.value });
      }, 120);
    });

    // Keyboard navigation
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = results.querySelector('.result-item');
        if (first) first.focus();
      } else if (e.key === 'Escape') {
        input.value = '';
        vscode.postMessage({ type: 'search', query: '' });
      }
    });

    results.addEventListener('keydown', e => {
      const items = [...results.querySelectorAll('.result-item')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < items.length - 1) items[idx + 1].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) items[idx - 1].focus();
        else input.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        document.activeElement.click();
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type !== 'results') return;

      results.innerHTML = '';

      if (!msg.items || msg.items.length === 0) {
        empty.style.display = input.value.trim() ? 'block' : 'none';
        return;
      }

      empty.style.display = 'none';

      for (const item of msg.items) {
        const el = document.createElement('div');
        el.className = 'result-item';
        el.tabIndex = 0;
        el.title = item.relativePath;

        const name = document.createElement('div');
        name.className = 'result-name';
        name.textContent = item.filename;

        const dir = document.createElement('div');
        dir.className = 'result-dir';
        dir.textContent = item.directory || item.relativePath;

        el.appendChild(name);
        el.appendChild(dir);

        el.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', filePath: item.filePath });
        });
        el.addEventListener('auxclick', e => {
          if (e.button === 1) {
            vscode.postMessage({ type: 'openBeside', filePath: item.filePath });
          }
        });

        results.appendChild(el);
      }
    });
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Registers the Search webview view.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {SearchViewProvider}
 */
function createSearchViewProvider(context) {
  const provider = new SearchViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SEARCH_VIEW_ID,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Invalidate the search index whenever a YAML file is saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (/\.ya?ml$/i.test(doc.fileName)) {
        provider.invalidateIndex();
      }
    })
  );

  return provider;
}

module.exports = { createSearchViewProvider, SearchViewProvider, SEARCH_VIEW_ID };
