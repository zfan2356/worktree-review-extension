"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const {
  buildChangeIndex,
  formatError,
  mergeFileStatuses,
  normalizeFsPath,
  parseNameStatus,
  parsePreviewLineChanges,
  parseUntrackedFiles,
  parseWorktreeList,
  relativePathFromRoot,
  shortSha,
  statusInfo,
  trimTrailingNewline,
} = require("./git-utils");

const GIT_BLOB_SCHEME = "worktree-review";
const MAX_GIT_BUFFER = 20 * 1024 * 1024;
const MODE_KEY = "worktreeReview.mode";
const MODES = {
  off: {
    label: "Off",
    description: "Explorer opens normal files",
    icon: "circle-slash",
  },
  diff: {
    label: "Diff",
    description: "Explorer opens base vs worktree diffs",
    icon: "diff",
  },
  preview: {
    label: "Preview",
    description: "Explorer opens real worktree files",
    icon: "go-to-file",
  },
};

function activate(context) {
  const git = new Git();
  const provider = new WorktreeReviewProvider(git, context);
  const decorations = new ExplorerDecorationProvider(provider);
  const previewDecorations = createPreviewDecorations(context);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  provider.setDecorationProvider(decorations);
  provider.setPreviewDecorations(previewDecorations);
  provider.setStatusBar(statusBar);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_BLOB_SCHEME,
      new GitBlobContentProvider(git)
    ),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.createTreeView("worktreeReview.worktrees", {
      treeDataProvider: provider,
      showCollapseAll: false,
    }),
    statusBar,
    ...Object.values(previewDecorations),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      provider.handleActiveEditor(editor)
    ),
    vscode.commands.registerCommand("worktreeReview.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("worktreeReview.selectBaseRef", (node) =>
      provider.selectBaseRef(node)
    ),
    vscode.commands.registerCommand("worktreeReview.selectWorktree", (node) =>
      provider.selectWorktree(node)
    ),
    vscode.commands.registerCommand("worktreeReview.selectMode", (node) =>
      provider.selectMode(node)
    ),
    vscode.commands.registerCommand("worktreeReview.openCurrentFileReview", () =>
      provider.openCurrentFileReview()
    ),
    vscode.commands.registerCommand("worktreeReview.openChangedFile", () =>
      provider.openChangedFileQuickPick()
    ),
    vscode.commands.registerCommand("worktreeReview.copyWorktreePath", (node) =>
      provider.copyWorktreePath(node)
    )
  );

  provider.updateStatusBar();
}

function deactivate() {}

class Git {
  run(cwd, args, options = {}) {
    const gitPath = vscode.workspace
      .getConfiguration("worktreeReview")
      .get("gitPath", "git");

    return new Promise((resolve, reject) => {
      cp.execFile(
        gitPath,
        ["-C", cwd, ...args],
        {
          cwd,
          maxBuffer: options.maxBuffer || MAX_GIT_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }

          resolve(options.trim === false ? stdout : trimTrailingNewline(stdout));
        }
      );
    });
  }
}

class GitBlobContentProvider {
  constructor(git) {
    this.git = git;
  }

  async provideTextDocumentContent(uri) {
    const payload = decodePayload(uri);
    if (payload.empty) {
      return "";
    }

    return this.git.run(
      payload.repoRoot,
      ["show", `${payload.ref}:${payload.filePath}`],
      { trim: false }
    );
  }
}

class ExplorerDecorationProvider {
  constructor(provider) {
    this.provider = provider;
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  }

  refresh() {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri) {
    return this.provider.provideExplorerDecoration(uri);
  }
}

