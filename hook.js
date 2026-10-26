// auto-ship 的 hook 入口：PreToolUse 記下動到的 repo、擋未問可見性的新增 repo；Stop 時要求 commit＋push
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const L = require('./lib');

const out = (obj) => process.stdout.write(JSON.stringify(obj));
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);
const NEW_REPO = /\bgit(?:\s+-C\s+\S+)?\s+init\b|\bgh\s+repo\s+create\b|toolkeeper[\\/]cli\.js["']?\s+new\b/i;
const SECRET = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx)|[^/]*(secret|credential)[^/]*)$/i;
const SAFE_ENV = /\.env\.(example|sample|template)$/i;
const LABEL = { public: '公開', private: '私人' };
const LIST_MAX = 8;

const metaFile = (sd) => path.join(sd, 'meta.json');
const meta = (sd) => L.readJson(metaFile(sd), {});
const saveMeta = (sd, patch) => fs.writeFileSync(metaFile(sd), JSON.stringify({ ...meta(sd), ...patch }));
const exempt = (p, cfg) => cfg.exemptDirs.some((d) => L.under(p, d));
const skipped = (root, cfg) => cfg.skip.some((d) => L.under(root, d));
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

function visOf(text) {
  const pri = /私人|私有|private/i.test(text);
  const pub = /公開|public/i.test(text);
  return pri === pub ? null : pri ? 'private' : 'public';
}

