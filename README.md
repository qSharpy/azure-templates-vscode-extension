# Azure Templates Navigator

A must-have VS Code extension for anyone who develops, debugs, or reviews Azure Pipelines YAML files.

Hover over any `- template:` reference to instantly see its parameters. Get real-time diagnostics for missing or unknown parameters. Autocomplete parameter names as you type. Hover over `$(variables)` to see their values. Explore the full template dependency tree **and** an interactive workspace-wide dependency graph — all with zero runtime dependencies.

![hover demo](logo.png)

---

## Features

### 🔍 Template Parameter Hover
Hover over any `- template:` line to see a tooltip with all parameters declared in the referenced template — their types, default values, and which are required.

### 🔴 Parameter Validation Diagnostics
Real-time squiggly-line diagnostics on every template call site:
- **Error** — missing a required parameter
- **Warning** — passing an unknown parameter not declared in the template
- **Warning** — type mismatch (e.g. passing `'yes'` to a `boolean` parameter)

Diagnostics update automatically as you type (debounced 500ms).

### 💡 IntelliSense Autocomplete
When typing inside the `parameters:` block under a `- template:` line, the extension offers autocomplete suggestions for every parameter declared in the referenced template:
- Required parameters appear first (marked with ⚠)
- Each suggestion shows the parameter type and default value
- Already-set parameters are shown at the bottom

### 📦 Pipeline Variable Hover
Hover over any `$(variableName)` or `${{ variables.name }}` reference to see:
- The variable's value (from the pipeline `variables:` block)
- The line where it is defined
- For variable groups: the group name
- For Azure DevOps system variables (`Build.*`, `System.*`, `Agent.*`, etc.): a link to the official docs

### 🌲 Template Dependency Tree View
A sidebar panel in the **Azure Templates Navigator** Activity Bar showing the full dependency tree for the **currently active** pipeline file:
- Expand any node to see templates it references (recursive, nested templates supported)
- **Cycle detection** — circular references are shown as `↩ circular` leaf nodes instead of causing infinite recursion
- Click any node to open the template file
- **Right-click** any node for context menu actions:
  - **Open to Side** — opens the template in a split editor column
  - **Copy Template Path** — copies the raw `template:` reference string to the clipboard
- Cross-repo templates show a 🔗 repo badge; missing templates show a ⚠ warning icon
- Parameter count shown as `3 params · 2 req ⚠` in the dimmed description
- Refresh button in the panel title bar; auto-refreshes on active editor change

### 🗺️ Template Graph View
An interactive force-directed graph in the **same Activity Bar panel** (below the tree view) showing **all YAML files** in the workspace and their template relationships at a glance:

| Node colour | Meaning |
|---|---|
| 🔵 Blue | Pipeline root file (`trigger:` / `stages:` at top level) |
| 🟢 Teal | Local template |
| 🟣 Purple | External / cross-repo template |
| 🔴 Red | Missing file (not found on disk) |
| 🟠 Orange | Unknown `@alias` (not in `resources.repositories`) |

**Interactions:**
- **Click** a node → opens the file in the editor
- **Drag** a node → pins it in place; **double-click** to unpin
- **Scroll** → zoom in/out; **drag background** → pan
- **Hover** a node → highlights its direct neighbours and dims the rest; shows a tooltip with path and parameter count
- **Right-click** a node → copies the file path to the clipboard
- **Filter box** → type to highlight matching nodes by filename or repo name
- **↺ Refresh** → re-scans the workspace
- **⊡ Fit** → fits the entire graph into the visible area
- **⟳ Reset** → unpins all nodes and re-runs the simulation

Works fully **offline** — D3 v7 is bundled with the extension.

### 🔗 Cross-Repository Template Support
Resolves `@alias` references using `resources.repositories` declarations. The extension maps each alias to its repository name and resolves the template path as `{repo-root}/../{repo-name}/{template-path}` on the local filesystem.

### ⌨️ Go-to-Definition
Press **F12** / **Cmd+Click** / **Ctrl+Click** on any `- template:` line to jump directly to the template file.

### 🎨 Configurable Required Parameter Color
Required parameters are highlighted in a configurable color (default: red) in the hover tooltip.

### ✅ Zero Dependencies
No `npm install` needed at runtime. Works straight from the marketplace.

---

## How it works

### Template Parameter Hover

In your template YAML files, mark required parameters with a `# REQUIRED` comment on the line immediately before the `- name:` entry:

