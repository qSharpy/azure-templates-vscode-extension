# CLAUDE.md — Azure Templates Navigator (IntelliJ Plugin)

## Project Overview

**Azure Templates Navigator** is an IntelliJ plugin for Azure Pipelines YAML development. It is a Kotlin port of the existing [VS Code extension](https://github.com/qSharpy/azure-templates-vscode-extension) and provides the same feature set: hover tooltips, parameter validation, IntelliSense autocomplete, variable hover, a template dependency tree view, and an interactive force-directed graph.

- **Plugin ID:** `com.bogdanbujor.azure-templates-navigator`
- **Language:** Kotlin
- **Build system:** Gradle with IntelliJ Platform Gradle Plugin 2.x
- **Target IDEs:** IntelliJ IDEA (Community & Ultimate), plus any JetBrains IDE with YAML support
- **Minimum platform version:** 2024.1+

> **Reference implementation:** The VS Code extension source lives at `../azure-templates-vscode-extension/`. Use it as an algorithm reference — do NOT copy JavaScript files into this repo.

---

## Project Structure

```
azure-templates-intellij/
├── CLAUDE.md                          # This file
├── build.gradle.kts                   # Gradle build with intellij-platform-gradle-plugin
├── settings.gradle.kts
├── gradle.properties                  # Plugin metadata, platform version
├── gradle/
│   └── wrapper/
├── src/
│   ├── main/
│   │   ├── kotlin/
│   │   │   └── com/bogdanbujor/azuretemplates/
│   │   │       ├── core/              # Platform-agnostic parsing & resolution
│   │   │       │   ├── ParameterParser.kt
│   │   │       │   ├── RepositoryAliasParser.kt
│   │   │       │   ├── VariableParser.kt
│   │   │       │   ├── PassedParameterParser.kt
│   │   │       │   ├── TemplateResolver.kt
│   │   │       │   ├── CallSiteValidator.kt
│   │   │       │   ├── GraphBuilder.kt
│   │   │       │   └── Models.kt      # Data classes shared across modules
│   │   │       ├── providers/         # IntelliJ extension points
│   │   │       │   ├── TemplateDocumentationProvider.kt
│   │   │       │   ├── TemplateGotoDeclarationHandler.kt
│   │   │       │   ├── TemplateCompletionContributor.kt
│   │   │       │   ├── TemplateInspection.kt
│   │   │       │   └── TemplateLineMarkerProvider.kt
│   │   │       ├── ui/               # Tool windows (sidebar panels)
│   │   │       │   ├── DependencyTreeToolWindow.kt
│   │   │       │   ├── GraphToolWindow.kt
│   │   │       │   └── DiagnosticsToolWindow.kt
│   │   │       ├── settings/         # Plugin configuration
│   │   │       │   ├── PluginSettings.kt
│   │   │       │   └── PluginSettingsConfigurable.kt
│   │   │       └── services/         # Project-level services
│   │   │           └── TemplateIndexService.kt
│   │   └── resources/
│   │       ├── META-INF/
│   │       │   └── plugin.xml         # Plugin descriptor
│   │       └── media/                 # D3 graph assets (reused from VS Code)
│   │           ├── d3.min.js
│   │           ├── graph.js           # Modified: replace acquireVsCodeApi with JBCef bridge
│   │           └── graph.html         # Standalone HTML (extracted from VS Code webview)
│   └── test/
│       ├── kotlin/
│       │   └── com/bogdanbujor/azuretemplates/
│       │       ├── core/              # Unit tests for parsing/resolution
│       │       │   ├── ParameterParserTest.kt
│       │       │   ├── TemplateResolverTest.kt
│       │       │   ├── CallSiteValidatorTest.kt
│       │       │   └── GraphBuilderTest.kt
│       │       └── providers/         # Integration tests
│       │           └── ...
│       └── resources/
│           └── fixtures/              # Shared test fixtures (copied from VS Code repo)
│               ├── main-repo/
│               │   ├── pipelines/
│               │   │   └── azure-pipelines.yml
│               │   └── templates/
│               │       └── local-template.yml
│               └── sibling-repo/
│                   └── stages/
│                       └── build.yml
└── samples/                           # Sample pipelines for manual testing
    ├── azure-pipelines.yml
    ├── cross-repo-pipeline.yml
    ├── jobs/
    ├── pipelines/
    ├── stages/
    └── templates/
```

---

## Build & Run

```bash
# Build the plugin
./gradlew build

# Run a sandboxed IDE with the plugin loaded
./gradlew runIde

# Run tests
./gradlew test

# Build distributable ZIP
./gradlew buildPlugin

# Publish to JetBrains Marketplace
./gradlew publishPlugin
```

---

## Core Module — Algorithm Reference

The `core/` package contains platform-agnostic logic ported from the VS Code extension's JavaScript. Each Kotlin file corresponds to functions in the VS Code source. **Use the VS Code source as the authoritative algorithm reference.**

### Models.kt — Shared Data Classes

```kotlin
data class TemplateParameter(
    val name: String,
    val type: String = "string",
    val default: String? = null,
    val required: Boolean = default == null,  // Azure Pipelines convention
    val line: Int = 0
)

data class PipelineVariable(
    val name: String,
    val value: String,
    val line: Int
)

data class VariableGroup(
    val name: String,
    val line: Int
)

data class ParsedVariables(
    val variables: Map<String, PipelineVariable>,
    val groups: List<VariableGroup>
)

data class ResolvedTemplate(
    val filePath: String?,
    val repoName: String? = null,
    val alias: String? = null,
    val unknownAlias: Boolean = false
)

data class TemplateCallSite(
    val templateRef: String,
    val line: Int
)

data class DiagnosticIssue(
    val message: String,
    val severity: IssueSeverity,
    val code: String,
    val line: Int,
    val startColumn: Int,
    val endColumn: Int
)

enum class IssueSeverity { ERROR, WARNING }

// Graph data
data class GraphNode(
    val id: String,
    val label: String,
    val relativePath: String? = null,
    val kind: NodeKind,
    val filePath: String? = null,
    val repoName: String? = null,
    val alias: String? = null,
    val paramCount: Int = 0,
    val requiredCount: Int = 0,
    val isScope: Boolean = false
)

enum class NodeKind { PIPELINE, LOCAL, EXTERNAL, MISSING, UNKNOWN }

data class GraphEdge(
    val source: String,
    val target: String,
    val label: String? = null,
    val direction: String? = null  // "upstream" or "downstream"
)

data class GraphData(
    val nodes: List<GraphNode>,
    val edges: List<GraphEdge>
)
```

### ParameterParser.kt

**Port of:** `parseParameters()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 25-105)

**Algorithm:**
1. Find the top-level `parameters:` block in YAML text
2. For each `- name: paramName` entry at the base indent level:
   - Scan forward for `type:` and `default:` sub-properties
   - A parameter is **required** when it has no `default:` key (Azure Pipelines convention)
3. Return list of `TemplateParameter`

**Key rules:**
- Only parse `parameters:` at the **top level** of the file
- Handle both CRLF and LF line endings
- `# comment` lines at column 0 are legal inside the parameters block — don't break on them
- `- name:` lines at column 0 are valid YAML — don't break on them
- Strip inline comments (`# ...`) from values

**IntelliJ advantage:** You MAY use IntelliJ's YAML PSI parser (`YAMLFile`, `YAMLMapping`, `YAMLSequence`) instead of regex. This would be more robust. However, the regex approach is simpler and matches the VS Code implementation exactly — choose based on your judgment.

### RepositoryAliasParser.kt

**Port of:** `parseRepositoryAliases()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 181-260)

**Algorithm:**
1. Find `resources:` → `repositories:` block
2. For each `- repository: alias` entry, find the `name: org/repo` sub-property
3. Extract the last segment after `/` as the repo folder name
4. Return `Map<String, String>` of alias → repo folder name

### VariableParser.kt

**Port of:** `parseVariables()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 284-364)

