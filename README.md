# Worktree Review

Worktree Review is a VS Code extension for reviewing Git worktree branches from your current repository without switching the main checkout.

It is built for parallel AI-agent workflows where each agent owns a Git worktree and pushes or commits to its own branch.

## MVP features

- Shows Git worktrees for the current VS Code workspace repository.
- Lets you choose a base ref, defaulting to the current branch.
- Lists changed files for each worktree branch.
- Opens a VS Code diff editor for a changed file:
  - left side: base ref content
  - right side: the selected worktree file when it exists
- Includes uncommitted worktree edits in the right-side review view.
- Marks added, modified, deleted, and renamed files in the Worktree Review sidebar.

## Usage

1. Open your main repository in VS Code.
2. Open the Worktree Review activity bar item.
3. Select a base ref if the current branch is not the desired review base.
4. Expand a worktree and click a changed file.

## Development

This first version has no build step.

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

```bash
npm run lint
```

The extension shells out to Git. If Git is not on `PATH`, set `worktreeReview.gitPath` in VS Code settings.

## Manual testing fixture

Generate a local repository with several linked worktrees:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-review-fixture.ps1
```

The script prints the generated fixture root and the main repository path. Open the main repository path in VS Code, then use the Worktree Review activity bar item.

## Design notes

The first review mode uses VS Code's native diff editor, which is the most stable way to get a local PR-like file review flow.

The second planned mode is a synthetic working-tree preview: open the worktree file directly and paint base-vs-worktree gutter decorations, so language navigation can reuse normal file-backed language services. That is intentionally not in the first MVP because it needs custom diff-to-decoration mapping and change navigation.
