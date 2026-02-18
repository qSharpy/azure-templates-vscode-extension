# Change Log

All notable changes to the Azure Templates Navigator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
