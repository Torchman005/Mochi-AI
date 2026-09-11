'use strict';
// 代码助手插件入口（模块化：见 src/codex.js、src/git.js）。
// 协议见 docs/PLUGIN-GUIDE.md。宿主注入 YUYU_PLUGIN_CONFIG / YUYU_WORKSPACE / YUYU_PLUGIN_DIR。

const readline = require('readline');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const codex = require('./codex');
const git = require('./git');

const config = (() => { try { return JSON.parse(process.env.YUYU_PLUGIN_CONFIG || '{}'); } catch (_) { return {}; } })();
const pluginDir = process.env.YUYU_PLUGIN_DIR || process.cwd();
const workspace = process.env.YUYU_WORKSPACE || pluginDir;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const reply = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const safeParse = (raw) => { try { return JSON.parse(raw || '{}'); } catch (_) { return {}; } };
const truncate = (s, n) => (s && s.length > n) ? s.slice(0, n) + '\n...[截断]' : (s || '');

function targetPath(p) {
  const rev = git.currentReview();
  const base = (rev && rev.cwd) || config.cwd || workspace;
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

function spawnIde(args) {
  const ide = String(config.ide_command || 'code');
  try {
    const child = spawn(ide, args, { cwd: workspace, detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    if (child.unref) child.unref();
  } catch (_) { /* ignore */ }
}

function runIde(args, cwd) {
  const ide = String(config.ide_command || 'code');
  const result = spawnSync(ide, args, {
    cwd: cwd || workspace,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    timeout: 15000,
  });
  return {
    ok: !result.error && (result.status === 0 || result.status === null),
    command: ide,
    args,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : '',
    stderr: String(result.stderr || '').trim(),
  };
}

function openDiffPair(pair) {
  return runIde(['--reuse-window', '--diff', pair.left, pair.right], pair.repoPath || path.dirname(pair.workPath || workspace));
}

function compactChange(file) {
  return {
    status: file.status,
    kind: file.kind,
    path: file.path,
    oldPath: file.oldPath || '',
    directory: Boolean(file.directory),
    nestedRepo: Boolean(file.nestedRepo),
    nestedCount: Number(file.nestedCount || 0),
  };
}

function reviewFromInput(input) {
  return git.currentReview() || git.restoreReview(input);
}

function reviewMode() {
  const raw = String(config.review_mode || config.reviewMode || 'live').trim().toLowerCase();
  return raw === 'branch' ? 'branch' : 'live';
}

function selectedFileSet(files) {
  return new Set((Array.isArray(files) ? files : []).map((file) => {
    if (file && typeof file === 'object') return String(file.path || '').replace(/\\/g, '/');
    return String(file || '').replace(/\\/g, '/');
  }).filter(Boolean));
}

async function handleTool(name, args) {
  if (name !== 'run_agent') throw new Error('unknown tool ' + name);
  const task = args.task || args.prompt || '';
  if (!task) throw new Error('task is required');
  const cwd = String(args.cwd || config.cwd || workspace);

  // live 模式直接在当前工作区保留未暂存改动，VS Code 可实时显示并支持 hunk 级还原。
  // branch 模式保留旧的 feature 分支整轮评审流程。
  const review = git.beginReview(cwd, { mode: reviewMode(), allowDirty: Boolean(config.allow_dirty_review) });
  if (review.mode === 'live' && config.auto_open_vscode !== false) {
    spawnIde(['--reuse-window', cwd]);
  }
  const res = await codex.runCodex(task, cwd, config, {
    reviewStatus: () => {
      const files = git.reviewFiles(cwd).map(compactChange);
      return { cwd, mode: review.mode, count: files.length, files };
    },
  });
  if (res.err) {
    return JSON.stringify({
      ok: false,
      cwd,
      exitCode: res.err.code === 'ETIMEOUT' ? null : 1,
      note: res.err.code === 'ETIMEOUT' ? 'codex 运行超时' + (res.lastError ? '：' + res.lastError : '') : String(res.err.message || res.err),
      output: truncate((res.stdout || '') + '\n' + (res.stderr || ''), 8000),
      steps: res.steps,
      mode: review.mode,
    });
  }
  const absorbedNestedRepos = git.prepareReviewChanges(cwd) || [];
  const diff = git.diff(cwd, review.baseBranch, review.branch);
  const files = git.reviewFiles(cwd).map(compactChange);
  return JSON.stringify({
    ok: true,
    cwd,
    mode: review.mode,
    baseBranch: review.baseBranch,
    baseCommit: review.baseCommit,
    branch: review.branch,
    summary: truncate((res.stdout || '').trim(), 2000),
    steps: res.steps,
    files,
    absorbedNestedRepos,
    diff: truncate(diff, 20000),
  });
}

async function handleAction(name, input) {
  if (name === 'open_in_ide') {
    const p = input.path || input.file || '';
    if (!p) return { ok: false, error: 'path(input.path) is required' };
    const t = targetPath(p);
    spawnIde([t]);
    return { ok: true, path: t, command: config.ide_command || 'code' };
  }
  if (name === 'open_workspace') {
    const rev = git.currentReview();
    const p = input.dir || input.path || (rev && rev.cwd) || config.cwd || workspace;
    const t = targetPath(p);
    spawnIde(['--new-window', t]);
    return { ok: true, path: t };
  }
  if (name === 'show_diff') {
    const rev = reviewFromInput(input);
    if (!rev) return { ok: false, error: '暂无待评审的改动' };
    return { ok: true, baseBranch: rev.baseBranch, branch: rev.branch, diff: truncate(await git.diff(rev.cwd, rev.baseBranch, rev.branch), 20000) };
  }
  if (name === 'list_changes') {
    const rev = reviewFromInput(input);
    if (!rev) return { ok: false, error: '暂无待评审的改动' };
    const files = git.reviewFiles(rev.cwd);
    return { ok: true, cwd: rev.cwd, baseBranch: rev.baseBranch, branch: rev.branch, count: files.length, files };
  }
  if (name === 'open_changes') {
    const rev = reviewFromInput(input);
    if (!rev) return { ok: false, error: '暂无待评审的改动' };
    const absorbedNestedRepos = git.absorbReviewNestedGitRepos(rev.cwd) || [];
    if (rev.mode !== 'branch') {
      const files = git.reviewFiles(rev.cwd);
      const limit = Math.max(1, Math.min(Number(input.limit || 8), 20));
      const selectedPaths = selectedFileSet(input.files);
      const selected = selectedPaths.size
        ? files.filter((file) => selectedPaths.has(String(file.path).replace(/\\/g, '/')))
        : files.slice(0, limit);
      const commands = [runIde(['--reuse-window', rev.cwd], rev.cwd)];
      for (const file of selected) {
        if (!file.directory) commands.push(runIde(['--reuse-window', path.resolve(rev.cwd, file.path)], rev.cwd));
      }
      return {
        ok: true,
        cwd: rev.cwd,
        mode: rev.mode,
        opened: selected.filter((file) => !file.directory).length,
        openedDirectories: selected.filter((file) => file.directory).length,
        total: files.length,
        files: selected.map(compactChange),
        absorbedNestedRepos,
        note: '已打开 VS Code 工作区。请在源代码管理视图中点开变更文件，使用 VS Code 的保留/还原所选范围来逐块评审。',
        command: config.ide_command || 'code',
        commands,
      };
    }
    const files = Array.isArray(input.files) ? input.files : [];
    const limit = Math.max(1, Math.min(Number(input.limit || 8), 20));
    let pairs = git.diffPairs(rev.cwd, files).slice(0, limit);
    if (pairs.length === 0 && files.length > 0) {
      pairs = git.diffPairs(rev.cwd, []).slice(0, limit);
    }
    const commands = [];
    commands.push(runIde(['--reuse-window', rev.cwd], rev.cwd));
    const openedRoots = new Set([rev.cwd]);
    for (const pair of pairs) {
      if (pair.openOnly || !pair.left || !pair.right) {
        const root = pair.repoPath || rev.cwd;
        if (!openedRoots.has(root)) {
          commands.push(runIde(['--reuse-window', root], root));
          openedRoots.add(root);
        }
      } else {
        commands.push(openDiffPair(pair));
      }
    }
    const directoryOnly = pairs.filter((p) => p.openOnly || !p.left || !p.right).length;
    const openedDiffs = pairs.length - directoryOnly;
    const noteParts = [];
    if (openedDiffs === 0) noteParts.push('没有找到可直接打开的文件 diff；已打开包含变更的仓库根目录，请在 VS Code 源代码管理视图查看。');
    if (directoryOnly > 0) noteParts.push('部分变更是目录或嵌套 git 仓库，已打开对应仓库根目录。');
    return {
      ok: true,
      cwd: rev.cwd,
      opened: openedDiffs,
      openedDirectories: directoryOnly,
      total: git.reviewFiles(rev.cwd).length,
      files: pairs.map(compactChange),
      absorbedNestedRepos,
      note: noteParts.join(' '),
      command: config.ide_command || 'code',
      commands,
    };
  }
  if (name === 'accept_changes') {
    reviewFromInput(input);
    return git.acceptChanges();
  }
  if (name === 'reject_changes') {
    reviewFromInput(input);
    return git.rejectChanges();
  }
  throw new Error('unknown action ' + name);
}

rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch (_) { return; }
  const id = req.id, method = req.method, params = req.params || {};
  const run = async () => {
    try {
      if (method === 'invoke_tool') {
        const args = safeParse(params.arguments);
        const result = await handleTool(params.tool, args);
        reply({ id, result: { result } });
      } else if (method === 'invoke_action') {
        const result = await handleAction(params.action, params.input || {});
        reply({ id, result });
      } else {
        reply({ id, error: { message: 'unknown method ' + method } });
      }
    } catch (e) {
      reply({ id, error: { message: String(e && e.message || e) } });
    }
  };
  run();
});
