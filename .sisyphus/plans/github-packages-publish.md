# Publish to GitHub Packages

## TL;DR

Update package.json and GitHub Actions workflow to publish `@griffinmartin/opencode-claude-auth` to GitHub Packages.

## Context

User wants to publish this plugin to GitHub Packages instead of npmjs. Need to:
1. Update package.json name and add publishConfig
2. Update workflow to use GitHub Packages registry

## Work Objectives

### Core Objective
Publish the plugin to GitHub Packages via the existing GitHub Actions workflow.

### Must Have
- [ ] package.json: name changed to `@griffinmartin/opencode-claude-auth`
- [ ] package.json: add `publishConfig` with GitHub Packages registry
- [ ] workflow: update to publish to `npm.pkg.github.com`
- [ ] Test publish with a v0 tag

### Must NOT Have
- Breaking changes to the plugin functionality

## Verification Strategy

- [ ] `npm run build` succeeds locally
- [ ] `git diff` shows only intended changes
- [ ] GitHub Actions workflow runs successfully on tag push

## TODOs

- [ ] 1. Update package.json

  **What to do**:
  - Change `"name"` from `"opencode-claude-auth"` to `"@griffinmartin/opencode-claude-auth"`
  - Add `"publishConfig": { "registry": "https://npm.pkg.github.com" }` after the files array

  **References**:
  - `package.json:1-13` - Current package.json structure

  **QA Scenarios**:

  ```
  Scenario: Build succeeds after name change
    Tool: Bash
    Preconditions: package.json updated
    Steps:
      1. Run npm run build
    Expected Result: Build completes without errors
    Evidence: .sisyphus/evidence/build-output.txt
  ```

- [ ] 2. Update GitHub Actions workflow

  **What to do**:
  - Change workflow name to "Publish to GitHub Packages"
  - Change `permissions.contents` to `read`
  - Change `permissions.id-token` to `packages: write`
  - Change `registry-url` from `registry.npmjs.org` to `https://npm.pkg.github.com`
  - Add `scope: "@griffinmartin"` to setup-node
  - Remove `--access public --provenance` from publish command (not needed for GPR)

  **References**:
  - `.github/workflows/publish.yml:1-26` - Current workflow

  **QA Scenarios**:

  ```
  Scenario: Workflow file has correct configuration
    Tool: Bash
    Preconditions: Workflow updated
    Steps:
      1. grep "npm.pkg.github.com" .github/workflows/publish.yml
    Expected Result: Line contains registry-url with GitHub Packages URL
    Evidence: .sisyphus/evidence/workflow-config.txt
  ```

- [ ] 3. Create test tag and verify workflow

  **What to do**:
  - Run `git tag v0.1.0-test && git push origin v0.1.0-test`
  - Monitor GitHub Actions run
  - Delete tag after verification: `git tag -d v0.1.0-test && git push origin --delete v0.1.0-test`

  **QA Scenarios**:

  ```
  Scenario: GitHub Actions workflow triggers on tag
    Tool: Bash
    Preconditions: Tag pushed
    Steps:
      1. Check GitHub Actions run status at repo URL
    Expected Result: Workflow starts within 1 minute
    Evidence: Screenshot of Actions run
  ```

## Final Verification Wave

- [ ] F1. **Build verification** — `bash`
  Run `npm run build` locally, verify dist/ is generated correctly.
  Output: `Build [PASS/FAIL]`

- [ ] F2. **Changes verified** — `bash`
  Run `git diff` and confirm only the two files were modified as intended.
  Output: `Files [N/N correct]`

## Commit Strategy

- Commit message: `chore: configure for GitHub Packages publishing`
- Files: `package.json`, `.github/workflows/publish.yml`

## Success Criteria

- [ ] package.json has correct name and publishConfig
- [ ] Workflow publishes to GitHub Packages
- [ ] Test tag triggers workflow successfully
