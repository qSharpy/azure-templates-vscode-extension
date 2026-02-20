# Change Log

All notable changes to the Azure Templates Navigator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.1] - 2026-02-20

### Changed

- **README screenshots** — added feature screenshots throughout the README so they
  appear on the VS Code Marketplace extension page: full overview, hover tooltip,
  parameter validation diagnostics, IntelliSense autocomplete, pipeline variable hover,
  template dependency tree, template graph, diagnostics panel, and quick-fix action.

- **Template Graph: improved hierarchical layout spacing** — nodes in the same layer
  are now spaced at least 160 px apart horizontally (centred), and layers are at least
  140 px apart vertically. Random jitter removed; the force simulation fine-tunes
  positions from clean seed coordinates, resulting in a more readable initial layout.

- **Sample pipeline fix** — corrected a type-mismatch in `samples/azure-pipelines.yml`
  (`includeRunLink: asd` → `includeRunLink: 'true'`).

## [1.7.0] - 2026-02-20

### Added

- **Quick-Fix Code Actions** — three one-click fixes for diagnostics emitted by the
  parameter validation engine:

  - **Add missing parameter** (`missing-required-param`) — inserts `<paramName>: ` at
    the correct indentation inside the `parameters:` sub-block of the template call.
    If no `parameters:` block exists yet, one is created automatically. The cursor
    lands on the value placeholder after the fix is applied.

  - **Remove unknown parameter** (`unknown-param`) — deletes the entire line that
    contains the unrecognised parameter key (including its trailing newline).

  - **Fix type mismatch** (`type-mismatch`) — replaces the current value with the
    canonical literal for the expected type: `true` for `boolean`, `0` for `number`,
    `''` for `string`, `[]` for list types (`stepList`, `jobList`, `stageList`, etc.),
    and `{}` for `object`.

  All three actions are marked `isPreferred` so they appear at the top of the
  lightbulb menu and can be triggered with a single keyboard shortcut.

- **New file `quickFixProvider.js`** — implements `vscode.CodeActionProvider` with
  three internal helpers exported for unit testing:
  `buildAddMissingParamFix`, `buildRemoveUnknownParamFix`, `buildFixTypeMismatchFix`,
  `canonicalLiteralForType`, `findParametersLine`, `findLastParamLine`.

- **New commands** registered (for completeness / keybinding surface):
  `azure-templates-navigator.quickfix.addMissingParam`,
  `azure-templates-navigator.quickfix.removeUnknownParam`,
  `azure-templates-navigator.quickfix.fixTypeMismatch`.

- **47 new unit tests** in `test/unit/quickFixProvider.unit.test.js` covering all
  helper functions and the three fix builders across a wide range of edge cases
  (no `parameters:` block, empty block, last line of file, multi-template files,
  all canonical type literals, etc.).

## [1.6.0] - 2026-02-19

### Added

- **Parameter Go-To-Definition** — Ctrl/Cmd+Click (or F12) on a parameter key inside a
  template call site now navigates directly to the `- name: <param>` line in the referenced
  template file. Works for all template reference styles: relative paths, absolute `/` paths,
  and cross-repo `@alias` references.

  Example: in a pipeline file with
  ```yaml
  - template: templates/build-dotnet.yml
    parameters:
      project: '**/*.csproj'        ← Ctrl+Click jumps to "- name: project" in build-dotnet.yml
      buildConfiguration: Release   ← Ctrl+Click jumps to "- name: buildConfiguration"
  ```

- **New internal helper `findOwningTemplateLine(lines, cursorLine)`** — walks upward from the
  cursor through `parameters:` intermediate keys to locate the `- template:` line that owns
  the current block. Exported for unit testing and future reuse.

- **9 new unit tests** covering the new functionality:
  - `parseParameters — line numbers` suite (3 tests): verifies the `line` property on each
    parsed parameter, including with comment lines between entries.
  - `findOwningTemplateLine` suite (6 tests): direct param key, deeply-nested indentation,
    non-template blocks (returns -1), no template above (returns -1), multiple sequential
    templates (picks the correct one), and blank lines between template and parameters.

## [1.5.0] - 2026-02-19

### Added

- **Full-path labels toggle — Template Graph** — a new **⊞ Full Path** button in the graph
  toolbar lets you switch node labels between the short filename (e.g. `build-dotnet.yml`) and
  the full workspace-relative path (e.g. `templates/build-dotnet.yml`). The button highlights
  when active; labels update instantly without restarting the simulation. The filter box also
  searches against the full relative path when this mode is on.

- **Full-path labels toggle — Template Tree** — a new **$(symbol-file) Toggle Full Path Labels**
  icon button in the Template Dependencies view title bar (also available via the Command Palette
  as `Azure Templates Navigator: Toggle Full Path Labels`) switches all tree node labels between
  filename-only and workspace-relative path. A toast notification confirms the current mode.

- **Graph stats moved into the canvas** — the scope summary line
  (`📄 azure-pipelines.yml · 7 nodes · ↓ 6 downstream`) is now displayed as a floating
  overlay in the **top-left corner of the graph canvas** instead of in the toolbar, freeing
  up toolbar space and keeping the information visible at all times while interacting with
  the graph.

## [1.4.9] - 2026-02-19

### Fixed

- **Windows: diagnostics, tree view, and template graph now work correctly** — files
  with CRLF line endings (the default on Windows) caused regex `$` anchors to fail
  when matching `template:` lines, because `text.split('\n')` left a trailing `\r`
  on every line. This broke diagnostics (no missing-parameter warnings), the Template
  Dependencies tree view (showed no children), and the Template Graph (showed almost
  no connections). All text-splitting code paths now normalize CRLF → LF before
  splitting, fixing all three features on Windows.