class WorktreeReviewProvider {
  constructor(git, context) {
    this.git = git;
    this.context = context;
    this.mode = context.workspaceState.get(MODE_KEY, "diff");
    this.baseRefs = new Map();
    this.repoCache = new Map();
    this.activeWorktrees = new Map();
    this.changeStates = new Map();
    this.openingReview = false;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  setDecorationProvider(provider) {
    this.decorationProvider = provider;
  }

  setPreviewDecorations(decorations) {
    this.previewDecorations = decorations;
  }

  setStatusBar(statusBar) {
    this.statusBar = statusBar;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
    this.refreshActiveChanges();
  }

  async refreshActiveChanges() {
    const active = Array.from(this.activeWorktrees.values());
    for (const worktree of active) {
      try {
        await this.rebuildChangeState(worktree);
      } catch (error) {
        vscode.window.showWarningMessage(`Worktree Review refresh failed: ${formatError(error)}`);
      }
    }

    this.decorationProvider && this.decorationProvider.refresh();
    this.updateStatusBar();
  }

  async getChildren(node) {
    try {
      if (!node) {
        const repos = await this.getRepositories();
        return repos.length > 0
          ? repos
          : [new MessageNode("Open a Git repository to review worktrees.")];
      }

      if (node.kind === "repo") {
        const worktrees = await this.getWorktrees(node);
        const modeNodes = Object.keys(MODES).map(
          (mode) => new ModeNode(this, node, mode, this.mode === mode)
        );

        return worktrees.length > 0
          ? [...modeNodes, ...worktrees]
          : [...modeNodes, new MessageNode("No linked worktrees found.")];
      }
    } catch (error) {
      return [new MessageNode(formatError(error))];
    }

    return [];
  }

  getTreeItem(node) {
    return node.getTreeItem();
  }

  async getRepositories() {
    const folders = vscode.workspace.workspaceFolders || [];
    const seen = new Set();
    const repos = [];

    for (const folder of folders) {
      const root = await this.getRepoRoot(folder.uri.fsPath);
      if (!root) {
        continue;
      }

      const key = normalizeFsPath(root);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      const currentRef = await this.getCurrentRef(root);
      const baseRef = this.baseRefs.get(key) || currentRef || "HEAD";
      const activeWorktree = this.activeWorktrees.get(key);
      const repo = new RepoNode(root, currentRef, baseRef, key, activeWorktree, this.mode);
      this.repoCache.set(key, repo);
      repos.push(repo);
    }

    return repos;
  }

  async getRepoRoot(folderPath) {
    try {
      const root = await this.git.run(folderPath, ["rev-parse", "--show-toplevel"]);
      return path.normalize(root);
    } catch {
      return undefined;
    }
  }

  async getCurrentRef(repoRoot) {
    try {
      const branch = await this.git.run(repoRoot, ["branch", "--show-current"]);
      if (branch) {
        return branch;
      }
    } catch {
      // Fall back to detached HEAD below.
    }

    try {
      return this.git.run(repoRoot, ["rev-parse", "--short", "HEAD"]);
    } catch {
      return "HEAD";
    }
  }

  async getWorktrees(repo) {
    const output = await this.git.run(repo.repoRoot, ["worktree", "list", "--porcelain"]);
    const parsed = parseWorktreeList(output);
    const includeCurrent = vscode.workspace
      .getConfiguration("worktreeReview")
      .get("includeCurrentWorktree", false);
    const currentRoot = normalizeFsPath(repo.repoRoot);
    const active = this.activeWorktrees.get(repo.key);
    const worktrees = [];

    for (const worktree of parsed) {
      if (!includeCurrent && normalizeFsPath(worktree.path) === currentRoot) {
        continue;
      }

      const dirty = await this.isDirty(worktree.path);
      const node = new WorktreeNode(
        repo,
        worktree,
        dirty,
        Boolean(active && normalizeFsPath(active.path) === normalizeFsPath(worktree.path)),
        this.changeStates.get(repo.key)
      );
      worktrees.push(node);
    }

    return worktrees;
  }

  async isDirty(worktreePath) {
    try {
      const output = await this.git.run(worktreePath, ["status", "--porcelain"]);
      return output.length > 0;
    } catch {
      return false;
    }
  }

  async selectWorktree(node) {
    let worktree = node && node.kind === "worktree" ? node : undefined;

    if (!worktree) {
      worktree = await this.pickWorktree();
    }

    if (!worktree) {
      return;
    }

    this.activeWorktrees.set(worktree.repo.key, worktree);
    await this.rebuildChangeState(worktree);
    this._onDidChangeTreeData.fire();
    this.decorationProvider && this.decorationProvider.refresh();
    this.updateStatusBar();
  }

  async pickWorktree() {
    const repos = await this.getRepositories();
    const picks = [];

    for (const repo of repos) {
      const worktrees = await this.getWorktrees(repo);
      for (const worktree of worktrees) {
        picks.push({
          label: worktree.label,
          description: path.basename(repo.repoRoot),
          detail: worktree.path,
          worktree,
        });
      }
    }

    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: "Select worktree to review",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return picked && picked.worktree;
  }

  async selectMode(node) {
    let mode = node && node.kind === "mode" ? node.mode : undefined;

    if (!mode) {
      const picked = await vscode.window.showQuickPick(
        Object.entries(MODES).map(([value, info]) => ({
          label: info.label,
          description: info.description,
          value,
        })),
        { placeHolder: "Select Worktree Review mode" }
      );
      mode = picked && picked.value;
    }

    if (!mode || !MODES[mode]) {
      return;
    }

    this.mode = mode;
    await this.context.workspaceState.update(MODE_KEY, mode);
    this._onDidChangeTreeData.fire();
    this.decorationProvider && this.decorationProvider.refresh();
    if (this.mode !== "preview") {
      this.clearPreviewDecorations(vscode.window.activeTextEditor);
    }
    this.updateStatusBar();
  }

  async rebuildChangeState(worktree) {
    const files = await this.getChangedFiles(worktree);
    const index = buildChangeIndex(files);
    this.changeStates.set(worktree.repo.key, {
      repo: worktree.repo,
      worktree,
      files,
      index,
    });
  }

  async getChangedFiles(worktree) {
    const baseRef = worktree.repo.baseRef;
    const headRef = worktree.headRef;
    const compareBaseRef = await this.getCompareBaseRef(
      worktree.repo.repoRoot,
      baseRef,
      headRef
    );
    const changed = await this.getDiffFiles(worktree.path, compareBaseRef);
    const untracked = await this.getUntrackedFiles(worktree.path);
    const files = mergeFileStatuses(changed, untracked);

    return files.map((file) => ({
      ...file,
      compareBaseRef,
    }));
  }

  async getCompareBaseRef(repoRoot, baseRef, headRef) {
    try {
      return await this.git.run(repoRoot, ["merge-base", baseRef, headRef]);
    } catch {
      return baseRef;
    }
  }

  async getDiffFiles(worktreePath, compareBaseRef) {
    const output = await this.git.run(
      worktreePath,
      ["diff", "--name-status", "--find-renames", "-z", compareBaseRef, "--"],
      { trim: false }
    );

    return parseNameStatus(output);
  }

  async getUntrackedFiles(worktreePath) {
    const output = await this.git.run(
      worktreePath,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { trim: false }
    );

    return parseUntrackedFiles(output);
  }

  async selectBaseRef(node) {
    let repo = node && node.kind === "repo" ? node : node && node.repo;

    if (!repo) {
      repo = await this.pickRepo();
    }

    if (!repo) {
      return;
    }

    const refs = await this.listRefs(repo.repoRoot);
    const selected = await vscode.window.showQuickPick(
      refs.map((ref) => ({
        label: ref,
        description: ref === repo.currentRef ? "current branch" : undefined,
      })),
      {
        placeHolder: `Base ref for ${path.basename(repo.repoRoot)}`,
        matchOnDescription: true,
      }
    );

    if (!selected) {
      return;
    }

    this.baseRefs.set(repo.key, selected.label);
    repo.baseRef = selected.label;

    const active = this.activeWorktrees.get(repo.key);
    if (active) {
      active.repo.baseRef = selected.label;
      await this.rebuildChangeState(active);
    }

    this._onDidChangeTreeData.fire();
    this.decorationProvider && this.decorationProvider.refresh();
    this.updateStatusBar();
  }

  async pickRepo() {
    const repos = await this.getRepositories();
    if (repos.length === 0) {
      vscode.window.showWarningMessage("Open a Git repository first.");
      return undefined;
    }

    if (repos.length === 1) {
      return repos[0];
    }

    const repoPick = await vscode.window.showQuickPick(
      repos.map((candidate) => ({
        label: path.basename(candidate.repoRoot),
        description: candidate.repoRoot,
        repo: candidate,
      })),
      { placeHolder: "Select repository" }
    );

    return repoPick && repoPick.repo;
  }

  async listRefs(repoRoot) {
    const refs = new Set();
    const current = await this.getCurrentRef(repoRoot);
    if (current) {
      refs.add(current);
    }

    refs.add("HEAD");

    try {
      const output = await this.git.run(repoRoot, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]);

      for (const ref of output.split(/\r?\n/).filter(Boolean)) {
        if (!ref.endsWith("/HEAD")) {
          refs.add(ref);
        }
      }
    } catch (error) {
      vscode.window.showWarningMessage(`Could not list Git refs: ${formatError(error)}`);
    }

    return Array.from(refs).sort((a, b) => a.localeCompare(b));
  }