**Algorithm:**
1. Find top-level `variables:` block
2. Detect form: **map form** (`key: value`) or **list form** (`- name: key` / `- group: name`)
3. Parse accordingly, returning `ParsedVariables`

### PassedParameterParser.kt

**Port of:** `parsePassedParameters()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 382-435)

**Algorithm:**
1. Starting from a `- template:` line, scan forward for `parameters:` sub-block
2. Capture each `paramName: value` at the first indent level below `parameters:`
3. Return `Map<String, Pair<String, Int>>` (name → value + line number)

### TemplateResolver.kt

**Port of:** `resolveTemplatePath()`, `resolveLocalPath()`, `findRepoRoot()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 444-520)

**Algorithm:**
- `@alias` suffix → cross-repo: resolve as `{repoRoot}/../{repoName}/{path}`
- `@self` → treat as local
- Leading `/` → relative to repo root (nearest `.git` ancestor)
- Otherwise → relative to the current file's directory

**Also port:** `findOwningTemplateLine()` (lines 127-163) — walks up from cursor to find the enclosing `- template:` line.

### CallSiteValidator.kt

**Port of:** `validateCallSite()`, `inferValueType()` in `../azure-templates-vscode-extension/diagnosticProvider.js` (lines 23-170)

**Three checks:**
1. **Missing required parameters** — parameter has no default and is not passed → ERROR
2. **Unknown parameters** — passed parameter not declared in template → WARNING
3. **Type mismatches** — inferred value type doesn't match declared parameter type → WARNING