// Git Bash 的 /c/x 與 ~ 轉成一般路徑
function toPath(p, cwd) {
  let s = p.replace(/^["']|["']$/g, '');
  if (/^\/[a-z]\//i.test(s)) s = `${s[1]}:${s.slice(2)}`;
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(cwd, s);
}

function shellDirs(cmd, cwd) {
  const dirs = [cwd];
  const re = /(?:^|[;&|(]\s*)(?:cd|pushd|Set-Location|sl)\s+(?:-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|)]+)|\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi;
  for (const m of String(cmd).matchAll(re)) dirs.push(toPath(m[1] || m[2], cwd));
  return dirs;
}

function targetDirs(tool, ti, cwd) {
  if (SHELLS.has(tool)) return cwd ? shellDirs(ti.command || '', cwd) : [];
  const f = ti.file_path || ti.notebook_path;
  return f ? [path.dirname(path.resolve(cwd || '.', f))] : [];
}

// dirs.log 一行一個「資料夾<TAB>repo 根目錄」；根目錄空白＝當時不在 repo 裡，「-」＝豁免
function knownDirs(sd) {
  const map = new Map();
  for (const line of L.readLines(path.join(sd, 'dirs.log'))) {
    const [d, r] = line.split('\t');
    map.set(L.norm(d), r || '');
  }
  return map;
}

function track(sd, dirs, cfg) {
  const known = knownDirs(sd);
  for (const d of dirs) {
    if (known.has(L.norm(d))) continue;
    let root = '-';
    if (!exempt(d, cfg)) {
      root = L.repoRoot(d) || '';
      if (root && skipped(root, cfg)) root = '-';
      if (root && root !== '-') L.saveBaseline(sd, root);
    }
    known.set(L.norm(d), root);
    fs.appendFileSync(path.join(sd, 'dirs.log'), `${L.slash(d)}\t${root}\n`);
  }
}

function gate(cmd, cwd, sd, cfg) {
  if (!cmd || !NEW_REPO.test(cmd)) return null;
  if ((cwd && exempt(cwd, cfg)) || cfg.exemptDirs.some((d) => L.norm(cmd).includes(L.norm(d)))) return null;
  const vis = meta(sd).visibility;
  if (!vis) return deny('auto-ship：新增 repo 前要先用 AskUserQuestion 問使用者這個 repo 要設「公開」還是「私人」（選項就用這兩個詞），問完再重跑這個指令。');
  if (/\bgh\s+repo\s+create\b/i.test(cmd)) {
    const flags = (cmd.match(/--(public|private|internal)\b/gi) || []).map((f) => f.slice(2).toLowerCase());
    if (flags.length !== 1 || flags[0] !== vis) return deny(`auto-ship：使用者選了${LABEL[vis]}，gh repo create 要帶 --${vis}，而且只帶這一個可見性參數。`);
  }
  return null;
}

function onPreToolUse(input, cfg) {
  const tool = input.tool_name;
  if (!FILE_TOOLS.has(tool) && !SHELLS.has(tool)) return;
  const ti = input.tool_input || {};
  const sd = L.sessionDir(input.session_id);
  if (SHELLS.has(tool)) {
    const d = gate(ti.command, input.cwd, sd, cfg);
    if (d) return out(d);
  }
  track(sd, targetDirs(tool, ti, input.cwd), cfg);
  const f = ti.file_path || ti.notebook_path;
  if (FILE_TOOLS.has(tool) && f) fs.appendFileSync(path.join(sd, 'touched.log'), `${L.slash(path.resolve(input.cwd || '.', f))}\n`);
}

// 只看使用者選的答案；找不到答案欄位時，先拿掉題目與選項文字再判斷
function answerText(input) {
  const ti = input.tool_input || {};
  const tr = input.tool_response;
  const ans = (tr && typeof tr === 'object' && tr.answers) || ti.answers;
  if (ans && typeof ans === 'object') return Object.values(ans).join(' ');
  let s = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
  const picked = [...s.matchAll(/"=\\?"([^"\\]*)/g)].map((m) => m[1]);
  if (picked.length) return picked.join(' ');
  for (const q of ti.questions || []) {
    for (const t of [q.question, q.header, ...(q.options || []).flatMap((o) => [o.label, o.description])]) if (t) s = s.split(t).join(' ');
  }
  return s;
}

function onPostToolUse(input) {
  if (input.tool_name !== 'AskUserQuestion') return;
  const v = visOf(answerText(input));
  if (v) saveMeta(L.sessionDir(input.session_id), { visibility: v });
}

// 使用者自己在 prompt 裡講了（提到 repo，或很短的回答）也算數
function onUserPromptSubmit(input) {
  const p = String(input.prompt || '');
  const v = visOf(p);
  if (v && (/repo|儲存庫/i.test(p) || p.trim().length <= 20)) saveMeta(L.sessionDir(input.session_id), { visibility: v });
}

const fmt = (list) => (list.length > LIST_MAX ? `${list.slice(0, LIST_MAX).join(', ')} 等 ${list.length} 個` : list.join(', '));

function inspect(rec, touched, vis) {
  const root = rec.root;
  const cur = L.status(root);
  const rel = touched.filter((t) => L.under(t, root)).map((t) => L.norm(t).slice(L.norm(root).length + 1));
  const mine = (p) => rec.base[p] !== cur[p] || rel.some((t) => t === L.norm(p) || (p.endsWith('/') && t.startsWith(L.norm(p))));
  const changed = Object.keys(cur).filter(mine);
  const secret = changed.filter((p) => SECRET.test(p.replace(/\/$/, '')) && !SAFE_ENV.test(p));
  const files = changed.filter((p) => !secret.includes(p));
  const before = Object.keys(cur).filter((p) => !mine(p));
  const branch = L.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const h = L.head(root);
  const remotes = (L.git(root, ['remote']) || '').split('\n').filter(Boolean);
  const upstream = L.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const moved = rec.newRepo ? !!h : !!h && h !== rec.head;
  const lines = [];
  if (files.length) lines.push(`未 commit：${fmt(files)}`);
  if (!branch && (files.length || moved)) lines.push('detached HEAD：只 commit 不 push，並告訴使用者');
  else if (remotes.length && upstream) {
    const ahead = Number(L.git(root, ['rev-list', '--count', '@{u}..HEAD']) || 0);
    if (files.length || (moved && ahead > 0)) lines.push(`push 到 ${upstream}${ahead ? `（已有 ${ahead} 個 commit 未 push）` : ''}`);
  } else if (remotes.length && (files.length || moved)) lines.push(`還沒有上游分支：git push -u ${remotes.includes('origin') ? 'origin' : remotes[0]} ${branch}`);
  else if (!remotes.length && rec.newRepo && (files.length || moved)) {
    lines.push(vis ? `沒有遠端：gh repo create <名稱> --${vis} --source . --push` : '沒有遠端：先用 AskUserQuestion 問使用者要「公開」還是「私人」，再 gh repo create <名稱> --<public|private> --source . --push');
  }
  if (!lines.length && !secret.length) return null;
  if (secret.length) lines.push(`疑似機密（不要 commit，先問使用者）：${fmt(secret)}`);
  if (before.length) lines.push(`原本就未 commit（不是這個 session 改的，不要加）：${fmt(before)}`);
  return `- ${root}（${branch || 'detached HEAD'}）\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

function onStop(input, cfg) {
  L.cleanup();
  const sd = path.join(L.STATE, String(input.session_id).replace(/[^\w-]/g, '_'));
  if (!fs.existsSync(sd)) return;
  // 當時不在 repo、現在在 repo 裡＝這個 session 新增的 repo
  for (const [d, r] of knownDirs(sd)) {
    if (r !== '') continue;
    const root = L.repoRoot(d);
    if (!root || skipped(root, cfg)) continue;
    const file = L.repoFile(sd, root);
    if (!L.readJson(file, {}).newRepo) fs.writeFileSync(file, JSON.stringify({ root: L.slash(root), head: null, base: {}, newRepo: true }));
  }
  const touched = L.readLines(path.join(sd, 'touched.log'));
  const m = meta(sd);
  const report = fs.readdirSync(sd).filter((f) => /^repo-.*\.json$/.test(f))
    .map((f) => L.readJson(path.join(sd, f), null))
    .filter((rec) => rec && fs.existsSync(rec.root) && !skipped(rec.root, cfg))
    .map((rec) => inspect(rec, touched, m.visibility)).filter(Boolean);
  if (!report.length) return;
  const body = report.join('\n');
  const sig = crypto.createHash('sha1').update(body).digest('hex');
  // 同樣的狀況已經擋過一次還是停下，就放行並提醒使用者，避免無限迴圈
  if (input.stop_hook_active && m.lastBlock === sig) {
    return out({ systemMessage: `auto-ship：還有改動沒 commit／push\n${body}` });
  }
  saveMeta(sd, { lastBlock: sig });
  out({
    decision: 'block',
    reason: `auto-ship：這個 session 改過的 repo 還沒 commit＋push。使用者的預設是改完就 commit 並 push 到目前分支，不用等指示、不開新分支：只 add 下面列的檔，commit 訊息用台灣繁中。push 被拒、有衝突或沒權限就停下說明；停下是在等使用者回答的話，再停一次即可。\n${body}`,
  });
}

function main() {
  const cfg = L.loadConfig();
  const input = L.readStdin();
  if (!input.session_id) return;
  if (cfg.debug) fs.writeFileSync(path.join(L.sessionDir(input.session_id), `debug-${input.hook_event_name}.json`), JSON.stringify(input, null, 2));
  switch (input.hook_event_name) {
    case 'PreToolUse': return onPreToolUse(input, cfg);
    case 'PostToolUse': return onPostToolUse(input);
    case 'UserPromptSubmit': return onUserPromptSubmit(input);
    case 'Stop': return onStop(input, cfg);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { process.stderr.write(`auto-ship：${e.message}\n`); }
}
module.exports = { visOf, shellDirs, answerText, NEW_REPO };
