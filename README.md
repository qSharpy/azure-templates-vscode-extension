# Azure Templates Navigator

Hover over any `- template:` reference in an Azure Pipelines YAML file to instantly see the template's parameters — which are required, their types, and their default values.

![hover demo](logo.png)

---

## Features

- **Hover tooltip** — shows all parameters defined in the referenced template
- **Required parameter highlighting** — parameters marked with `# REQUIRED` above their `- name:` line are shown in a configurable color (default: red)
- **Zero dependencies** — no `npm install` needed; works straight from the marketplace
- **Supports both path styles:**
  - Relative: `- template: templates/build.yml` (resolved from the current file's directory)
  - Absolute from workspace root: `- template: /shared/templates/build.yml`

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

## Known Limitations

- Only parses `parameters:` blocks at the top level of the template file
- Template references using variables (e.g. `- template: ${{ variables.templatePath }}`) are not resolved

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## Support

[Buy me a merdenea ☕](https://ko-fi.com/bogdanbujor)
