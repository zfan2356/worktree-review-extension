"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const GIT_BLOB_SCHEME = "worktree-review";
const STATUS_SCHEME = "worktree-review-status";
const MAX_GIT_BUFFER = 20 * 1024 * 1024;

function activate(context) {
  const git = new Git();
  const provider = new WorktreeReviewProvider(git);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_BLOB_SCHEME,
      new GitBlobContentProvider(git)
    ),
    vscode.window.registerFileDecorationProvider(new ReviewFileDecorationProvider()),
    vscode.window.createTreeView("worktreeReview.worktrees", {
      treeDataProvider: provider,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand("worktreeReview.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("worktreeReview.selectBaseRef", (node) =>
      provider.selectBaseRef(node)
    ),
    vscode.commands.registerCommand("worktreeReview.openDiff", (node) =>
      provider.openDiff(node)
    ),
    vscode.commands.registerCommand("worktreeReview.openWorktreeFile", (node) =>
      provider.openWorktreeFile(node)
    ),
    vscode.commands.registerCommand("worktreeReview.copyWorktreePath", (node) =>
      provider.copyWorktreePath(node)
    )
  );
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

class ReviewFileDecorationProvider {
  provideFileDecoration(uri) {
    if (uri.scheme !== STATUS_SCHEME) {
      return undefined;
    }

    const status = decodeURIComponent(uri.query || "M");
    const info = statusInfo(status);
    return new vscode.FileDecoration(
      info.badge,
      info.tooltip,
      new vscode.ThemeColor(info.color)
    );
  }
}

class WorktreeReviewProvider {
  constructor(git) {
    this.git = git;
    this.baseRefs = new Map();
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
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
        return worktrees.length > 0
          ? worktrees
          : [new MessageNode("No linked worktrees found.")];
      }

      if (node.kind === "worktree") {
        const files = await this.getChangedFiles(node);
        return files.length > 0
          ? files
          : [new MessageNode("No changes compared with the selected base.")];
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

      const normalized = normalizeFsPath(root);
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      const currentRef = await this.getCurrentRef(root);
      const baseRef = this.baseRefs.get(normalized) || currentRef || "HEAD";
      repos.push(new RepoNode(root, currentRef, baseRef));
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
    const worktrees = [];

    for (const worktree of parsed) {
      if (!includeCurrent && normalizeFsPath(worktree.path) === currentRoot) {
        continue;
      }

      const dirty = await this.isDirty(worktree.path);
      worktrees.push(new WorktreeNode(repo, worktree, dirty));
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

  async getChangedFiles(worktreeNode) {
    const baseRef = worktreeNode.repo.baseRef;
    const headRef = worktreeNode.headRef;
    const compareBaseRef = await this.getCompareBaseRef(
      worktreeNode.repo.repoRoot,
      baseRef,
      headRef
    );
    const changed = await this.getDiffFiles(worktreeNode.path, compareBaseRef);
    const untracked = await this.getUntrackedFiles(worktreeNode.path);
    const files = mergeFileStatuses(changed, untracked);

    return files.map((file) => {
      file.compareBaseRef = compareBaseRef;
      return new ChangedFileNode(worktreeNode, file);
    });
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

    return output
      .split("\0")
      .filter(Boolean)
      .map((filePath) => ({
        path: filePath,
        status: "A",
        statusKind: "A",
      }));
  }

  async selectBaseRef(node) {
    let repo = node && node.kind === "repo" ? node : node && node.repo;

    if (!repo) {
      const repos = await this.getRepositories();
      if (repos.length === 0) {
        vscode.window.showWarningMessage("Open a Git repository first.");
        return;
      }

      if (repos.length === 1) {
        repo = repos[0];
      } else {
        const repoPick = await vscode.window.showQuickPick(
          repos.map((candidate) => ({
            label: path.basename(candidate.repoRoot),
            description: candidate.repoRoot,
            repo: candidate,
          })),
          { placeHolder: "Select repository" }
        );
        repo = repoPick && repoPick.repo;
      }
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

    this.baseRefs.set(normalizeFsPath(repo.repoRoot), selected.label);
    this.refresh();
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

  async openDiff(node) {
    if (!node || node.kind !== "changedFile") {
      return;
    }

    const file = node.file;
    const worktree = node.worktree;
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

  async openWorktreeFile(node) {
    if (!node || node.kind !== "changedFile") {
      return;
    }

    const uri = this.getWorktreeFileUri(node.worktree, node.file.path);
    if (!uri) {
      vscode.window.showWarningMessage("This file does not exist in the selected worktree.");
      return;
    }

    await vscode.window.showTextDocument(uri, { preview: false });
  }

  getWorktreeFileUri(worktree, relativePath) {
    const filePath = path.join(worktree.path, ...relativePath.split("/"));
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    return vscode.Uri.file(filePath);
  }

  async copyWorktreePath(node) {
    if (!node || node.kind !== "worktree") {
      return;
    }

    await vscode.env.clipboard.writeText(node.path);
    vscode.window.showInformationMessage(`Copied ${node.path}`);
  }
}

class RepoNode {
  constructor(repoRoot, currentRef, baseRef) {
    this.kind = "repo";
    this.repoRoot = repoRoot;
    this.currentRef = currentRef;
    this.baseRef = baseRef;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(
      path.basename(this.repoRoot),
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `base: ${this.baseRef}`;
    item.tooltip = `${this.repoRoot}\nCurrent: ${this.currentRef}\nBase: ${this.baseRef}`;
    item.contextValue = "repo";
    item.iconPath = new vscode.ThemeIcon("repo");
    return item;
  }
}

class WorktreeNode {
  constructor(repo, worktree, dirty) {
    this.kind = "worktree";
    this.repo = repo;
    this.path = worktree.path;
    this.head = worktree.head;
    this.branch = worktree.branch;
    this.detached = worktree.detached;
    this.dirty = dirty;
    this.headRef = this.branch || this.head || "HEAD";
    this.label = this.branch || shortSha(this.head) || path.basename(this.path);
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = this.dirty ? "dirty" : undefined;
    item.tooltip = `${this.path}\nHEAD: ${this.head || "unknown"}\nCompare: ${this.repo.baseRef}...${this.headRef}`;
    item.contextValue = "worktree";
    item.iconPath = new vscode.ThemeIcon(this.dirty ? "git-compare" : "git-branch");
    return item;
  }
}

class ChangedFileNode {
  constructor(worktree, file) {
    this.kind = "changedFile";
    this.worktree = worktree;
    this.repo = worktree.repo;
    this.file = file;
  }

  getTreeItem() {
    const label = path.posix.basename(this.file.path);
    const dir = path.posix.dirname(this.file.path);
    const info = statusInfo(this.file.statusKind);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.description = dir === "." ? info.label : `${info.label} ${dir}`;
    item.tooltip = this.file.oldPath
      ? `${info.tooltip}: ${this.file.oldPath} -> ${this.file.path}`
      : `${info.tooltip}: ${this.file.path}`;
    item.contextValue = "changedFile";
    item.command = {
      command: "worktreeReview.openDiff",
      title: "Open Diff",
      arguments: [this],
    };
    item.iconPath = new vscode.ThemeIcon(info.icon);
    item.resourceUri = vscode.Uri.from({
      scheme: STATUS_SCHEME,
      path: `/${this.file.path}`,
      query: encodeURIComponent(this.file.statusKind),
    });

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

function parseWorktreeList(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const worktree = {
        path: "",
        head: "",
        branch: undefined,
        detached: false,
      };

      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
          worktree.path = path.normalize(line.slice("worktree ".length));
        } else if (line.startsWith("HEAD ")) {
          worktree.head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          const ref = line.slice("branch ".length);
          worktree.branch = ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
        } else if (line === "detached") {
          worktree.detached = true;
        }
      }

      return worktree;
    })
    .filter((worktree) => worktree.path);
}

function parseNameStatus(output) {
  const tokens = output.split("\0").filter(Boolean);
  const files = [];
  let index = 0;

  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) {
      continue;
    }

    const statusKind = status.charAt(0);
    if (statusKind === "R" || statusKind === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      files.push({
        path: newPath,
        oldPath,
        status,
        statusKind,
      });
      continue;
    }

    const filePath = tokens[index++];
    files.push({
      path: filePath,
      status,
      statusKind,
    });
  }

  return files;
}

function mergeFileStatuses(primary, additions) {
  const byPath = new Map();
  for (const file of primary) {
    byPath.set(file.path, file);
  }

  for (const file of additions) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }

  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
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

function statusInfo(statusKind) {
  switch (statusKind) {
    case "A":
      return {
        badge: "A",
        label: "added",
        tooltip: "Added",
        icon: "diff-added",
        color: "gitDecoration.addedResourceForeground",
      };
    case "D":
      return {
        badge: "D",
        label: "deleted",
        tooltip: "Deleted",
        icon: "diff-removed",
        color: "gitDecoration.deletedResourceForeground",
      };
    case "R":
      return {
        badge: "R",
        label: "renamed",
        tooltip: "Renamed",
        icon: "diff-renamed",
        color: "gitDecoration.renamedResourceForeground",
      };
    case "C":
      return {
        badge: "C",
        label: "copied",
        tooltip: "Copied",
        icon: "diff-renamed",
        color: "gitDecoration.renamedResourceForeground",
      };
    case "U":
      return {
        badge: "U",
        label: "conflict",
        tooltip: "Conflict",
        icon: "warning",
        color: "gitDecoration.conflictingResourceForeground",
      };
    case "M":
    default:
      return {
        badge: "M",
        label: "modified",
        tooltip: "Modified",
        icon: "diff-modified",
        color: "gitDecoration.modifiedResourceForeground",
      };
  }
}

function normalizeFsPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : undefined;
}

function trimTrailingNewline(value) {
  return value.replace(/[\r\n]+$/, "");
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }

  const stderr = error.stderr && error.stderr.trim();
  const message = stderr || error.message || String(error);
  return message.replace(/\s+/g, " ").trim();
}

module.exports = {
  activate,
  deactivate,
};
