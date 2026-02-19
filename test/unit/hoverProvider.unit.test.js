'use strict';

/**
 * Pure-Node unit tests for hoverProvider.js
 *
 * Tests the three exported pure functions:
 *   - parseParameters
 *   - parseRepositoryAliases
 *   - resolveTemplatePath
 *
 * Fixture layout (relative to project root):
 *
 *   test/fixtures/
 *     main-repo/
 *       .git/HEAD          ← makes findRepoRoot() stop here
 *       pipelines/
 *         azure-pipelines.yml   ← the "current file" in tests
 *       templates/
 *         local-template.yml    ← local template for relative-path tests
 *     sibling-repo/
 *       stages/
 *         build.yml             ← external template for cross-repo tests
 *
 * Run with:  npx mocha test/unit/hoverProvider.unit.test.js
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ---------------------------------------------------------------------------
// Stub the 'vscode' module before requiring hoverProvider.
// Only the hoverProvider *object* (provideHover) uses vscode APIs.
// The three pure functions we test never touch vscode.
// ---------------------------------------------------------------------------
const Module = require('module');
const _orig  = Module._load;
// eslint-disable-next-line no-unused-vars
Module._load  = function (request) {
  if (request === 'vscode') {
    return {
      MarkdownString: class { appendMarkdown() {} },
      Range: class {},
      Hover:  class {},
      workspace: { getConfiguration: () => ({ get: () => '#c92d35' }) },
    };
  }
  return _orig.apply(this, arguments);
};

const { parseParameters, parseRepositoryAliases, resolveTemplatePath, parseVariables, parsePassedParameters, findOwningTemplateLine } =
  require('../../hoverProvider');

Module._load = _orig; // restore immediately after require

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES    = path.resolve(__dirname, '..', 'fixtures');
const MAIN_REPO   = path.join(FIXTURES, 'main-repo');
const SIBLING_REPO = path.join(FIXTURES, 'sibling-repo');

// The "current file" that the hover provider would be looking at
const CURRENT_FILE = path.join(MAIN_REPO, 'pipelines', 'azure-pipelines.yml');

// Verify fixtures exist so test failures are obvious
assert.ok(fs.existsSync(path.join(MAIN_REPO, '.git')),
  'Fixture missing: test/fixtures/main-repo/.git');
assert.ok(fs.existsSync(CURRENT_FILE),
  'Fixture missing: test/fixtures/main-repo/pipelines/azure-pipelines.yml');
assert.ok(fs.existsSync(path.join(SIBLING_REPO, 'stages', 'build.yml')),
  'Fixture missing: test/fixtures/sibling-repo/stages/build.yml');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const norm = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// parseParameters
// ---------------------------------------------------------------------------

describe('parseParameters', () => {

  it('returns [] when there is no parameters block', () => {
    assert.deepStrictEqual(parseParameters('stages:\n  - stage: Build\n'), []);
  });

  it('parses a single parameter with type and default', () => {
    const yaml = `
parameters:
  - name: buildConfig
    type: string
    default: Release
`;
    const [p] = parseParameters(yaml);
    assert.strictEqual(p.name,     'buildConfig');
    assert.strictEqual(p.type,     'string');
    assert.strictEqual(p.default,  'Release');
    assert.strictEqual(p.required, false);
  });

  it('parses multiple parameters preserving order', () => {
    const yaml = `
parameters:
  - name: env
    type: string
    default: dev
  - name: count
    type: number
    default: 3
  - name: flag
    type: boolean
    default: true
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 3);
    assert.strictEqual(params[0].name, 'env');
    assert.strictEqual(params[1].type, 'number');
    assert.strictEqual(params[2].type, 'boolean');
  });

  it('marks parameter required when it has no default value', () => {
    const yaml = `
parameters:
  - name: subscriptionId
    type: string
  - name: region
    type: string
    default: eastus
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params[0].required, true);
    assert.strictEqual(params[1].required, false);
  });

  it('marks parameter not required when it has a default value', () => {
    const yaml = `
parameters:
  - name: apiKey
    type: string
    default: ''
`;
    assert.strictEqual(parseParameters(yaml)[0].required, false);
  });

  it('default is undefined when not specified', () => {
    const yaml = `
parameters:
  - name: noDefault
    type: string
`;
    assert.strictEqual(parseParameters(yaml)[0].default, undefined);
  });

  it('defaults type to "string" when omitted', () => {
    const yaml = `
parameters:
  - name: implicit
`;
    assert.strictEqual(parseParameters(yaml)[0].type, 'string');
  });

  it('stops at the next top-level key', () => {
    const yaml = `
parameters:
  - name: p1
    type: string
stages:
  - stage: Build
`;
    assert.strictEqual(parseParameters(yaml).length, 1);
  });

  it('reads parameters from the real local-template fixture', () => {
    const text = fs.readFileSync(
      path.join(MAIN_REPO, 'templates', 'local-template.yml'), 'utf8');
    const params = parseParameters(text);
    assert.strictEqual(params.length, 2);
    assert.strictEqual(params[0].name,     'environment');
    assert.strictEqual(params[0].required, true);
    assert.strictEqual(params[1].name,     'region');
    assert.strictEqual(params[1].default,  'eastus');
  });

  it('reads parameters from the real sibling-repo fixture', () => {
    const text = fs.readFileSync(
      path.join(SIBLING_REPO, 'stages', 'build.yml'), 'utf8');
    const params = parseParameters(text);
    assert.strictEqual(params.length, 3);
    assert.strictEqual(params[0].name,     'buildConfiguration');
    assert.strictEqual(params[0].required, true);
    assert.strictEqual(params[1].name,     'dotnetVersion');
    assert.strictEqual(params[1].default,  "'8.0.x'");
    assert.strictEqual(params[2].name,     'publishArtifact');
    assert.strictEqual(params[2].type,     'boolean');
  });
});

  it('parses parameters in files with CRLF line endings (baseIndent = 0)', () => {
    // Reproduces the bug found in Windows-authored repos where parameters are
    // written at column 0 (no leading spaces) and files use CRLF (\r\n).
    // The old exit condition `!/^\s/.test(trimmed)` fired on "- name: foo"
    // at column 0, breaking out of the block before any param was captured.
    const yaml = 'parameters:\r\n- name: appName\r\n  type: string\r\n- name: region\r\n  type: string\r\n  default: eastus\r\nsteps:\r\n- script: echo hi\r\n';
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 2, 'should parse both params despite CRLF + baseIndent=0');
    assert.strictEqual(params[0].name, 'appName');
    assert.strictEqual(params[0].type, 'string');
    assert.strictEqual(params[0].required, true,  'appName has no default — should be required');
    assert.strictEqual(params[1].name, 'region');
    assert.strictEqual(params[1].default, 'eastus');
    assert.strictEqual(params[1].required, false, 'region has a default — should not be required');
  });

  it('derives required from absence of default with CRLF line endings', () => {
    const yaml = 'parameters:\r\n- name: purposeID\r\n  type: string\r\n- name: optional\r\n  type: string\r\n  default: foo\r\n';
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 2);
    assert.strictEqual(params[0].required, true,  'purposeID has no default — should be required');
    assert.strictEqual(params[1].required, false, 'optional has a default — should not be required');
  });

// ---------------------------------------------------------------------------
// parseRepositoryAliases
// ---------------------------------------------------------------------------

describe('parseRepositoryAliases', () => {

  it('returns {} when no resources block', () => {
    assert.deepStrictEqual(parseRepositoryAliases('stages:\n  - stage: Build\n'), {});
  });

  it('returns {} when resources has no repositories key', () => {
    const yaml = `
resources:
  pipelines:
    - pipeline: myPipeline
      source: upstream
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), {});
  });

  it('parses a single repository alias', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      type: git
      name: myorg/shared-pipeline-templates
      ref: refs/heads/main
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml),
      { templates: 'shared-pipeline-templates' });
  });

  it('parses multiple repository aliases', () => {
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
    assert.deepStrictEqual(parseRepositoryAliases(yaml), {
      templates: 'shared-pipeline-templates',
      security:  'security-templates',
      infra:     'infra-templates',
    });
  });

  it('handles name without org prefix', () => {
    const yaml = `
resources:
  repositories:
    - repository: myrepo
      name: standalone-repo
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), { myrepo: 'standalone-repo' });
  });

  it('stops at the next top-level key after resources', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      name: myorg/shared-templates
stages:
  - stage: Build
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), { templates: 'shared-templates' });
  });

  it('uses only the last path segment of the name', () => {
    const yaml = `
resources:
  repositories:
    - repository: lib
      name: org/sub/deep-repo-name
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml), { lib: 'deep-repo-name' });
  });

  it('parses the exact example from the feature request', () => {
    const yaml = `
resources:
  repositories:
    - repository: templates
      name: organization/template-repo-name

stages:
  - template: stages/stage-template.yml@templates
`;
    assert.deepStrictEqual(parseRepositoryAliases(yaml),
      { templates: 'template-repo-name' });
  });

  it('parses aliases from the real fixture pipeline file', () => {
    const text = fs.readFileSync(CURRENT_FILE, 'utf8');
    const aliases = parseRepositoryAliases(text);
    assert.deepStrictEqual(aliases, { templates: 'sibling-repo' });
  });
});

// ---------------------------------------------------------------------------
// resolveTemplatePath
// ---------------------------------------------------------------------------

describe('resolveTemplatePath', () => {

  const NO_ALIASES = {};

  it('returns null for an empty ref', () => {
    assert.strictEqual(resolveTemplatePath('', CURRENT_FILE, NO_ALIASES), null);
  });

  it('resolves a relative path from the current file directory', () => {
    const result = resolveTemplatePath('../templates/local-template.yml', CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.ok(fs.existsSync(result.filePath),
      `Expected file to exist at: ${result.filePath}`);
    assert.strictEqual(result.repoName, null);
  });

  it('resolves an absolute path (/) from the repo root (.git boundary)', () => {
    // /templates/local-template.yml → MAIN_REPO/templates/local-template.yml
    const result = resolveTemplatePath('/templates/local-template.yml', CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(
      norm(result.filePath),
      norm(path.join(MAIN_REPO, 'templates', 'local-template.yml'))
    );
    assert.ok(fs.existsSync(result.filePath),
      `Expected file to exist at: ${result.filePath}`);
  });

  it('resolves a cross-repo reference to the sibling directory', () => {
    // MAIN_REPO/.git exists → repo root = MAIN_REPO
    // parent of MAIN_REPO = FIXTURES
    // sibling-repo lives at FIXTURES/sibling-repo
    const aliases = { templates: 'sibling-repo' };
    const result = resolveTemplatePath('stages/build.yml@templates', CURRENT_FILE, aliases);
    assert.ok(result);
    assert.strictEqual(result.repoName, 'sibling-repo');
    assert.strictEqual(
      norm(result.filePath),
      norm(path.join(FIXTURES, 'sibling-repo', 'stages', 'build.yml'))
    );
    assert.ok(fs.existsSync(result.filePath),
      `Expected file to exist at: ${result.filePath}`);
  });

  it('cross-repo: leading slash in template path is stripped before joining', () => {
    const aliases = { templates: 'sibling-repo' };
    const result = resolveTemplatePath('/stages/build.yml@templates', CURRENT_FILE, aliases);
    assert.ok(result);
    assert.ok(!result.filePath.includes('//'));
    assert.ok(fs.existsSync(result.filePath),
      `Expected file to exist at: ${result.filePath}`);
  });

  it('returns unknownAlias flag when alias is not in the map', () => {
    const result = resolveTemplatePath('stages/build.yml@unknown', CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(result.unknownAlias, true);
    assert.strictEqual(result.alias,        'unknown');
    assert.strictEqual(result.filePath,     null);
  });

  it('@self alias resolves as a local path', () => {
    const result = resolveTemplatePath('../templates/local-template.yml@self', CURRENT_FILE, NO_ALIASES);
    assert.ok(result);
    assert.strictEqual(result.repoName, null);
    assert.ok(!result.unknownAlias);
    assert.ok(fs.existsSync(result.filePath),
      `Expected file to exist at: ${result.filePath}`);
  });

  it('null repoAliases is treated as empty — unknown alias returned', () => {
    const result = resolveTemplatePath('stages/build.yml@templates', CURRENT_FILE, null);
    assert.ok(result);
    assert.strictEqual(result.unknownAlias, true);
  });

  it('end-to-end: parses aliases from fixture pipeline then resolves cross-repo path', () => {
    const pipelineText = fs.readFileSync(CURRENT_FILE, 'utf8');
    const aliases = parseRepositoryAliases(pipelineText);

    // aliases = { templates: 'sibling-repo' }
    const result = resolveTemplatePath('stages/build.yml@templates', CURRENT_FILE, aliases);
    assert.ok(result);
    assert.strictEqual(result.repoName, 'sibling-repo');
    assert.ok(fs.existsSync(result.filePath),
      `Expected resolved file to exist at: ${result.filePath}`);

    // And we can actually read and parse the parameters from that file
    const templateText = fs.readFileSync(result.filePath, 'utf8');
    const params = parseParameters(templateText);
    assert.strictEqual(params.length, 3);
    assert.strictEqual(params[0].name,     'buildConfiguration');
    assert.strictEqual(params[0].required, true);
  });
});

// ---------------------------------------------------------------------------
// parseVariables
// ---------------------------------------------------------------------------

describe('parseVariables', () => {

  it('returns empty results when there is no variables block', () => {
    const { variables, groups } = parseVariables('stages:\n  - stage: Build\n');
    assert.deepStrictEqual(variables, {});
    assert.deepStrictEqual(groups, []);
  });

  it('parses map-form variables', () => {
    const yaml = `
variables:
  buildConfiguration: Release
  dotnetVersion: 8.0.x
  emptyVar:
`;
    const { variables, groups } = parseVariables(yaml);
    assert.strictEqual(variables['buildConfiguration'].value, 'Release');
    assert.strictEqual(variables['dotnetVersion'].value, '8.0.x');
    assert.ok('emptyVar' in variables);
    assert.deepStrictEqual(groups, []);
  });

  it('parses list-form variables with name/value', () => {
    const yaml = `
variables:
  - name: buildConfiguration
    value: Release
  - name: dotnetVersion
    value: 8.0.x
`;
    const { variables, groups } = parseVariables(yaml);
    assert.strictEqual(variables['buildConfiguration'].value, 'Release');
    assert.strictEqual(variables['dotnetVersion'].value, '8.0.x');
    assert.deepStrictEqual(groups, []);
  });

  it('parses list-form variable groups', () => {
    const yaml = `
variables:
  - name: buildConfiguration
    value: Release
  - group: my-variable-group
  - group: another-group
`;
    const { variables, groups } = parseVariables(yaml);
    assert.strictEqual(variables['buildConfiguration'].value, 'Release');
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].name, 'my-variable-group');
    assert.strictEqual(groups[1].name, 'another-group');
  });

  it('records the correct line number for map-form variables', () => {
    const yaml = `variables:\n  myVar: hello\n`;
    const { variables } = parseVariables(yaml);
    assert.ok('myVar' in variables);
    assert.strictEqual(variables['myVar'].line, 1); // 0-based line 1
  });

  it('stops at the next top-level key after variables', () => {
    const yaml = `
variables:
  buildConfig: Release
stages:
  - stage: Build
`;
    const { variables } = parseVariables(yaml);
    assert.ok('buildConfig' in variables);
    assert.ok(!('stage' in variables));
  });

  it('handles mixed list with groups and named variables', () => {
    const yaml = `
variables:
  - group: shared-secrets
  - name: appName
    value: myapp
  - group: env-config
`;
    const { variables, groups } = parseVariables(yaml);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].name, 'shared-secrets');
    assert.strictEqual(groups[1].name, 'env-config');
    assert.strictEqual(variables['appName'].value, 'myapp');
  });
});

// ---------------------------------------------------------------------------
// parsePassedParameters
// ---------------------------------------------------------------------------

describe('parsePassedParameters', () => {

  it('returns {} when there is no parameters block after the template line', () => {
    const lines = [
      '- template: templates/build.yml',
      '- template: templates/deploy.yml',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.deepStrictEqual(result, {});
  });

  it('parses simple key-value parameters', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: "**/*.csproj"',
      '    buildConfiguration: Release',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.ok('project' in result);
    assert.ok('buildConfiguration' in result);
    assert.strictEqual(result['buildConfiguration'].value, 'Release');
    assert.strictEqual(result['buildConfiguration'].line, 3);
  });

  it('stops at the next sibling template line', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: foo',
      '- template: templates/deploy.yml',
      '  parameters:',
      '    environment: Production',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.ok('project' in result);
    assert.ok(!('environment' in result));
  });

  it('stops when indentation returns to template level', () => {
    const lines = [
      '  - template: templates/build.yml',
      '    parameters:',
      '      project: foo',
      '  - job: AnotherJob',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.ok('project' in result);
    assert.ok(!('job' in result));
  });

  it('records the correct line number for each parameter', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    alpha: one',
      '    beta: two',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.strictEqual(result['alpha'].line, 2);
    assert.strictEqual(result['beta'].line, 3);
  });

  it('handles parameters with pipeline expression values', () => {
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    buildConfig: $(buildConfiguration)',
      '    version: ${{ variables.dotnetVersion }}',
    ];
    const result = parsePassedParameters(lines, 0);
    assert.strictEqual(result['buildConfig'].value, '$(buildConfiguration)');
    assert.strictEqual(result['version'].value, '${{ variables.dotnetVersion }}');
  });
});

