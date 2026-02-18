'use strict';

/**
 * Unit tests for hoverProvider.js
 *
 * These tests exercise the pure functions that do NOT require a live VS Code
 * instance (parseParameters, parseRepositoryAliases, resolveTemplatePath).
 * They run inside the VS Code extension host via @vscode/test-electron so the
 * `vscode` module is available, but we deliberately avoid calling any VS Code
 * UI APIs here so the tests stay fast and deterministic.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');

const {
  parseParameters,
  parseRepositoryAliases,
  resolveTemplatePath,
} = require('../../hoverProvider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise path separators so tests pass on Windows too. */
const norm = (p) => p.split(path.sep).join('/');

// A fake "current file" that lives inside a repo whose root we control.
// We use os.tmpdir() so the path always exists on disk.
const FAKE_REPO_ROOT = path.join(os.tmpdir(), 'fake-repo');
const FAKE_CURRENT_FILE = path.join(FAKE_REPO_ROOT, 'pipelines', 'azure-pipelines.yml');

// ---------------------------------------------------------------------------
// parseParameters
// ---------------------------------------------------------------------------

suite('parseParameters', () => {

  test('returns empty array when no parameters block', () => {
    const yaml = `
stages:
  - stage: Build
`;
    assert.deepStrictEqual(parseParameters(yaml), []);
  });

  test('parses a single parameter with type and default', () => {
    const yaml = `
parameters:
  - name: buildConfig
    type: string
    default: Release
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 1);
    assert.strictEqual(params[0].name, 'buildConfig');
    assert.strictEqual(params[0].type, 'string');
    assert.strictEqual(params[0].default, 'Release');
    assert.strictEqual(params[0].required, false);
  });

  test('parses multiple parameters', () => {
    const yaml = `
parameters:
  - name: environment
    type: string
    default: dev
  - name: version
    type: number
    default: 1
  - name: enabled
    type: boolean
    default: true
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 3);
    assert.strictEqual(params[0].name, 'environment');
    assert.strictEqual(params[1].name, 'version');
    assert.strictEqual(params[1].type, 'number');
    assert.strictEqual(params[2].name, 'enabled');
    assert.strictEqual(params[2].type, 'boolean');
  });

  test('marks parameter as required when preceded by # REQUIRED comment', () => {
    const yaml = `
parameters:
  # REQUIRED
  - name: subscriptionId
    type: string
  - name: region
    type: string
    default: eastus
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 2);
    assert.strictEqual(params[0].name, 'subscriptionId');
    assert.strictEqual(params[0].required, true);
    assert.strictEqual(params[1].name, 'region');
    assert.strictEqual(params[1].required, false);
  });

  test('# required comment is case-insensitive', () => {
    const yaml = `
parameters:
  # required
  - name: apiKey
    type: string
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params[0].required, true);
  });

  test('parameter without default has undefined default', () => {
    const yaml = `
parameters:
  - name: noDefault
    type: string
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params[0].default, undefined);
  });

  test('defaults to type "string" when type is omitted', () => {
    const yaml = `
parameters:
  - name: implicitString
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params[0].type, 'string');
  });

  test('stops parsing parameters when a new top-level key is encountered', () => {
    const yaml = `
parameters:
  - name: p1
    type: string

stages:
  - stage: Build
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 1);
  });
});

// ---------------------------------------------------------------------------
// parseRepositoryAliases
// ---------------------------------------------------------------------------

suite('parseRepositoryAliases', () => {

  test('returns empty object when no resources block', () => {
    const yaml = `
stages:
  - stage: Build
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), {});
  });

  test('returns empty object when resources has no repositories', () => {
    const yaml = `
resources:
  pipelines:
    - pipeline: myPipeline
      source: upstream
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), {});
  });

  test('parses a single repository alias', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: git
      name: myorg/shared-pipeline-templates
      ref: refs/heads/main
`;
    const aliases = parseRepositoryAliases(yaml);
    assert.deepStrictEqual(aliases, { templates: 'shared-pipeline-templates' });
  });

  test('parses multiple repository aliases', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      name: myorg/shared-pipeline-templates
    - repository: security
      name: myorg/security-templates
    - repository: infra
      name: myorg/infra-templates
`;
    const aliases = parseRepositoryAliases(yaml);
    assert.deepStrictEqual(aliases, {
      templates: 'shared-pipeline-templates',
      security: 'security-templates',
      infra: 'infra-templates',
    });
  });

  test('handles name without org prefix', () => {
    const yaml = `
resources:
  repositories:
    - repository: myrepo
      name: standalone-repo
`;
    const aliases = parseRepositoryAliases(yaml);
    assert.deepStrictEqual(aliases, { myrepo: 'standalone-repo' });
  });

  test('stops at next top-level key after resources', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      name: myorg/shared-templates

stages:
  - stage: Build
`;
    const aliases = parseRepositoryAliases(yaml);
    assert.deepStrictEqual(aliases, { templates: 'shared-templates' });
  });

  test('handles deep org path — uses only last segment', () => {
    const yaml = `
resources:
  repositories:
    - repository: lib
      name: org/sub/deep-repo-name
`;
    const aliases = parseRepositoryAliases(yaml);
    assert.deepStrictEqual(aliases, { lib: 'deep-repo-name' });
  });
});

