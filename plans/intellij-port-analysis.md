# IntelliJ Port Analysis — Azure Templates Navigator

## Executive Summary

Porting the Azure Templates Navigator to IntelliJ is **feasible but requires significant platform-specific work**. The good news: a meaningful portion of the core logic is already platform-agnostic. The bad news: IntelliJ plugins are written in Kotlin/Java (JVM), so the JavaScript code cannot be directly reused — it must be **rewritten** in Kotlin.

However, the **algorithms and parsing logic** are the true intellectual property here, and those translate cleanly. The VS Code API surface area (hover, completion, diagnostics, tree views, webviews) has direct IntelliJ equivalents.

---

## Current Architecture Audit

### What's Platform-Agnostic (Pure Logic)

These functions contain **zero VS Code imports** and are pure Node.js/JavaScript:

| Function | File | What it does |
|---|---|---|
| `parseParameters()` | `hoverProvider.js` | Parses YAML template parameter blocks |
| `parseRepositoryAliases()` | `hoverProvider.js` | Parses `resources.repositories` for cross-repo aliases |
| `parseVariables()` | `hoverProvider.js` | Parses pipeline `variables:` block |
| `parsePassedParameters()` | `hoverProvider.js` | Parses parameters passed at a template call site |
| `findOwningTemplateLine()` | `hoverProvider.js` | Walks up from cursor to find enclosing `- template:` line |
| `findRepoRoot()` | `hoverProvider.js` | Finds `.git` root directory |
| `resolveTemplatePath()` | `hoverProvider.js` | Resolves template references to absolute file paths |
| `resolveLocalPath()` | `hoverProvider.js` | Resolves local template paths |
| `inferValueType()` | `diagnosticProvider.js` | Infers YAML scalar type for type-checking |
| `validateCallSite()` | `diagnosticProvider.js` | Validates a single template call site |
| `findEnclosingTemplate()` | `completionProvider.js` | Finds enclosing template for completion |
| `isCursorInParametersBlock()` | `completionProvider.js` | Checks if cursor is in parameters block |
| `collectYamlFiles()` | `graphDataBuilder.js` | Recursively collects YAML files |
| `isPipelineRoot()` | `graphDataBuilder.js` | Detects pipeline root files |
| `extractTemplateRefs()` | `graphDataBuilder.js` | Extracts template references from a file |
| `buildWorkspaceGraph()` | `graphDataBuilder.js` | Builds workspace-wide graph data |
| `buildFileGraph()` | `graphDataBuilder.js` | Builds file-scoped graph data |

**~60-65% of the total logic is platform-agnostic parsing/resolution.**

### What's VS Code-Specific (Must Be Rewritten)

| Component | VS Code API Used | IntelliJ Equivalent |
|---|---|---|
| Hover provider | `vscode.HoverProvider`, `vscode.MarkdownString` | `DocumentationProvider` or `AbstractDocumentationProvider` |
| Definition provider | `vscode.DefinitionProvider`, `vscode.Location` | `GotoDeclarationHandler` |
| Completion provider | `vscode.CompletionItemProvider`, `vscode.CompletionItem`, `vscode.SnippetString` | `CompletionContributor` + `CompletionProvider` |
| Diagnostic provider | `vscode.DiagnosticCollection`, `vscode.Diagnostic` | `ExternalAnnotator` or `LocalInspectionTool` |
| Tree view | `vscode.TreeDataProvider`, `vscode.TreeItem` | `ToolWindowFactory` + custom tree model |
| WebView graph | `vscode.WebviewViewProvider`, D3.js | `JBCefBrowser` (embedded Chromium) or custom Swing/JCEF panel |
| Diagnostics panel | `vscode.TreeDataProvider` | `ToolWindowFactory` + custom tree model |
| Commands | `vscode.commands.registerCommand` | `AnAction` subclasses |
| Configuration | `vscode.workspace.getConfiguration` | `PersistentStateComponent` + Settings UI |
| File watching | `vscode.workspace.createFileSystemWatcher` | `VirtualFileListener` / `BulkFileListener` |
| Extension lifecycle | `activate()` / `deactivate()` | Plugin `<extensions>` in `plugin.xml` |

---

## Approach Options

### Option A: Monorepo with Shared Logic via Language Server Protocol (LSP)

