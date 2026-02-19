# CLAUDE.md — Azure Templates Navigator (VS Code Extension)

## Project Overview

**Azure Templates Navigator** is a zero-dependency VS Code extension for Azure Pipelines YAML development. It provides hover tooltips, parameter validation diagnostics, IntelliSense autocomplete, variable hover, a template dependency tree view, and an interactive force-directed graph — all without any runtime npm dependencies.

- **Publisher:** `bogdanbujor`
- **Marketplace ID:** `azure-templates-navigator`
- **Activation:** `onLanguage:yaml`
- **Entry point:** [`extension.js`](extension.js)

---

## Architecture

The extension is split into focused provider modules, each registered in [`extension.js`](extension.js):

| File | Responsibility |
|---|---|
| [`extension.js`](extension.js) | Entry point — registers all providers and commands |
| [`hoverProvider.js`](hoverProvider.js) | Template parameter hover tooltips + variable hover + go-to-definition |
| [`diagnosticProvider.js`](diagnosticProvider.js) | Real-time parameter validation (missing required, unknown, type mismatch) |
| [`completionProvider.js`](completionProvider.js) | IntelliSense autocomplete for template parameters |
| [`treeViewProvider.js`](treeViewProvider.js) | Sidebar tree view of template dependencies for the active file |
| [`graphWebViewProvider.js`](graphWebViewProvider.js) | Sidebar WebView with D3 force-directed graph of all workspace templates |
| [`graphDataBuilder.js`](graphDataBuilder.js) | Scans workspace YAML files and builds the graph node/edge data |
| [`media/graph.js`](media/graph.js) | Client-side D3 rendering logic (runs inside the WebView) |
| [`media/d3.min.js`](media/d3.min.js) | Bundled D3 v7 (do NOT lint this file — excluded in `.eslintrc.json`) |

### Cross-repo template resolution

Templates referenced as `template: path/file.yml@alias` are resolved by:
1. Reading `resources.repositories` in the same pipeline file to build an `alias → repo-name` map
2. Resolving the path as `{workspaceRoot}/../{repo-name}/{template-path}` on the local filesystem

---

## Commands

| Command ID | Title |
|---|---|
| `azure-templates-navigator.openTemplate` | Open Template File |
| `azure-templates-navigator.openTemplateBeside` | Open to Side |
| `azure-templates-navigator.copyTemplatePath` | Copy Template Path |
| `azure-templates-navigator.refreshTemplateTree` | Refresh Template Tree |
| `azure-templates-navigator.refreshTemplateGraph` | Refresh Template Graph |
| `azure-templates-navigator.setRequiredParameterColor` | Set Required Parameter Color |
| `azure-templates-navigator.expandTemplateGraph` | Open Graph in Editor Panel |

---

## Configuration Settings

| Setting | Default | Type |
|---|---|---|
| `azure-templates-navigator.requiredParameterColor` | `#c92d35` | `string` (hex color) |
| `azure-templates-navigator.diagnostics.enabled` | `true` | `boolean` |
| `azure-templates-navigator.diagnostics.debounceMs` | `500` | `number` (100–5000) |

---

## Development Commands

```bash
# Install dev dependencies (linting/packaging only — NOT needed to run the extension)
npm install

# Run ESLint
npm run lint

# Run unit tests (no VS Code host required, fast)
npm run test:unit

# Run full integration tests (requires desktop/display)
npm test

# Package as .vsix for local install or sharing
npm run package

# Publish to VS Code Marketplace
npm run publish
```

### Running locally (F5 debug)

1. Open this folder in VS Code
2. Press **F5** → opens an **Extension Development Host** window with the extension loaded
3. The `samples/` folder is opened automatically in the host window
4. Open `samples/azure-pipelines.yml` to exercise all features
5. Reload after changes: **Cmd+R** in the host window, or **Shift+F5** → **F5**

---

## Testing

### Unit tests (`test/unit/`)

Pure-logic tests with no VS Code dependency. Run with:
```bash
npm run test:unit
```