// ---------------------------------------------------------------------------
// resolveTemplatePath
// ---------------------------------------------------------------------------

suite('resolveTemplatePath', () => {

  // We pass an empty repoAliases map for local-path tests so the function
  // never tries to look up an alias.
  const NO_ALIASES = {};

  test('returns null for empty ref', () => {
    const result = resolveTemplatePath('', FAKE_CURRENT_FILE, NO_ALIASES);
    assert.strictEqual(result, null);
  });

  test('resolves relative path from current file directory', () => {
    const result = resolveTemplatePath('templates/build.yml', FAKE_CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(
      norm(result.filePath),
      norm(path.join(FAKE_REPO_ROOT, 'pipelines', 'templates', 'build.yml'))
    );
    assert.strictEqual(result.repoName, null);
  });

  test('resolves absolute path (starting with /) from repo root', () => {
    // For this test the repo root is determined by findRepoRoot which walks up
    // looking for .git. Since FAKE_REPO_ROOT doesn't have .git, it falls back
    // to the start dir (pipelines/). We just verify the leading slash is stripped.
    const result = resolveTemplatePath('/stages/deploy.yml', FAKE_CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    // The path should NOT start with a double slash and should end with the template path
    assert.ok(norm(result.filePath).endsWith('stages/deploy.yml'));
    assert.strictEqual(result.repoName, null);
  });

  test('resolves cross-repo reference using alias map', () => {
    const aliases = { templates: 'shared-pipeline-templates' };
    const result = resolveTemplatePath('stages/build.yml@templates', FAKE_CURRENT_FILE, aliases);
    assert.ok(result);
    assert.strictEqual(result.repoName, 'shared-pipeline-templates');
    assert.ok(norm(result.filePath).endsWith('shared-pipeline-templates/stages/build.yml'));
  });

  test('cross-repo reference with leading slash in template path', () => {
    const aliases = { templates: 'shared-pipeline-templates' };
    const result = resolveTemplatePath('/stages/build.yml@templates', FAKE_CURRENT_FILE, aliases);
    assert.ok(result);
    // Leading slash should be stripped before joining
    assert.ok(norm(result.filePath).endsWith('shared-pipeline-templates/stages/build.yml'));
    // Should NOT contain double slashes
    assert.ok(!result.filePath.includes('//'));
  });

  test('cross-repo reference with unknown alias returns unknownAlias flag', () => {
    const result = resolveTemplatePath('stages/build.yml@unknown', FAKE_CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(result.unknownAlias, true);
    assert.strictEqual(result.alias, 'unknown');
    assert.strictEqual(result.filePath, null);
  });

  test('@self alias resolves as local path', () => {
    const result = resolveTemplatePath('templates/build.yml@self', FAKE_CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(result.repoName, null);
    assert.ok(norm(result.filePath).endsWith('templates/build.yml'));
    // Should NOT have unknownAlias flag
    assert.ok(!result.unknownAlias);
  });

  test('cross-repo path is placed one level above the repo root', () => {
    // Simulate a repo root that IS findable by using a path that has a known parent.
    // We use os.tmpdir() as the "parent of repo root".
    // FAKE_REPO_ROOT = os.tmpdir()/fake-repo  → parent = os.tmpdir()
    // Expected: os.tmpdir()/shared-pipeline-templates/stages/build.yml
    const aliases = { templates: 'shared-pipeline-templates' };
    const result = resolveTemplatePath('stages/build.yml@templates', FAKE_CURRENT_FILE, aliases);
    assert.ok(result);
    const expectedParent = path.dirname(FAKE_REPO_ROOT); // os.tmpdir()
    assert.ok(
      norm(result.filePath).startsWith(norm(expectedParent)),
      `Expected path to start with ${norm(expectedParent)}, got ${norm(result.filePath)}`
    );
  });

  test('null repoAliases treated as empty — unknown alias returned', () => {
    const result = resolveTemplatePath('stages/build.yml@templates', FAKE_CURRENT_FILE, null);
    assert.ok(result);
    assert.strictEqual(result.unknownAlias, true);
  });
});