```
azure-templates-navigator/
├── core/                    # Shared Node.js logic (LSP server)
│   ├── src/
│   │   ├── parser.js        # parseParameters, parseVariables, etc.
│   │   ├── resolver.js      # resolveTemplatePath, findRepoRoot, etc.
│   │   ├── validator.js     # validateCallSite, inferValueType, etc.
│   │   ├── graph.js         # buildWorkspaceGraph, buildFileGraph, etc.
│   │   └── server.js        # LSP server entry point
│   └── package.json
├── vscode/                  # VS Code client (thin wrapper)
│   ├── extension.js
│   ├── package.json
│   └── ...
└── intellij/                # IntelliJ client (thin wrapper)
    ├── src/main/kotlin/
    ├── build.gradle.kts
    └── ...
```

**Pros:**
- Single source of truth for parsing/validation logic
- Bug fixes in core benefit both platforms
- LSP is an industry standard — could support other editors too (Neovim, Sublime, etc.)

**Cons:**
- Requires Node.js runtime on the user's machine for IntelliJ (unusual for JetBrains plugins)
- LSP adds latency (IPC overhead) vs. in-process calls
- LSP protocol doesn't natively support tree views or webviews — those still need platform-specific code
- Significant refactoring of the existing VS Code extension to extract core into LSP
- More complex development/debugging setup

### Option B: Separate Kotlin Rewrite (Recommended)

```
azure-templates-navigator/           # Existing VS Code extension (unchanged)
├── extension.js
├── hoverProvider.js
├── ...

azure-templates-intellij/            # New IntelliJ plugin (separate repo)
├── src/main/kotlin/
│   ├── core/
│   │   ├── ParameterParser.kt       # Port of parseParameters()
│   │   ├── RepositoryAliasParser.kt # Port of parseRepositoryAliases()
│   │   ├── VariableParser.kt        # Port of parseVariables()
│   │   ├── TemplateResolver.kt      # Port of resolveTemplatePath()
│   │   ├── CallSiteValidator.kt     # Port of validateCallSite()
│   │   └── GraphBuilder.kt          # Port of buildWorkspaceGraph()
│   ├── providers/
│   │   ├── TemplateHoverProvider.kt
│   │   ├── TemplateCompletionProvider.kt
│   │   ├── TemplateGotoDeclarationHandler.kt
│   │   ├── TemplateInspection.kt
│   │   └── TemplateLineMarkerProvider.kt
│   ├── ui/
│   │   ├── TemplateDependencyToolWindow.kt
│   │   ├── TemplateGraphToolWindow.kt
│   │   └── DiagnosticsPanelToolWindow.kt
│   └── settings/
│       └── PluginSettings.kt
├── src/main/resources/
│   ├── META-INF/plugin.xml
│   └── ...
├── src/test/kotlin/
│   └── ...
└── build.gradle.kts
```

**Pros:**
- Native JVM performance — no Node.js dependency
- Idiomatic IntelliJ plugin — follows JetBrains conventions
- No runtime dependency on external processes
- Simpler deployment (single JAR)
- Can leverage IntelliJ's built-in YAML PSI (parse tree) instead of regex parsing
- Each plugin evolves independently — IntelliJ-specific features can diverge

**Cons:**
- Core logic must be rewritten in Kotlin (one-time cost)
- Bug fixes must be applied to both codebases
- Feature parity requires discipline

### Option C: Shared Core in Kotlin Multiplatform (Hybrid)

Use Kotlin Multiplatform to share core logic, with platform-specific UI layers.

**Verdict:** Overly complex. KMP targets JVM and JS, but the VS Code extension is CommonJS — bridging KMP-JS into a VS Code extension adds more complexity than it saves.

---

## Recommendation: Option B (Separate Kotlin Rewrite, Separate Repo)

### Why Separate Repo?

1. **Different build systems:** VS Code uses `npm`/`vsce`; IntelliJ uses Gradle + `intellij-platform-plugin`
2. **Different CI/CD:** VS Code publishes to VS Code Marketplace; IntelliJ publishes to JetBrains Marketplace
3. **Different release cadences:** IntelliJ platform updates frequently; VS Code extension API is more stable
4. **Different testing:** VS Code uses `@vscode/test-electron`; IntelliJ uses `intellij-test-framework`
5. **Clean separation of concerns:** Contributors to one platform don't need the other's toolchain
6. **Repo size:** IntelliJ plugins pull in large Gradle dependencies; no reason to bloat the VS Code repo

### Why NOT a Monorepo?

A monorepo would work technically, but:
- The two plugins share **zero runtime code** (different languages)
- CI would need to build both on every commit (wasteful)
- Contributors would be confused by the dual structure
- JetBrains and VS Code marketplace metadata are completely different