```yaml
parameters:
  # REQUIRED
  - name: environment
    type: string
  # REQUIRED
  - name: azureSubscription
    type: string
  - name: vmImage
    type: string
    default: 'ubuntu-latest'
```

Then in your pipeline file, hover over any `- template:` line:

```yaml
- template: templates/deploy.yml
  parameters:
    environment: 'Production'
```

The tooltip will show each parameter, its type, default value, and whether it is required.

---

### Parameter Validation Diagnostics

The extension automatically validates every template call site in your pipeline files. No configuration needed — it works as soon as you open a YAML file.

**Missing required parameter** (red squiggly on the `template:` line):
```yaml
- template: templates/deploy.yml   # ← Error: Missing required parameter 'environment'
  parameters:
    azureSubscription: my-sub
```

**Unknown parameter** (yellow squiggly on the parameter name):
```yaml
- template: templates/deploy.yml
  parameters:
    environment: Production
    typoParam: value              # ← Warning: Unknown parameter 'typoParam'
```

**Type mismatch** (yellow squiggly on the parameter line):
```yaml
- template: templates/build.yml
  parameters:
    publishArtifact: 'yes'        # ← Warning: expects 'boolean', got 'string'
```

> **Note:** Parameters passed as pipeline expressions (`$(var)` or `${{ variables.x }}`) are excluded from type checking since their values are only known at runtime.

---

### IntelliSense Autocomplete

When your cursor is inside the `parameters:` block under a `- template:` line, press **Ctrl+Space** (or just start typing) to see autocomplete suggestions:

```yaml
- template: templates/deploy.yml
  parameters:
    env<cursor>   # ← suggests: environment ⚠ required, ...
```

Each suggestion includes:
- The parameter name
- Its type (shown right-aligned)
- Whether it is required
- Its default value (if any)
- A snippet that places the cursor after the `: ` for immediate value entry

---

### Pipeline Variable Hover

Hover over any `$(variableName)` or `${{ variables.name }}` reference in your pipeline:

```yaml
variables:
  buildConfiguration: 'Release'   # defined on line 3

steps:
  - script: dotnet build --configuration $(buildConfiguration)
  #                                       ^^^^^^^^^^^^^^^^^^^
  #                                       Hover here → shows value 'Release', line 3
```

**Variable groups** are shown with their group name:
```yaml
variables:
  - group: my-secrets-group   # hover over $(secretVar) → shows group name
```

**System variables** (`Build.BuildId`, `System.TeamProject`, etc.) show a link to the Azure DevOps predefined variables documentation.

---

### Template Dependency Tree View

Open the **Azure Templates Navigator** panel in the Activity Bar (left sidebar). The tree automatically updates when you switch between YAML files.

```
📄 azure-pipelines.yml
  ├── 📄 build-dotnet.yml          3 params · 2 req ⚠
  ├── 📄 run-tests.yml             2 params · 1 req ⚠
  ├── 🔗 deploy-stage.yml @shared  6 params · 3 req ⚠
  └── 📄 notify-teams.yml          3 params
        └── 📄 teams-webhook.yml   1 param
```

Click any node to open the template file. Right-click for **Open to Side** or **Copy Template Path**. Use the **↺ Refresh** button in the panel title bar to force a refresh.

Circular references are detected and shown as leaf nodes with a `↩ circular` badge — no infinite recursion.

---

### Template Graph View

The **Template Graph** panel (below the tree in the same Activity Bar container) scans **every YAML file** in the workspace and renders a force-directed graph of all template relationships.

This is complementary to the tree view:

| Tree View | Graph View |
|---|---|
| Depth-first drill-down from the **active file** | Workspace-wide map of **all templates** |
| Shows the full call chain for one pipeline | Shows how all pipelines and templates interconnect |
| Updates when you switch editors | Refreshes on demand or via the ↺ button |

**Tips:**
- Use the **Filter** box to highlight a specific template across the whole graph
- Drag nodes to arrange them; they stay pinned until you double-click or hit **⟳ Reset**
- Use **⊡ Fit** after a refresh to bring all nodes into view
- The graph works fully offline — D3 v7 is bundled with the extension

---

## Cross-Repository Templates

Azure Pipelines lets you reference templates from other repositories using the `@alias` syntax. The extension resolves these references automatically by reading the `resources.repositories` block in the same file.

### How it works

Given a pipeline like this:

```yaml
resources:
  repositories:
    - repository: templates          # alias used in template references
      name: myorg/shared-templates   # the actual repository name

stages:
  - template: stages/build.yml@templates
```

The extension:
1. Reads the `resources.repositories` block and builds an alias → repo-name map (`templates` → `shared-templates`)
2. Resolves the template path as **`{repo-root}/../shared-templates/stages/build.yml`** (one level above the current repo root, next to it on disk)

### Setup

Clone the external repository **next to** your current workspace:

```
parent-directory/
├── your-pipeline-repo/     ← your workspace (open in VS Code)
│   └── pipelines/azure-pipelines.yml
└── shared-templates/       ← clone the template repo here
    └── stages/build.yml
```

The hover tooltip will show the template's parameters and a **🔗 External repository** badge. If the sibling directory doesn't exist yet, the tooltip shows a helpful message telling you which repo to clone.

### Unknown alias

If you hover over a `@alias` reference that has no matching entry in `resources.repositories`, the tooltip explains what to add:

> ⚠️ Repository alias not found: `@templates`
> Add a `resources.repositories` entry with `repository: templates` to enable cross-repo template resolution.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `azure-templates-navigator.requiredParameterColor` | `#c92d35` | Hex color for required parameter names in the hover tooltip |
| `azure-templates-navigator.diagnostics.enabled` | `true` | Enable/disable parameter validation diagnostics |
| `azure-templates-navigator.diagnostics.debounceMs` | `500` | Milliseconds to wait after a document change before re-running diagnostics |

You can also run the command **"Azure Templates Navigator: Set Required Parameter Color"** from the Command Palette (`Cmd+Shift+P`) to change the color interactively. Accepts hex values (`#ff0000`), named colors (`red`, `blue`, `green`, `pink`, `purple`, `orange`, `yellow`, `tesla`), or `random`.

---

## Local Development Workflow

### Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- VS Code

### First-time setup

```bash
# Clone the repo
git clone https://github.com/qSharpy/azure-templates-vscode-extension.git
cd azure-templates-vscode-extension

# Install dev dependencies (only needed for linting/packaging, NOT for running the extension)
npm install
```

> **Note:** The extension itself has zero runtime dependencies. `npm install` is only needed if you want to run the linter (`npm run lint`) or package the extension (`npm run package`).

### Test locally with F5

1. Open the project folder in VS Code
2. Press **F5** (or go to **Run → Start Debugging**)
3. A new VS Code window opens — the **Extension Development Host** — with your extension loaded
4. In that new window, the `samples/` folder is opened automatically
5. Open `samples/azure-pipelines.yml` and:
   - Hover over any `- template:` line to see the parameter tooltip
   - Hover over any `$(variableName)` to see the variable value
   - Look at the Problems panel for parameter validation diagnostics
   - Open the Azure Templates Navigator panel in the Activity Bar
6. You should see all features working immediately

**To reload after making changes:**
- Press `Cmd+R` (Mac) / `Ctrl+R` (Windows/Linux) in the Extension Development Host window, **or**
- Stop debugging (`Shift+F5`) and press **F5** again

### Lint

```bash
npm run lint
```

### Package as `.vsix` (for manual install / sharing)

```bash
npm run package
# Produces: azure-templates-navigator-X.Y.Z.vsix
```

Install the `.vsix` locally:
```
Extensions panel → ··· menu → Install from VSIX...
```

### Publish to the Marketplace

```bash
# One-time: log in with your Personal Access Token
npx vsce login bogdanbujor

# Publish (bumps version in package.json automatically with --patch/--minor/--major)
npm run publish
```

---

## Running unit tests

The pure-logic unit tests run without a VS Code host and complete in milliseconds:

```bash
npm run test:unit
```

The full VS Code integration test suite (requires a desktop environment):

```bash
npm test
```

---

## Known Limitations

- Only parses `parameters:` blocks at the top level of the template file
- Template references using variables (e.g. `- template: ${{ variables.templatePath }}`) are not resolved (skipped gracefully)
- Cross-repo resolution assumes the sibling repo is cloned locally; remote-only repos are not fetched automatically
- Variable group contents require an Azure DevOps connection to resolve (only the group name is shown)
- Type checking for `object`, `step`, `job`, `stage` parameter types is limited (multi-line YAML values are not fully parsed)

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## Support

[Buy me a merdenea ☕](https://ko-fi.com/bogdanbujor)
