# Azure Templates Navigator

Hover over any `- template:` reference in an Azure Pipelines YAML file to instantly see the template's parameters — which are required, their types, and their default values.

![hover demo](logo.png)

---

## Features

- **Hover tooltip** — shows all parameters defined in the referenced template
- **Required parameter highlighting** — parameters marked with `# REQUIRED` above their `- name:` line are shown in a configurable color (default: red)
- **Cross-repository template support** — resolves `@alias` references using `resources.repositories` declarations (see below)
- **Zero dependencies** — no `npm install` needed; works straight from the marketplace
- **Supports all path styles:**
  - Relative: `- template: templates/build.yml` (resolved from the current file's directory)
  - Absolute from repo root: `- template: /shared/templates/build.yml`
  - Cross-repo: `- template: stages/build.yml@templates` (resolved from a sibling directory on disk)

---

## How it works

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

## Cross-repository templates

Azure Pipelines lets you reference templates from other repositories using the `@alias` syntax.
The extension resolves these references automatically by reading the `resources.repositories`
block in the same file.

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
1. Reads the `resources.repositories` block and builds an alias → repo-name map
   (`templates` → `shared-templates`)
2. Resolves the template path as **`{repo-root}/../shared-templates/stages/build.yml`**
   (one level above the current repo root, next to it on disk)

### Setup

Clone the external repository **next to** your current workspace:

```
parent-directory/
├── your-pipeline-repo/     ← your workspace (open in VS Code)
│   └── pipelines/azure-pipelines.yml
└── shared-templates/       ← clone the template repo here
    └── stages/build.yml
```

The hover tooltip will show the template's parameters and a **🔗 External repository** badge.
If the sibling directory doesn't exist yet, the tooltip shows a helpful message telling you
which repo to clone.

### Unknown alias

If you hover over a `@alias` reference that has no matching entry in `resources.repositories`,
the tooltip explains what to add:

> ⚠️ Repository alias not found: `@templates`
> Add a `resources.repositories` entry with `repository: templates` to enable cross-repo template resolution.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `azure-templates-navigator.requiredParameterColor` | `#c92d35` | Hex color for required parameter names in the hover tooltip |

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
5. Open `samples/azure-pipelines.yml` and hover over any `- template:` line
6. You should see the parameter tooltip immediately

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
- Template references using variables (e.g. `- template: ${{ variables.templatePath }}`) are not resolved
- Cross-repo resolution assumes the sibling repo is cloned locally; remote-only repos are not fetched automatically

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## Support

[Buy me a merdenea ☕](https://ko-fi.com/bogdanbujor)