**Type inference rules:**
- `[` or `{` → object
- `true/false/yes/no/on/off` → boolean
- Numeric → number
- Quoted or `$` expressions → string (skip type checking for expressions)

### GraphBuilder.kt

**Port of:** `buildWorkspaceGraph()`, `buildFileGraph()`, `collectYamlFiles()`, `extractTemplateRefs()`, `isPipelineRoot()` in `../azure-templates-vscode-extension/graphDataBuilder.js`

**Algorithm:**
1. Recursively collect all `.yml`/`.yaml` files (skip `.git`, `node_modules`, etc.)
2. Pass 1: Register every YAML file as a node (detect pipeline roots by `trigger:`/`pr:`/`stages:` etc.)
3. Pass 2: For each file, resolve template references and create edges
4. Pass 3: Fill in `paramCount`/`requiredCount` for all nodes
5. Return `GraphData`

---

## Providers — IntelliJ Extension Points

### TemplateDocumentationProvider.kt

**IntelliJ API:** `com.intellij.lang.documentation.DocumentationProvider`

**Port of:** `hoverProvider.provideHover()` + `buildHoverMarkdown()` + `buildVariableHoverMarkdown()` in `../azure-templates-vscode-extension/hoverProvider.js`

**Behavior:**
1. On hover over a `template:` line → show parameter tooltip with types, defaults, required markers
2. On hover over `$(varName)` or `${{ variables.varName }}` → show variable value/source
3. Include "Open" and "Open to Side" navigation links (use IntelliJ's `NavigationGutterIconBuilder` or action links)

**Registration in plugin.xml:**
```xml
<lang.documentationProvider language="yaml"
    implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateDocumentationProvider"/>
```

### TemplateGotoDeclarationHandler.kt

**IntelliJ API:** `com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler`

**Port of:** `definitionProvider.provideDefinition()` in `../azure-templates-vscode-extension/hoverProvider.js` (lines 727-828)

**Behavior:**
1. Cmd+Click on a `template:` line → open the template file at line 0
2. Cmd+Click on a parameter key inside a `parameters:` block → open the template file and jump to the matching `- name:` line

**Registration in plugin.xml:**
```xml
<gotoDeclarationHandler
    implementation="com.bogdanbujor.azuretemplates.providers.TemplateGotoDeclarationHandler"/>
```

### TemplateCompletionContributor.kt

**IntelliJ API:** `com.intellij.codeInsight.completion.CompletionContributor` + `CompletionProvider`

**Port of:** `completionProvider.provideCompletionItems()` in `../azure-templates-vscode-extension/completionProvider.js`

**Behavior:**
1. When typing inside a `parameters:` block under a `- template:` line
2. Resolve the template file, parse its declared parameters
3. Offer completion items for each parameter not yet typed
4. Required parameters sort first, already-set parameters sort last
5. Insert text: `paramName: ` with cursor after the colon

**Registration in plugin.xml:**
```xml
<completion.contributor language="yaml"
    implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateCompletionContributor"/>
```

### TemplateInspection.kt

**IntelliJ API:** `com.intellij.codeInspection.LocalInspectionTool`

**Port of:** `getDiagnosticsForDocument()` + `validateCallSite()` in `../azure-templates-vscode-extension/diagnosticProvider.js`

**Behavior:**
1. Scan the YAML file for all `- template:` lines
2. For each call site, validate: missing required params, unknown params, type mismatches
3. Register problems via `ProblemsHolder.registerProblem()`

**Registration in plugin.xml:**
```xml
<localInspection language="yaml"
    groupName="Azure Templates Navigator"
    displayName="Template parameter validation"
    enabledByDefault="true"
    level="ERROR"
    implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateInspection"/>
```

### TemplateLineMarkerProvider.kt (Optional Enhancement)

**IntelliJ API:** `com.intellij.codeInsight.daemon.LineMarkerProvider`

**Not in VS Code version.** IntelliJ-specific enhancement: show gutter icons on `- template:` lines for quick navigation. This is idiomatic in JetBrains IDEs.

---

## UI — Tool Windows

### DependencyTreeToolWindow.kt

**IntelliJ API:** `com.intellij.openapi.wm.ToolWindowFactory` + `javax.swing.JTree`

**Port of:** `treeViewProvider.js` in `../azure-templates-vscode-extension/treeViewProvider.js`

**Behavior:**
- Shows template dependency tree for the active YAML file
- Root level: "Called by" group (upstream callers) + focal file node
- Expanding a node shows its downstream template references
- Cycle detection (show ↩ icon)
- Click to open file, right-click for context menu (Open to Side, Copy Path)
- Auto-refreshes when active editor changes

**Registration in plugin.xml:**
```xml
<toolWindow id="Azure Templates"
    anchor="right"
    factoryClass="com.bogdanbujor.azuretemplates.ui.DependencyTreeToolWindow"
    icon="AllIcons.Nodes.TreeOpen"/>
```

### GraphToolWindow.kt

**IntelliJ API:** `com.intellij.openapi.wm.ToolWindowFactory` + `com.intellij.ui.jcef.JBCefBrowser`

**Port of:** `graphWebViewProvider.js` in `../azure-templates-vscode-extension/graphWebViewProvider.js`

**Behavior:**
- Embeds the D3 force-directed graph in a JBCefBrowser (Chromium)
- Reuses `media/graph.js`, `media/d3.min.js`, and `media/graph.html`
- Communication: replace `acquireVsCodeApi()` with JBCef's `CefMessageRouter` / `JBCefJSQuery`
- Supports: file-scope mode, path filtering, search, zoom, fit, reset, expand to editor panel
- Node click → open file in editor
- Node right-click → context menu (Open, Open to Side, Copy Path)

**JBCef messaging bridge:**

In the VS Code version, `graph.js` uses:
```javascript
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'openFile', filePath: '...' });
```

For IntelliJ, replace with:
```javascript
// graph.js (IntelliJ version)
const bridge = {
  postMessage(msg) {
    // JBCefJSQuery callback — injected by Kotlin host
    window.__intellijBridge(JSON.stringify(msg));
  }
};
```

And in Kotlin:
```kotlin
val jsQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
jsQuery.addHandler { jsonMsg ->
    val msg = Json.parseToJsonElement(jsonMsg)
    // Handle openFile, copyPath, etc.
    null
}
// Inject the bridge function into the page
browser.cefBrowser.executeJavaScript(
    "window.__intellijBridge = function(msg) { ${jsQuery.inject("msg")} };",
    "", 0
)
```

### DiagnosticsToolWindow.kt

**IntelliJ API:** `com.intellij.openapi.wm.ToolWindowFactory` + `javax.swing.JTree`

**Port of:** `diagnosticsPanelProvider.js` in `../azure-templates-vscode-extension/diagnosticsPanelProvider.js`

**Behavior:**
- Shows all template diagnostics grouped by file
- File nodes show error/warning counts
- Issue nodes show line:col, message, and severity icon
- Click to navigate to the exact location
- Auto-updates when diagnostics change

---

## Settings

### PluginSettings.kt

**IntelliJ API:** `com.intellij.openapi.components.PersistentStateComponent`

**Port of:** VS Code `contributes.configuration` in `package.json`

| Setting | Type | Default | Description |
|---|---|---|---|
| `requiredParameterColor` | String (hex) | `#c92d35` | Color for required parameters in hover tooltip |
| `diagnosticsEnabled` | Boolean | `true` | Enable/disable parameter validation |
| `diagnosticsDebounceMs` | Int | `500` | Debounce delay for diagnostics (100-5000) |
| `graphRootPath` | String | `""` | Sub-directory to scope the graph (workspace-scoped) |

### PluginSettingsConfigurable.kt

**IntelliJ API:** `com.intellij.openapi.options.Configurable`

Provides a Settings UI panel under **Settings → Tools → Azure Templates Navigator**.

---

## Services

### TemplateIndexService.kt

**IntelliJ API:** `com.intellij.openapi.project.Project` service

A project-level service that:
1. Maintains a cached index of all YAML files and their template references
2. Listens for file changes via `BulkFileListener`
3. Provides fast lookups for upstream callers, downstream dependencies
4. Feeds data to the tree view, graph, and diagnostics panel

---

## plugin.xml Structure

```xml
<idea-plugin>
    <id>com.bogdanbujor.azure-templates-navigator</id>
    <name>Azure Templates Navigator</name>
    <vendor email="..." url="https://github.com/qSharpy">bogdanbujor</vendor>
    <description>
        Hover over Azure Pipeline template references to see parameters.
        Click to navigate. Validates parameters, provides autocomplete,
        variable hover, dependency tree, and interactive template graph.
    </description>

    <depends>com.intellij.modules.platform</depends>
    <depends>org.jetbrains.plugins.yaml</depends>

    <extensions defaultExtensionNs="com.intellij">
        <!-- Documentation (hover) -->
        <lang.documentationProvider language="yaml"
            implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateDocumentationProvider"/>

        <!-- Go-to-declaration -->
        <gotoDeclarationHandler
            implementation="com.bogdanbujor.azuretemplates.providers.TemplateGotoDeclarationHandler"/>

        <!-- Completion -->
        <completion.contributor language="yaml"
            implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateCompletionContributor"/>

        <!-- Inspection (diagnostics) -->
        <localInspection language="yaml"
            groupName="Azure Templates Navigator"
            displayName="Template parameter validation"
            enabledByDefault="true"
            level="ERROR"
            implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateInspection"/>

        <!-- Line markers (gutter icons) -->
        <codeInsight.lineMarkerProvider language="yaml"
            implementationClass="com.bogdanbujor.azuretemplates.providers.TemplateLineMarkerProvider"/>

        <!-- Tool windows -->
        <toolWindow id="Azure Templates - Dependencies"
            anchor="right"
            factoryClass="com.bogdanbujor.azuretemplates.ui.DependencyTreeToolWindow"
            icon="AllIcons.Nodes.TreeOpen"/>

        <toolWindow id="Azure Templates - Graph"
            anchor="right"
            factoryClass="com.bogdanbujor.azuretemplates.ui.GraphToolWindow"
            icon="AllIcons.Nodes.DataTables"/>

        <toolWindow id="Azure Templates - Diagnostics"
            anchor="bottom"
            factoryClass="com.bogdanbujor.azuretemplates.ui.DiagnosticsToolWindow"
            icon="AllIcons.General.InspectionsEye"/>

        <!-- Settings -->
        <applicationConfigurable
            parentId="tools"
            instance="com.bogdanbujor.azuretemplates.settings.PluginSettingsConfigurable"
            id="com.bogdanbujor.azuretemplates.settings"
            displayName="Azure Templates Navigator"/>

        <applicationService
            serviceImplementation="com.bogdanbujor.azuretemplates.settings.PluginSettings"/>

        <!-- Project service -->
        <projectService
            serviceImplementation="com.bogdanbujor.azuretemplates.services.TemplateIndexService"/>
    </extensions>

    <actions>
        <group id="AzureTemplatesNavigator.ToolbarActions" text="Azure Templates Navigator">
            <action id="AzureTemplatesNavigator.RefreshTree"
                class="com.bogdanbujor.azuretemplates.actions.RefreshTreeAction"
                text="Refresh Template Tree"
                icon="AllIcons.Actions.Refresh"/>
            <action id="AzureTemplatesNavigator.RefreshGraph"
                class="com.bogdanbujor.azuretemplates.actions.RefreshGraphAction"
                text="Refresh Template Graph"
                icon="AllIcons.Actions.Refresh"/>
            <action id="AzureTemplatesNavigator.RefreshDiagnostics"
                class="com.bogdanbujor.azuretemplates.actions.RefreshDiagnosticsAction"
                text="Refresh Diagnostics"
                icon="AllIcons.Actions.Refresh"/>
        </group>
    </actions>
</idea-plugin>
```

---

## build.gradle.kts Skeleton

```kotlin
plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "com.bogdanbujor"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
        bundledPlugin("org.jetbrains.plugins.yaml")
        instrumentationTools()
    }
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(17)
}

intellijPlatform {
    pluginConfiguration {
        name = "Azure Templates Navigator"
        ideaVersion {
            sinceBuild = "241"
        }
    }
}
```

---

## Testing

### Unit Tests

Test the `core/` package functions with plain JUnit — no IntelliJ platform needed:

```kotlin
class ParameterParserTest {
    @Test
    fun `parses parameters with types and defaults`() {
        val yaml = """
            parameters:
              - name: environment
                type: string
              - name: vmImage
                type: string
                default: 'ubuntu-latest'
        """.trimIndent()

        val params = ParameterParser.parse(yaml)
        assertEquals(2, params.size)
        assertTrue(params[0].required)
        assertFalse(params[1].required)
        assertEquals("ubuntu-latest", params[1].default)
    }
}
```

### Test Fixtures

Copy from `../azure-templates-vscode-extension/test/fixtures/` and `../azure-templates-vscode-extension/samples/` to ensure parity.

### Integration Tests

Use IntelliJ's test framework (`BasePlatformTestCase`) for provider tests:

```kotlin
class TemplateCompletionTest : BasePlatformTestCase() {
    override fun getTestDataPath() = "src/test/resources/fixtures"

    fun testCompletesTemplateParameters() {
        myFixture.configureByFile("main-repo/pipelines/azure-pipelines.yml")
        myFixture.completeBasic()
        val lookupStrings = myFixture.lookupElementStrings
        assertNotNull(lookupStrings)
        assertTrue(lookupStrings!!.contains("environment"))
    }
}
```

---

## YAML Template Convention

Required parameters are identified by the **absence of a `default:` key** — this matches Azure Pipelines runtime behavior exactly. The VS Code extension also supports a `# REQUIRED` comment convention for display purposes, but the primary detection is default-based.

```yaml
parameters:
  # This is required (no default)
  - name: environment
    type: string
  # This is optional (has default)
  - name: vmImage
    type: string
    default: 'ubuntu-latest'
```

---

## Cross-Repo Template Resolution

Templates referenced as `template: path/file.yml@alias` are resolved by:
1. Reading `resources.repositories` in the same pipeline file to build an `alias → repo-name` map
2. Resolving the path as `{repoRoot}/../{repo-name}/{template-path}` on the local filesystem
3. `@self` is treated as a local reference

This requires the sibling repo to be cloned locally — remote-only repos are not fetched.

---

## D3 Graph — JBCef Integration Notes

The D3 graph visualization from the VS Code extension can be reused with minimal changes:

1. **Extract the HTML** from `graphWebViewProvider.js`'s `_getHtmlForWebview()` method into a standalone `graph.html` file
2. **Replace `acquireVsCodeApi()`** in `graph.js` with a JBCef bridge (see GraphToolWindow section above)
3. **Remove the CSP nonce** — JBCef doesn't need it
4. **Replace VS Code CSS variables** (`--vscode-*`) with IntelliJ's JCEF theme bridge or hardcoded dark/light theme colors
5. **Message protocol is identical** — the `type`/`filePath`/`text` message format stays the same

---

## Implementation Order

Build in this order to get a working plugin as early as possible:

1. **Gradle scaffold + plugin.xml** — get `runIde` working with an empty plugin
2. **Core parsers** — ParameterParser, RepositoryAliasParser, VariableParser, PassedParameterParser
3. **TemplateResolver** — file resolution logic
4. **TemplateDocumentationProvider** — hover tooltips (first visible feature)
5. **TemplateGotoDeclarationHandler** — Cmd+Click navigation
6. **TemplateCompletionContributor** — autocomplete
7. **CallSiteValidator + TemplateInspection** — diagnostics
8. **DependencyTreeToolWindow** — sidebar tree
9. **GraphToolWindow** — D3 graph via JBCef
10. **DiagnosticsToolWindow** — diagnostics panel
11. **Settings** — configuration UI
12. **Tests** — unit + integration
13. **TemplateLineMarkerProvider** — gutter icons (IntelliJ-only enhancement)

---

## Known Limitations (Inherited from VS Code Version)

- Only parses `parameters:` blocks at the **top level** of a template file
- Template references using variables (e.g. `${{ variables.templatePath }}`) are skipped
- Cross-repo resolution requires the sibling repo to be cloned locally
- Variable group contents are not resolved (requires Azure DevOps connection)
- Type checking for `object`, `step`, `job`, `stage` parameter types is limited
