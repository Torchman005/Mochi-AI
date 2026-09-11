'use strict';
// codex.js —— 运行 Codex CLI，流式输出并发射进度事件（供宿主中途播报）。

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

function emit(event, data) {
  // 事件行：{"event": "...", "data": {...}}。宿主 sidecar 读循环会把它路由给进度回调。
  process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

function detectCodexNodeScript() {
  if (process.platform !== 'win32') return null;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['codex'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).filter(Boolean)[0];
    if (first) {
      const base = path.dirname(first);
      const cand = path.join(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(cand)) return cand;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function buildArgs(task, cwd, config) {
  const args = ['exec'];
  if (config.codex_json !== false) args.push('--json');
  if (config.dangerous) args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (config.full_auto !== false) args.push('--approve-for-me');
  else if (config.sandbox) args.push('--sandbox', String(config.sandbox));
  if (config.model) args.push('--model', String(config.model));
  args.push('--skip-git-repo-check', '-C', cwd);
  (config.extra_args || []).forEach((a) => args.push(String(a)));
  args.push(incrementalTask(task, config));
  return args;
}

// 判断某行是否像「有意义的一步」，用于中途播报。
const stepPattern = /(reading|planning|writing|creating|running|executing|testing|installing|updating|deleting|modifying|generating|searching|exploring)/i;
const patchPattern = /(apply_patch|patch|file_change|file_update|edit|write|modify|create|delete)/i;

function incrementalTask(task, config) {
  if (config.incremental_review === false) return task;
  return [
    '你正在为一个需要在 VS Code 源代码管理中实时评审的桌宠代码助手工作。',
    '请按小步修改：每完成一个文件或一个独立逻辑块，就立即把该块写入磁盘，然后再继续下一块。',
    '不要把所有文件改动攒到最后一次性写入；不要自动 git add、git commit 或 git push。',
    '如果需要大改，优先拆成多个较小的补丁/写入动作，让外部 VS Code 能持续看到未暂存变更。',
    '',
    '原始任务：',
    task,
  ].join('\n');
}

function jsonEventText(event) {
  if (!event || typeof event !== 'object') return '';
  const item = event.item || {};
  const type = event.type || event.event || event.name || event.msg || '';
  const status = item.status || event.status || event.state || '';
  const message = item.text || event.error?.message || event.message || event.summary || event.text || event.delta || '';
  const files = (Array.isArray(item.changes) ? item.changes : []).map((change) => change.path).filter(Boolean).join(', ');
  return [type, item.type, status, message, files].filter((value) => typeof value === 'string' && value).join(' · ');
}

function processOutputLine(rawLine, state, cwd, emitReviewStatus) {
  const s = rawLine.trim();
  if (!s) return;
  try {
    const event = JSON.parse(s);
    const eventText = jsonEventText(event);
    const item = event?.item || {};
    if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
      state.humanOut += item.text + '\n';
    }
    if (event?.type === 'error' || event?.type === 'turn.failed' || item.type === 'error') {
      state.lastError = event.error?.message || event.message || item.message || eventText;
      if (event.type === 'turn.failed') state.failed = true;
      emit('agent_progress', { message: 'Codex 连接或执行异常：' + state.lastError, cwd, level: 'error' });
    }
    const patchEvent = item.type === 'file_change' || patchPattern.test(item.tool || item.name || '');
    if (patchEvent) {
      const key = JSON.stringify([event.type, item.id, item.status, item.changes]);
      if (key !== state.lastPatchEvent) {
        state.lastPatchEvent = key;
        emit('agent_progress', {
          message: 'Codex 文件变更：' + eventText.slice(0, 240),
          cwd,
          codexEvent: event,
        });
        emitReviewStatus();
      }
    }
    if (!patchEvent && eventText && stepPattern.test(eventText) && eventText.length < 300) {
      state.steps.push(eventText);
      emit('agent_progress', { message: eventText.slice(0, 200) });
    }
    return;
  } catch (_) { /* plain text output */ }
  state.humanOut += s + '\n';
  if (stepPattern.test(s) && s.length < 300) {
    state.steps.push(s);
    emit('agent_progress', { message: s.slice(0, 200) });
  }
}

function runCodex(task, cwd, config, hooks = {}) {
  return new Promise((resolve) => {
    const cmd = String(config.agent_command || 'codex');
    const args = buildArgs(task, cwd, config);
    const script = detectCodexNodeScript();
    const useNode = script && cmd === 'codex';
    const spawnCmd = useNode ? process.execPath : cmd;
    const spawnArgs = useNode ? [script].concat(args) : args;
    const shell = !useNode && process.platform === 'win32';

    emit('agent_progress', { message: '开始执行编码 agent：' + task.slice(0, 160), cwd });

    const child = spawn(spawnCmd, spawnArgs, { cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    let stdoutBuffer = '';
    const decoder = new StringDecoder('utf8');
    const outputState = { humanOut: '', steps: [], lastPatchEvent: '', lastError: '', failed: false };
    let lastReviewStatus = '';
    const emitReviewStatus = () => {
      if (typeof hooks.reviewStatus !== 'function') return;
      try {
        const status = hooks.reviewStatus() || {};
        const key = JSON.stringify({ count: status.count || 0, files: (status.files || []).map((f) => {
          // File names alone do not change when the next patch edits the same file.
          let version = null;
          try {
            const stat = fs.statSync(path.resolve(cwd, f.path));
            version = [stat.size, stat.mtimeMs, stat.ctimeMs];
          } catch (_) { /* deleted or not yet written */ }
          return [f.kind, f.path, f.oldPath, version];
        }) });
        if (key === lastReviewStatus) return;
        lastReviewStatus = key;
        emit('agent_progress', {
          message: `VS Code 实时评审：${status.count || 0} 个文件有未暂存改动`,
          cwd,
          review: { ...status, files: (status.files || []).slice(0, 20) },
        });
      } catch (_) { /* ignore status polling errors */ }
    };
    const reviewTimer = setInterval(emitReviewStatus, Math.max(1000, Number(config.review_poll_ms || 2000)));
    emitReviewStatus();
    child.stdout.on('data', (d) => {
      const text = decoder.write(d);
      out += text;
      emitReviewStatus();
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        processOutputLine(line, outputState, cwd, emitReviewStatus);
      }
    });
    child.stderr.on('data', (d) => { errOut += d; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      clearInterval(reviewTimer);
      if (stdoutBuffer) processOutputLine(stdoutBuffer, outputState, cwd, emitReviewStatus);
      emitReviewStatus();
      resolve({ err: Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }), stdout: outputState.humanOut || out, rawStdout: out, stderr: errOut, steps: outputState.steps, lastError: outputState.lastError });
    }, config.timeout_ms || 600000);

    child.on('error', (e) => {
      clearTimeout(timer);
      clearInterval(reviewTimer);
      if (stdoutBuffer) processOutputLine(stdoutBuffer, outputState, cwd, emitReviewStatus);
      emitReviewStatus();
      resolve({ err: e, stdout: outputState.humanOut || out, rawStdout: out, stderr: errOut, steps: outputState.steps });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(reviewTimer);
      stdoutBuffer += decoder.end();
      if (stdoutBuffer) processOutputLine(stdoutBuffer, outputState, cwd, emitReviewStatus);
      emitReviewStatus();
      const err = code === 0 && !outputState.failed ? null : Object.assign(new Error(outputState.lastError || 'exit ' + code), { code });
      resolve({ err, stdout: outputState.humanOut || out, rawStdout: out, stderr: errOut, steps: outputState.steps, lastError: outputState.lastError });
    });
  });
}

module.exports = { runCodex };