---

## Feature Mapping: VS Code → IntelliJ

| # | VS Code Feature | IntelliJ Equivalent | Complexity |
|---|---|---|---|
| 1 | Hover tooltip on `template:` lines | `DocumentationProvider.generateDoc()` | Medium |
| 2 | Go-to-definition (F12/Cmd+Click) | `GotoDeclarationHandler` or `PsiReference.resolve()` | Medium |
| 3 | IntelliSense completion for parameters | `CompletionContributor` + `CompletionProvider` | Medium |
| 4 | Diagnostics (squiggly lines) | `LocalInspectionTool` or `ExternalAnnotator` | Medium |
| 5 | Template dependency tree view | `ToolWindowFactory` + JTree | Medium-High |
| 6 | Interactive D3 graph | `JBCefBrowser` (embedded Chromium) with same D3 code | Medium |
| 7 | Diagnostics panel | `ToolWindowFactory` + JTree | Medium |
| 8 | Configuration settings | `Configurable` + `PersistentStateComponent` | Low |
| 9 | File watching for live updates | `BulkFileListener` + `VirtualFileManager` | Low |
| 10 | Commands (refresh, open, copy) | `AnAction` subclasses registered in `plugin.xml` | Low |

### Key Advantage for IntelliJ

IntelliJ has a **built-in YAML PSI parser** (via the YAML plugin bundled with all JetBrains IDEs). This means:
- No need for regex-based YAML parsing — use the PSI tree directly
- More robust parsing (handles edge cases the regex approach might miss)
- Native support for YAML-aware code navigation, folding, etc.
- `PsiReference` system gives you go-to-definition "for free" once references are resolved

### The D3 Graph Can Be Reused

The `media/graph.js` and `media/d3.min.js` files can be **reused as-is** in the IntelliJ plugin via `JBCefBrowser` (JetBrains' embedded Chromium). The HTML/CSS/JS for the graph visualization is platform-independent — only the host-to-webview messaging protocol needs adaptation.

---

## Architecture Diagram

```mermaid
graph TB
    subgraph VSCode Extension - JavaScript
        VSC_EXT[extension.js]
        VSC_HOVER[hoverProvider.js]
        VSC_DIAG[diagnosticProvider.js]
        VSC_COMP[completionProvider.js]
        VSC_TREE[treeViewProvider.js]
        VSC_GRAPH[graphWebViewProvider.js]
        VSC_GDATA[graphDataBuilder.js]
        VSC_DPANEL[diagnosticsPanelProvider.js]
    end

    subgraph IntelliJ Plugin - Kotlin
        IJ_CORE[core/]
        IJ_PARSE[ParameterParser.kt]
        IJ_RESOLVE[TemplateResolver.kt]
        IJ_VALIDATE[CallSiteValidator.kt]
        IJ_GBUILD[GraphBuilder.kt]
        
        IJ_PROV[providers/]
        IJ_HOVER[TemplateHoverProvider.kt]
        IJ_GOTO[TemplateGotoHandler.kt]
        IJ_COMPL[TemplateCompletionProvider.kt]
        IJ_INSP[TemplateInspection.kt]
        
        IJ_UI[ui/]
        IJ_TREEUI[DependencyToolWindow.kt]
        IJ_GRAPHUI[GraphToolWindow.kt]
        IJ_DIAGUI[DiagnosticsToolWindow.kt]
    end

    subgraph Shared Assets
        D3[d3.min.js + graph.js]
    end

    VSC_GRAPH --> D3
    IJ_GRAPHUI --> D3

    style VSCode Extension - JavaScript fill:#2d6a9f,color:#fff
    style IntelliJ Plugin - Kotlin fill:#6b4fa0,color:#fff
    style Shared Assets fill:#3d8a5e,color:#fff
```

---

## Summary

| Question | Answer |
|---|---|
| Rebuild from ground up? | **Partially.** Core parsing/resolution logic must be rewritten in Kotlin, but the algorithms are identical. UI layer is fully new. |
| Feature duplication? | **Yes, but manageable.** The core logic is ~60% of the work and translates 1:1. The UI layer is platform-specific by nature. |
| Same repo or separate? | **Separate repos recommended.** Different languages, build systems, CI/CD, and marketplaces. |
| Can anything be literally shared? | **Yes — the D3 graph visualization** (HTML/CSS/JS) can be reused verbatim via JBCefBrowser. |
| Biggest risk? | Feature drift over time. Mitigate with shared test fixtures and a feature parity checklist. |