// ---------------------------------------------------------------------------
// parseParameters — line number tracking (new in param go-to-definition)
// ---------------------------------------------------------------------------

describe('parseParameters — line numbers', () => {

  it('records the correct 0-based line for each parameter', () => {
    // Line 0: (empty — leading newline from template literal)
    // Line 1: "parameters:"
    // Line 2: "  - name: project"
    // Line 3: "    type: string"
    // Line 4: "  - name: buildConfiguration"
    const yaml = `
parameters:
  - name: project
    type: string
  - name: buildConfiguration
    type: string
    default: Release
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 2);
    assert.strictEqual(params[0].name, 'project');
    assert.strictEqual(params[0].line, 2);   // "  - name: project" is line 2
    assert.strictEqual(params[1].name, 'buildConfiguration');
    assert.strictEqual(params[1].line, 4);   // "  - name: buildConfiguration" is line 4
  });

  it('records line 0 when parameters block starts at the very first line', () => {
    const yaml = 'parameters:\n- name: appName\n  type: string\n';
    const params = parseParameters(yaml);
    assert.strictEqual(params.length, 1);
    assert.strictEqual(params[0].name, 'appName');
    assert.strictEqual(params[0].line, 1);   // "- name: appName" is line 1
  });

  it('line numbers survive comment lines between parameters', () => {
    const yaml = `
parameters:
  # REQUIRED
  - name: project
    type: string
  # OPTIONAL
  - name: dotnetVersion
    type: string
    default: '8.0.x'
`;
    const params = parseParameters(yaml);
    assert.strictEqual(params[0].name, 'project');
    assert.strictEqual(params[0].line, 3);   // line 3 (0-based)
    assert.strictEqual(params[1].name, 'dotnetVersion');
    assert.strictEqual(params[1].line, 6);   // line 6 (0-based)
  });
});

// ---------------------------------------------------------------------------
// findOwningTemplateLine
// ---------------------------------------------------------------------------

describe('findOwningTemplateLine', () => {

  it('returns the template line index when cursor is on a direct param key', () => {
    // Simulates:
    //   0: "- template: templates/build.yml"
    //   1: "  parameters:"
    //   2: "    project: '**/*.csproj'"   ← cursor
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      "    project: '**/*.csproj'",
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 2), 0);
  });

  it('returns the template line index with deeper indentation (nested jobs)', () => {
    // Simulates a template call inside a jobs block:
    //   0: "      - template: templates/build.yml"
    //   1: "        parameters:"
    //   2: "          project: foo"   ← cursor
    const lines = [
      '      - template: templates/build.yml',
      '        parameters:',
      '          project: foo',
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 2), 0);
  });

  it('returns -1 when cursor is not inside a template parameters block', () => {
    // Cursor is on a key inside a "task inputs:" block, not a template
    const lines = [
      '- task: DotNetCoreCLI@2',
      '  inputs:',
      '    command: build',   // ← cursor — not a template param
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 2), -1);
  });

  it('returns -1 when there is no template line above at all', () => {
    const lines = [
      'stages:',
      '  - stage: Build',
      '    displayName: Build',   // ← cursor
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 2), -1);
  });

  it('finds the correct template when multiple templates appear in sequence', () => {
    // Cursor is on the second template's parameter, not the first
    //   0: "- template: templates/build.yml"
    //   1: "  parameters:"
    //   2: "    project: foo"
    //   3: "- template: templates/deploy.yml"
    //   4: "  parameters:"
    //   5: "    environment: Production"   ← cursor
    const lines = [
      '- template: templates/build.yml',
      '  parameters:',
      '    project: foo',
      '- template: templates/deploy.yml',
      '  parameters:',
      '    environment: Production',
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 5), 3);
  });

  it('handles blank lines between template and parameters', () => {
    const lines = [
      '- template: templates/build.yml',
      '',
      '  parameters:',
      '    project: foo',   // ← cursor
    ];
    assert.strictEqual(findOwningTemplateLine(lines, 3), 0);
  });
});