  provideExplorerDecoration(uri) {
    if (uri.scheme !== "file" || this.mode === "off") {
      return undefined;
    }

    const match = this.findChangeForUri(uri);
    if (match && match.file) {
      const info = statusInfo(match.file.statusKind);
      return new vscode.FileDecoration(
        info.badge,
        `Worktree Review: ${info.tooltip}`,
        new vscode.ThemeColor(info.color)
      );
    }

    const folder = this.findChangedFolderForUri(uri);
    if (folder) {
      return new vscode.FileDecoration(
        undefined,
        "Worktree Review changes inside",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")
      );
    }

    return undefined;
  }

  async handleActiveEditor(editor) {
    if (!editor) {
      return;
    }

    const document = editor.document;
    if (!document || document.uri.scheme !== "file") {
      return;
    }

    if (this.mode === "preview" && this.applyPreviewDecorationsForEditor(editor)) {
      return;
    }

    this.clearPreviewDecorations(editor);

    if (this.mode === "off" || this.openingReview) {
      return;
    }

    const match = this.findChangeForUri(document.uri);
    if (!match) {
      return;
    }

    this.openingReview = true;
    try {
      if (!document.isDirty) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      }

      await this.openReviewTarget(match, { fromExplorer: true });
    } catch (error) {
      vscode.window.showWarningMessage(`Worktree Review open failed: ${formatError(error)}`);
    } finally {
      setTimeout(() => {
        this.openingReview = false;
      }, 100);
    }
  }

  async openCurrentFileReview() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("Open a workspace file first.");
      return;
    }

    const match = this.findChangeForUri(editor.document.uri);
    if (!match) {
      vscode.window.showInformationMessage(
        "The active file has no changes in the selected worktree."
      );
      return;
    }

    await this.openReviewTarget(match, { fromExplorer: false });
  }

  async openChangedFileQuickPick() {
    const states = Array.from(this.changeStates.values());
    if (states.length === 0) {
      vscode.window.showWarningMessage("Select a worktree first.");
      return;
    }

    const picks = [];
    for (const state of states) {
      for (const file of state.files) {
        const info = statusInfo(file.statusKind);
        picks.push({
          label: `${info.badge} ${file.path}`,
          description: state.worktree.label,
          detail: file.oldPath ? `${file.oldPath} -> ${file.path}` : undefined,
          state,
          file,
        });
      }
    }

    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: "Open changed file from selected worktree",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) {
      return;
    }

    await this.openReviewTarget({
      state: picked.state,
      worktree: picked.state.worktree,
      repo: picked.state.repo,
      file: picked.file,
    });
  }

  async openReviewTarget(target) {
    if (this.mode === "preview") {
      const opened = await this.openPreviewForFile(target.worktree, target.file);
      if (opened) {
        return;
      }
    }

    await this.openDiffForFile(target.worktree, target.file);
  }

  async openPreviewForFile(worktree, file) {
    if (file.statusKind === "D") {
      await this.openDiffForFile(worktree, file);
      return true;
    }

    const uri = this.getWorktreeFileUri(worktree, file.path);
    if (!uri) {
      await this.openDiffForFile(worktree, file);
      return true;
    }

    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    await this.applyPreviewDecorations(editor, worktree, file);
    return true;
  }

  applyPreviewDecorationsForEditor(editor) {
    const target = this.findPreviewTargetForUri(editor.document.uri);
    if (!target) {
      return false;
    }

    this.applyPreviewDecorations(editor, target.worktree, target.file);
    return true;
  }

  async applyPreviewDecorations(editor, worktree, file) {
    if (!this.previewDecorations || editor.document.uri.scheme !== "file") {
      return;
    }

    const lineChanges = await this.getPreviewLineChanges(editor.document, worktree, file);
    const added = rangesFromLineSpans(editor.document, lineChanges.added);
    const modified = rangesFromLineSpans(editor.document, lineChanges.modified);
    const deleted = deletionOptionsFromLineChanges(editor.document, lineChanges.deleted);

    editor.setDecorations(this.previewDecorations.added, added);
    editor.setDecorations(this.previewDecorations.modified, modified);
    editor.setDecorations(this.previewDecorations.deleted, deleted);
  }

  clearPreviewDecorations(editor) {
    if (!editor || !this.previewDecorations) {
      return;
    }

    editor.setDecorations(this.previewDecorations.added, []);
    editor.setDecorations(this.previewDecorations.modified, []);
    editor.setDecorations(this.previewDecorations.deleted, []);
  }

  async getPreviewLineChanges(document, worktree, file) {
    if (file.statusKind === "A") {
      return {
        added: [{ start: 1, count: Math.max(1, document.lineCount) }],
        modified: [],
        deleted: [],
      };
    }

    const diffPaths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const output = await this.git.run(
      worktree.path,
      [
        "diff",
        "--unified=0",
        "--no-ext-diff",
        "--no-color",
        file.compareBaseRef,
        "--",
        ...diffPaths,
      ],
      { trim: false }
    );

    return parsePreviewLineChanges(output);
  }

  async openDiffForFile(worktree, file) {
    const leftPath = file.oldPath || file.path;
    const rightPath = file.path;
    const leftUri =
      file.statusKind === "A"
        ? makeEmptyUri(worktree.repo.repoRoot, file.compareBaseRef, leftPath)
        : makeGitBlobUri(worktree.repo.repoRoot, file.compareBaseRef, leftPath);
    const rightUri =
      file.statusKind === "D"
        ? makeEmptyUri(worktree.repo.repoRoot, worktree.headRef, rightPath)
        : this.getWorktreeFileUri(worktree, rightPath) ||
          makeGitBlobUri(worktree.repo.repoRoot, worktree.headRef, rightPath);
    const title = `${statusInfo(file.statusKind).badge} ${rightPath} (${worktree.repo.baseRef}...${worktree.label})`;

    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
      preview: false,
    });
  }

  getWorktreeFileUri(worktree, relativePath) {
    const filePath = path.join(worktree.path, ...relativePath.split("/"));
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    return vscode.Uri.file(filePath);
  }

  findChangeForUri(uri) {
    for (const state of this.changeStates.values()) {
      const relativePath = relativePathFromRoot(state.repo.repoRoot, uri.fsPath);
      if (!relativePath) {
        continue;
      }

      const file =
        state.index.byPath.get(relativePath) ||
        state.index.byOldPath.get(relativePath);
      if (file) {
        return {
          state,
          repo: state.repo,
          worktree: state.worktree,
          relativePath,
          file,
        };
      }
    }

    return undefined;
  }

  findChangedFolderForUri(uri) {
    for (const state of this.changeStates.values()) {
      const relativePath = relativePathFromRoot(state.repo.repoRoot, uri.fsPath);
      if (relativePath && state.index.folders.has(relativePath)) {
        return {
          state,
          relativePath,
        };
      }
    }

    return undefined;
  }

  findPreviewTargetForUri(uri) {
    for (const state of this.changeStates.values()) {
      const relativePath = relativePathFromRoot(state.worktree.path, uri.fsPath);
      if (!relativePath) {
        continue;
      }

      const file = state.index.byPath.get(relativePath);
      if (file && file.statusKind !== "D") {
        return {
          state,
          repo: state.repo,
          worktree: state.worktree,
          relativePath,
          file,
        };
      }
    }

    return undefined;
  }

  async copyWorktreePath(node) {
    if (!node || node.kind !== "worktree") {
      return;
    }

    await vscode.env.clipboard.writeText(node.path);
    vscode.window.showInformationMessage(`Copied ${node.path}`);
  }

  updateStatusBar() {
    if (!this.statusBar) {
      return;
    }

    const states = Array.from(this.changeStates.values());
    const firstState = states[0];
    if (this.mode === "off") {
      this.statusBar.text = "$(circle-slash) WTR: Off";
    } else if (firstState) {
      this.statusBar.text = `$(git-branch) WTR: ${firstState.worktree.label} | ${MODES[this.mode].label}`;
    } else {
      this.statusBar.text = `$(git-branch) WTR: Select worktree | ${MODES[this.mode].label}`;
    }

    this.statusBar.tooltip =
      "Worktree Review: select worktree or mode from the sidebar";
    this.statusBar.command = "worktreeReview.selectWorktree";
    this.statusBar.show();
  }
}

