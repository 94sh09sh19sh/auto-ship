// auto-ship 測試：既有 repo 改檔、原有未 commit 的檔、迴圈保護、新增 repo 的可見性關卡、機密檔
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ship-test-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ skip: [path.join(tmp, 'skipped')], exempt: [], exemptTmp: false }));
const HOOK = path.join(__dirname, 'hook.js');
const H = require('./hook');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function run(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, AUTO_SHIP_HOME: home, ...env } });
  assert.strictEqual(r.stderr, '', r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const pre = (sid, tool, ti, cwd) => run({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: tool, tool_input: ti, cwd });
const stop = (sid, active = false) => run({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: active });

function makeRepo(name) {
  const bare = path.join(tmp, `${name}.git`);
  const dir = path.join(tmp, name);
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(tmp, 'clone', '-q', bare, dir);
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  sh(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

let n = 0;
function test(name, fn) { fn(); n++; console.log(`ok ${name}`); }

test('純函式：可見性判斷、Git Bash 路徑', () => {
  assert.strictEqual(H.visOf('私人'), 'private');
  assert.strictEqual(H.visOf('公開 (Recommended)'), 'public');
  assert.strictEqual(H.visOf('公開還是私人'), null);
  const d = H.shellDirs('cd /c/x/y && git -C "D:/z" status', 'C:/w');
  assert.deepStrictEqual(d.map((p) => p.replace(/\\/g, '/').toLowerCase()), ['c:/w', 'c:/x/y', 'd:/z']);
  assert.ok(H.NEW_REPO.test('node ~/.claude/toolkeeper/cli.js new foo'));
  assert.ok(!H.NEW_REPO.test('git initialize'));
});

test('既有 repo：改檔要求 commit＋push，原有未 commit 的檔不算', () => {
  const dir = makeRepo('r1');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'user wip');
  const f = path.join(dir, 'a.txt');
  assert.strictEqual(pre('s1', 'Edit', { file_path: f }, dir), null);
  fs.writeFileSync(f, '2');
  const r = stop('s1');
  assert.strictEqual(r.decision, 'block');
  assert.match(r.reason, /未 commit：a\.txt/);
  assert.match(r.reason, /push 到 origin\/main/);
  assert.match(r.reason, /原本就未 commit.*old\.txt/);
  // 同樣狀況再停一次就放行，只提醒
  const again = stop('s1', true);
  assert.ok(!again.decision && /還有改動/.test(again.systemMessage));
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'x');
  assert.match(stop('s1', true).reason, /已有 1 個 commit 未 push/);
  sh(dir, 'push', '-q');
  assert.strictEqual(stop('s1'), null);
});

test('只用 Bash 改檔也會被抓到', () => {
  const dir = makeRepo('r2');
  pre('s2', 'Bash', { command: 'echo hi > b.txt' }, dir);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hi');
  assert.match(stop('s2').reason, /未 commit：b\.txt/);
});

test('沒動到的 repo、不在 repo 裡、skip 清單：都不輸出', () => {
  makeRepo('r3');
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  pre('s3', 'Write', { file_path: path.join(plain, 'x.md') }, plain);
  fs.writeFileSync(path.join(plain, 'x.md'), 'x');
  assert.strictEqual(stop('s3'), null);
  const sk = makeRepo('skipped');
  pre('s3b', 'Edit', { file_path: path.join(sk, 'a.txt') }, sk);
  fs.writeFileSync(path.join(sk, 'a.txt'), 'z');
  assert.strictEqual(stop('s3b'), null);
  assert.strictEqual(stop('never-seen'), null);
});

test('新增 repo：沒問可見性先擋，問完放行，gh 參數要一致', () => {
  const dir = path.join(tmp, 'fresh');
  fs.mkdirSync(dir);
  const d = pre('s4', 'Bash', { command: 'git init' }, dir);
  assert.strictEqual(d.hookSpecificOutput.permissionDecision, 'deny');
  const q = { questions: [{ question: '要公開還是私人？', header: '可見性', options: [{ label: '公開', description: '' }, { label: '私人', description: '' }] }] };
  run({ hook_event_name: 'PostToolUse', session_id: 's4', tool_name: 'AskUserQuestion', tool_input: q, tool_response: { ...q, answers: { '要公開還是私人？': '私人' } } });
  assert.strictEqual(pre('s4', 'Bash', { command: 'git init' }, dir), null);
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'n.txt'), 'n');
  const r = stop('s4');
  assert.match(r.reason, /未 commit：n\.txt/);
  assert.match(r.reason, /gh repo create <名稱> --private --source \. --push/);
  assert.strictEqual(pre('s4', 'Bash', { command: 'gh repo create fresh --public --source .' }, dir).hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(pre('s4', 'Bash', { command: 'gh repo create fresh --private --source . --push' }, dir), null);
});

test('答案欄位缺少時從回傳字串判斷；使用者在 prompt 直接講也算', () => {
  const dir = path.join(tmp, 'fresh2');
  fs.mkdirSync(dir);
  const q = { questions: [{ question: '要公開還是私人？', header: '可見性', options: [{ label: '公開', description: '' }, { label: '私人', description: '' }] }] };
  run({ hook_event_name: 'PostToolUse', session_id: 's5', tool_name: 'AskUserQuestion', tool_input: q, tool_response: 'User has answered your questions: "要公開還是私人？"="公開".' });
  assert.match(pre('s5', 'Bash', { command: 'gh repo create x --private' }, dir).hookSpecificOutput.permissionDecisionReason, /--public/);
  run({ hook_event_name: 'UserPromptSubmit', session_id: 's6', prompt: '幫我開個私人 repo 放筆記' });
  assert.strictEqual(pre('s6', 'Bash', { command: 'gh repo create notes --private' }, dir), null);
});

test('機密檔另外列出、不要 commit', () => {
  const dir = makeRepo('r7');
  pre('s7', 'Write', { file_path: path.join(dir, '.env') }, dir);
  fs.writeFileSync(path.join(dir, '.env'), 'K=1');
  fs.writeFileSync(path.join(dir, '.env.example'), 'K=');
  const r = stop('s7');
  assert.match(r.reason, /疑似機密.*\.env(?!\.)/);
  assert.match(r.reason, /未 commit：\.env\.example/);
});

test('豁免暫存資料夾', () => {
  fs.writeFileSync(path.join(home, 'config.local.json'), JSON.stringify({ exemptTmp: true }));
  const dir = makeRepo('r8');
  assert.strictEqual(pre('s8', 'Bash', { command: 'git init sub' }, dir), null);
  pre('s8', 'Edit', { file_path: path.join(dir, 'a.txt') }, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'q');
  assert.strictEqual(stop('s8'), null);
  fs.rmSync(path.join(home, 'config.local.json'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`全部通過（${n} 項）`);
