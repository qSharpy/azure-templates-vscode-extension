# Change Log

All notable changes to the Azure Templates Navigator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-02-18

### Added

- **Template Graph View** — a new interactive force-directed graph panel in the same
  Activity Bar container as the tree view:
  - Scans **all YAML files** in the workspace (recursively) and renders every template
    relationship as a graph — complementary to the tree view which focuses on the active file
  - Node colours by type: 🔵 pipeline root, 🟢 local template, 🟣 external/cross-repo,
    🔴 missing file, 🟠 unknown alias
  - Click a node to open the file; right-click to copy the path to the clipboard
  - Drag nodes to pin them; double-click to unpin; scroll to zoom; drag background to pan
  - Hover a node to highlight its direct neighbours and dim the rest
  - Filter box to highlight nodes by filename or repo name
  - ↺ Refresh, ⊡ Fit, ⟳ Reset buttons in the toolbar
  - Works fully offline — D3 v7 is bundled with the extension (`media/d3.min.js`)
  - New command: `Azure Templates Navigator: Refresh Template Graph`
  - New file: `graphDataBuilder.js` — pure Node.js workspace scanner (no vscode dependency,
    fully unit-tested)
  - New file: `graphWebViewProvider.js` — thin WebView wrapper
  - New file: `media/graph.js` — D3 rendering logic

- **Tree View: Cycle Detection** — circular template references are now detected and shown
  as `↩ circular` leaf nodes with an issues icon instead of causing a stack overflow

- **Tree View: Context Menu** — right-click any template node for:
  - **Open to Side** — opens the template in a new split editor column
  - **Copy Template Path** — copies the raw `template:` reference string to the clipboard

- **Tree View: Improved Description Badge** — parameter count now shown as
  `3 params · 2 req ⚠` (middle-dot separator, warning suffix when required params exist)

- **New unit tests** — `test/unit/graphWebViewProvider.unit.test.js` (18 tests covering
  `collectYamlFiles`, `isPipelineRoot`, `extractTemplateRefs`, and `buildWorkspaceGraph`)

## [1.3.0] - 2026-02-18

### Added

- **Parameter Validation Diagnostics** — real-time squiggly-line diagnostics on every
  `- template:` call site in your pipeline YAML files:
  - 🔴 **Error** when a required parameter is missing from the call site
  - 🟡 **Warning** when an unknown parameter (not declared in the template) is passed
  - 🟡 **Warning** for basic type mismatches (e.g. passing `'yes'` to a `boolean` parameter)
  - Diagnostics are debounced (500ms) and update automatically as you type
  - Pipeline expressions (`$(var)`, `${{ variables.x }}`) are excluded from type checking
  - New settings: `azure-templates-navigator.diagnostics.enabled` and
    `azure-templates-navigator.diagnostics.debounceMs`

- **IntelliSense Autocomplete for Template Parameters** — when the cursor is inside the
  `parameters:` block under a `- template:` line, the extension offers `CompletionItem`
  suggestions for every parameter declared in the referenced template:
  - Required parameters appear first, marked with ⚠
  - Each suggestion shows the parameter type and default value as documentation
  - Inserts a snippet placing the cursor after `: ` for immediate value entry
  - Already-set parameters are shown at the bottom of the list

- **Pipeline Variable Hover** — hover over any `$(variableName)` or
  `${{ variables.name }}` reference to see:
  - The variable's value and the line where it is defined (from the `variables:` block)
  - Variable group names (when the variable is defined via `- group:`)
  - Azure DevOps system variables (`Build.*`, `System.*`, `Agent.*`, etc.) are identified
    and linked to the official predefined variables documentation

- **Template Dependency Tree View** — a new sidebar panel in the Activity Bar:
  - Shows the full template dependency tree for the currently active pipeline YAML file
  - Expand any node to see templates it references (nested templates supported)
  - Click any node to open the template file
  - Cross-repo templates show a 🔗 repo badge; missing templates show a ⚠ warning
  - Tree refreshes automatically when the active editor changes
  - Manual refresh button in the panel title bar
  - New command: `Azure Templates Navigator: Refresh Template Tree`

- **New exported functions** in `hoverProvider.js` for reuse across providers:
  - `parseVariables(text)` — parses the `variables:` block (map form and list form)
  - `parsePassedParameters(lines, templateLine)` — parses parameters passed at a call site
  - `findRepoRoot(startDir)` — now exported for use by other providers

- **New unit tests** covering all new functionality:
  - `test/unit/diagnosticProvider.unit.test.js` — 15 tests for `inferValueType`,
    `validateCallSite`, and `getDiagnosticsForDocument`
  - `test/unit/completionProvider.unit.test.js` — 10 tests for `findEnclosingTemplate`,
    `isCursorInParametersBlock`, and `provideCompletionItems`
  - Extended `test/unit/hoverProvider.unit.test.js` with 14 new tests for
    `parseVariables` and `parsePassedParameters`

- Updated `samples/azure-pipelines.yml` with inline comments demonstrating variable hover

## [1.2.0] - 2026-02-18

### Added
- **Cross-repository template support** — hover tooltips now work for templates referenced
  with the `@alias` syntax (e.g. `- template: stages/build.yml@templates`).
  The extension reads the `resources.repositories` block in the current pipeline file,
  maps each alias to its repository name, and resolves the template path as
  `{repo-root}/../{repo-name}/{template-path}` on the local filesystem.
- **🔗 External repository badge** in the hover tooltip when a cross-repo template is resolved.
- **Helpful error messages** when:
  - The `@alias` is not declared in `resources.repositories`
  - The sibling repository directory does not exist on disk (includes a hint to clone it)
- **`@self` alias** is treated as a local reference (same behaviour as no alias).
- New sample pipeline `samples/cross-repo-pipeline.yml` demonstrating cross-repo template usage.
- New `npm run test:unit` script — runs 28 pure-Node unit tests via Mocha without needing
  a VS Code host (fast, CI-friendly).
- Test fixtures under `test/fixtures/` with a real sibling-repo structure for integration-style
  unit tests.

## [1.1.0] - 2024-01-01

### Added
- Required parameter color is now configurable via the Command Palette
  ("Azure Templates Navigator: Set Required Parameter Color")

## [1.0.0] - 09-03-2023

### Added
- Show template parameters on template path hover
- Go to template using window message
- Required parameters color highlighting
- Required parameters highlight color is parametrized