class RepoNode {
  constructor(repoRoot, currentRef, baseRef, key, activeWorktree, mode) {
    this.kind = "repo";
    this.repoRoot = repoRoot;
    this.currentRef = currentRef;
    this.baseRef = baseRef;
    this.key = key;
    this.activeWorktree = activeWorktree;
    this.mode = mode;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(
      path.basename(this.repoRoot),
      vscode.TreeItemCollapsibleState.Expanded
    );
    const target = this.activeWorktree ? this.activeWorktree.label : "none";
    item.description = `base: ${this.baseRef} | target: ${target} | ${MODES[this.mode].label}`;
    item.tooltip = `${this.repoRoot}\nCurrent: ${this.currentRef}\nBase: ${this.baseRef}\nTarget: ${target}`;
    item.contextValue = "repo";
    item.iconPath = new vscode.ThemeIcon("repo");
    return item;
  }
}

class ModeNode {
  constructor(provider, repo, mode, active) {
    this.kind = "mode";
    this.provider = provider;
    this.repo = repo;
    this.mode = mode;
    this.active = active;
  }

  getTreeItem() {
    const info = MODES[this.mode];
    const item = new vscode.TreeItem(
      `Mode: ${info.label}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = this.active ? "active" : undefined;
    item.tooltip = info.description;
    item.contextValue = "mode";
    item.iconPath = new vscode.ThemeIcon(this.active ? "check" : info.icon);
    item.command = {
      command: "worktreeReview.selectMode",
      title: "Select Mode",
      arguments: [this],
    };
    return item;
  }
}

class WorktreeNode {
  constructor(repo, worktree, dirty, active, changeState) {
    this.kind = "worktree";
    this.repo = repo;
    this.path = worktree.path;
    this.head = worktree.head;
    this.branch = worktree.branch;
    this.detached = worktree.detached;
    this.dirty = dirty;
    this.active = active;
    this.headRef = this.branch || this.head || "HEAD";
    this.label = this.branch || shortSha(this.head) || path.basename(this.path);
    this.changeState = active ? changeState : undefined;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    const details = [];
    if (this.active) {
      details.push("active");
    }
    if (this.dirty) {
      details.push("dirty");
    }
    if (this.changeState) {
      const summary = formatStats(this.changeState.index.stats);
      if (summary) {
        details.push(summary);
      }
    }

    item.description = details.join(" | ") || undefined;
    item.tooltip = `${this.path}\nHEAD: ${this.head || "unknown"}\nCompare: ${this.repo.baseRef}...${this.headRef}`;
    item.contextValue = this.active ? "worktreeActive" : "worktree";
    item.iconPath = new vscode.ThemeIcon(this.active ? "pass-filled" : "git-branch");
    item.command = {
      command: "worktreeReview.selectWorktree",
      title: "Select Worktree",
      arguments: [this],
    };
    return item;
  }
}

class MessageNode {
  constructor(message) {
    this.kind = "message";
    this.message = message;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "message";
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }
}

function createPreviewDecorations(context) {
  return {
    added: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      overviewRulerColor: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    modified: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      overviewRulerColor: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    deleted: vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(
        context.asAbsolutePath(path.join("resources", "deleted-triangle.svg"))
      ),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  };
}

function rangesFromLineSpans(document, spans) {
  const ranges = [];
  for (const span of spans) {
    const start = clampLine(document, span.start);
    const end = clampLine(document, span.start + Math.max(1, span.count) - 1);
    ranges.push(new vscode.Range(start, 0, end, 0));
  }

  return ranges;
}

function deletionOptionsFromLineChanges(document, deletions) {
  return deletions.map((deletion) => {
    const line = clampLine(document, deletion.line);
    const deletedText =
      deletion.lines && deletion.lines.length > 0
        ? deletion.lines.join("\n")
        : `${deletion.oldCount} deleted line(s)`;
    return {
      range: new vscode.Range(line, 0, line, 0),
      hoverMessage: new vscode.MarkdownString(
        `Deleted from base at line ${deletion.oldStart}:\n\n\`\`\`\n${deletedText}\n\`\`\``
      ),
    };
  });
}

function clampLine(document, oneBasedLine) {
  if (document.lineCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(document.lineCount - 1, oneBasedLine - 1));
}

function formatStats(stats) {
  return ["M", "A", "D", "R", "C", "U"]
    .filter((key) => stats[key] > 0)
    .map((key) => `${key}${stats[key]}`)
    .join(" ");
}

function makeGitBlobUri(repoRoot, ref, filePath) {
  return makeReviewUri({ repoRoot, ref, filePath, empty: false });
}

function makeEmptyUri(repoRoot, ref, filePath) {
  return makeReviewUri({ repoRoot, ref, filePath, empty: true });
}

function makeReviewUri(payload) {
  return vscode.Uri.from({
    scheme: GIT_BLOB_SCHEME,
    authority: payload.empty ? "empty" : "git",
    path: `/${payload.filePath}`,
    query: encodeURIComponent(JSON.stringify(payload)),
  });
}

function decodePayload(uri) {
  return JSON.parse(decodeURIComponent(uri.query));
}

module.exports = {
  activate,
  deactivate,
};