Files:
- [`test/unit/completionProvider.unit.test.js`](test/unit/completionProvider.unit.test.js)
- [`test/unit/diagnosticProvider.unit.test.js`](test/unit/diagnosticProvider.unit.test.js)
- [`test/unit/graphWebViewProvider.unit.test.js`](test/unit/graphWebViewProvider.unit.test.js)
- [`test/unit/hoverProvider.unit.test.js`](test/unit/hoverProvider.unit.test.js)

### Integration tests (`test/suite/`)

Require a VS Code host. Run with `npm test` (uses `@vscode/test-electron`).

Files:
- [`test/suite/extension.test.js`](test/suite/extension.test.js)
- [`test/suite/hoverProvider.test.js`](test/suite/hoverProvider.test.js)

### Test fixtures

- [`test/fixtures/main-repo/`](test/fixtures/main-repo/) — simulates the primary workspace repo
- [`test/fixtures/sibling-repo/`](test/fixtures/sibling-repo/) — simulates a cross-repo sibling for `@alias` resolution tests

---

## Code Style & Conventions

- **Language:** CommonJS (`require`/`module.exports`), ES2020, Node.js environment
- **Linter:** ESLint with rules in [`.eslintrc.json`](.eslintrc.json) — all rules are `"warn"` level
- **No TypeScript** — plain JavaScript with JSDoc annotations for VS Code API types
- **No runtime dependencies** — `devDependencies` only (mocha, eslint, vsce, @vscode/test-electron)
- `'use strict'` at the top of every source file
- Provider modules export factory functions (`createXxxProvider`) or plain objects (`hoverProvider`, `completionProvider`)
- All disposables must be pushed to `context.subscriptions` in [`activate()`](extension.js:14)

---

## YAML Template Convention (for samples)

Required parameters are marked with a `# REQUIRED` comment on the line immediately **before** the `- name:` entry:

```yaml
parameters:
  # REQUIRED
  - name: environment
    type: string
  - name: vmImage
    type: string
    default: 'ubuntu-latest'
```

This comment is parsed by [`hoverProvider.js`](hoverProvider.js) and [`diagnosticProvider.js`](diagnosticProvider.js) to determine which parameters are required.

---

## Samples

The [`samples/`](samples/) directory is the default workspace opened in the Extension Development Host:

```
samples/
├── azure-pipelines.yml          # Main pipeline exercising all features
├── cross-repo-pipeline.yml      # Cross-repo @alias template references
├── jobs/build-job.yml
├── pipelines/
│   ├── deep-pipeline.yml        # Deeply nested template chain
│   └── microservice-pipeline.yml
├── stages/
│   ├── ci-stage.yml
│   └── deploy-stage.yml
└── templates/
    ├── build-dotnet.yml
    ├── deploy-webapp.yml
    ├── docker-build-push.yml
    ├── empty-template.yml
    ├── notify-teams.yml
    └── run-tests.yml
```

---

## Packaging & Publishing

### Release checklist

When creating a new release, always follow these steps **in order**:

1. **Bump the version** in [`package.json`](package.json) (`"version"` field)
2. **Update [`CHANGELOG.md`](CHANGELOG.md)** — move the new version out of `[Unreleased]` and add a dated `## [X.Y.Z] - YYYY-MM-DD` section describing all changes
3. **Package** the extension:
   ```bash
   npm run package
   ```
4. **Publish** to the VS Code Marketplace:
   ```bash
   npm run publish
   ```
5. **Commit, tag, and push**:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "release: vX.Y.Z — <short description>"
   git tag vX.Y.Z
   git push origin main --tags
   ```

> **Important:** Always create a git tag named `vX.Y.Z` (matching the version in `package.json`) and push it together with the commit. This keeps the git history aligned with Marketplace releases.

### One-time setup

```bash
# Authenticate with your PAT (only needed once per machine)
npx vsce login bogdanbujor
```

Files excluded from the `.vsix` package are listed in [`.vscodeignore`](.vscodeignore).

---

## Known Limitations

- Only parses `parameters:` blocks at the **top level** of a template file
- Template references using variables (e.g. `- template: ${{ variables.templatePath }}`) are skipped gracefully
- Cross-repo resolution requires the sibling repo to be cloned locally; remote-only repos are not fetched
- Variable group contents are not resolved (only the group name is shown) — requires an Azure DevOps connection
- Type checking for `object`, `step`, `job`, `stage` parameter types is limited