- **Removed leftover debug logging** — all `[ATN DEBUG]` console.log statements added
  during investigation have been removed.

## [1.4.8] - 2026-02-19

### Changed

- **Required parameter detection now uses Azure Pipelines native semantics** — a parameter
  is considered required when it has **no `default:` key**, which is exactly how Azure
  Pipelines itself treats parameters at runtime. The previous `# REQUIRED` comment marker
  is no longer needed and is no longer recognised. Any template that omits `default:` on a
  parameter will automatically be flagged as required in hover tooltips, IntelliSense
  completions, and diagnostics — with no extra annotation needed in the YAML.

- **Template Graph: Legend is now collapsible** — the legend in the bottom-right corner of
  the Template Graph is collapsed by default, showing only a small `▶ Legend` toggle header.
  Clicking it expands the full colour key (Pipeline root, Local template, External, Missing
  file, Unknown alias, ↓ downstream, ↑ upstream). Clicking again collapses it. The arrow
  rotates smoothly to indicate state.

## [1.4.7] - 2026-02-19

### Added

- **Template Graph: Upstream & Downstream views in file-scope mode** — when the graph is
  scoped to the currently active YAML file (📄 File button), the graph now shows **both
  directions** of the dependency chain:
  - **↓ Downstream** (blue edges) — templates directly called by the focal file
  - **↑ Upstream** (amber dashed edges) — all workspace files that call the focal file
  - The focal node is highlighted with a dashed ring so it is always easy to identify
  - Hovering a node shows its role: `◎ Focal file`, `↑ Upstream caller`, or
    `↓ Downstream dependency`
  - The stats bar shows counts: e.g. `📄 azure-pipelines.yml · 5 nodes · ↓ 3 downstream · ↑ 2 upstream`
  - The graph legend now includes a colour key for downstream (blue) and upstream (amber dashed) edges
  - New helper `buildFileGraph()` in `graphDataBuilder.js` performs the two-pass scan
    (downstream refs from the file + reverse-lookup of all callers across the workspace)

## [1.4.6] - 2026-02-19

### Added

- **Encoding detection in `extractTemplateRefs`** — now reads files as raw bytes first,
  detects UTF-16 LE/BE BOM and UTF-8 BOM, and logs the encoding. Also logs the first
  20 bytes as hex for any file that contains no "template" word at all, to diagnose
  whether files are being read with unexpected encoding on Windows.

## [1.4.5] - 2026-02-19

### Added

- **Extended diagnostic logging** — added `[ATN DEBUG]` logs to `extractTemplateRefs`
  to show raw line content (including CRLF detection) when a file contains "template"
  text but the regex finds zero refs. Also added `hasCRLF` flag and regex-miss logging
  to `getDiagnosticsForDocument`. These logs will reveal whether CRLF line endings
  cause the template-ref regex to fail on Windows-authored YAML files.

## [1.4.4] - 2026-02-19

### Added

- **Diagnostic logging for Windows path investigation** — added `[ATN DEBUG]` console
  log statements to `hoverProvider.js`, `graphDataBuilder.js`, `treeViewProvider.js`,
  and `diagnosticProvider.js` to capture path resolution details, nodeMap hit/miss
  statistics, and template-children counts on Windows. These logs appear in the
  VS Code Developer Tools console (Help → Toggle Developer Tools → Console) and are
  used to diagnose why the tree view, graph, and diagnostics show fewer connections
  than expected on Windows. Will be removed once the root cause is confirmed and fixed.

## [1.4.3] - 2026-02-19

### Fixed

- **Required parameters with defaults now emit an Info instead of an Error** — when a template
  parameter is marked `# REQUIRED` but also declares a `default:` value, and the call site omits
  that parameter, the diagnostic severity is now `Information` (ℹ) instead of `Error` (🔴).
  The info message includes the default value that will be used (e.g.
  `… — default value 'project' will be used`), so the intent is clear without blocking the author.
  Parameters that are `# REQUIRED` with **no** default continue to emit an `Error` as before.

## [1.4.2] - 2026-02-19

### Fixed

- **Parameters not shown for Windows-authored YAML files** — `parseParameters()` now correctly
  handles template files with CRLF (`\r\n`) line endings where parameters are written at column 0
  (no leading indentation). Previously, the block-exit condition fired on the very first
  `- name:` list item at column 0, causing the function to return 0 parameters for every template
  in repos authored on Windows. The tree view parameter badges, hover tooltips, diagnostics, and
  IntelliSense completions were all affected. The fix also ensures that `# comment` lines at
  column 0 (used to annotate parameters) no longer prematurely terminate the parameters block.
  Two regression tests added to prevent recurrence.

## [1.4.1] - 2026-02-19

### Changed

- **Template Graph: Filter nodes redesigned** — the filter input now occupies its own
  full-width dedicated row (always visible) with a larger font, focus highlight, and a
  one-click `✕` clear button that appears as soon as text is typed. Placeholder text
  updated to `Filter by filename or @alias…` to clarify that cross-repo alias names are
  also searchable.

- **Template Graph: Path scoping moved to a collapsible panel** — the `📁 Path` sub-directory
  filter is now a toggle button in the toolbar instead of a permanently visible second row.
  Clicking `📁 Path` opens a compact input bar beneath the filter row; pressing `Enter`,
  `Escape`, Apply, or the clear `✕` collapses it again. A small blue dot on the button
  indicates when a path scope is actively applied, even while the bar is hidden.

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
