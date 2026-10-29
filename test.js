// auto-ship 測試：既有 repo 改檔、原有未 commit 的檔、迴圈保護、新 repo 預設公開、既有 repo 可見性不能擅改、機密檔、別人的 repo 不准 push
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
const L = require('./lib');
// 假裝 gh 登入帳號是 me，不打 GitHub API
fs.mkdirSync(path.join(home, 'state'));
fs.writeFileSync(path.join(home, 'state', 'gh-user.json'), JSON.stringify({ login: 'me' }));

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
  assert.ok(H.CREATE.test('cd x && gh repo create foo --public'));
  assert.ok(!H.CREATE.test('echo "gh repo create" > notes.md'));
  assert.ok(H.EDIT_VIS.test('gh repo edit a/b --visibility private --accept-visibility-change-consequences'));
  assert.ok(H.EDIT_VIS.test('gh api -X PATCH repos/a/b -f private=true'));
  assert.ok(!H.EDIT_VIS.test('gh repo edit a/b --description x'));
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

const isDeny = (r) => r && r.hookSpecificOutput.permissionDecision === 'deny';
const post = (sid, command, stdout) => run({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
const prompt = (sid, text) => run({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: text });

test('新 repo：不問直接放行，預設公開，建好提醒告訴使用者', () => {
  const dir = path.join(tmp, 'fresh');
  fs.mkdirSync(dir);
  assert.strictEqual(pre('s4', 'Bash', { command: 'git init' }, dir), null);
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'n.txt'), 'n');
  const r = stop('s4');
  assert.match(r.reason, /未 commit：n\.txt/);
  assert.match(r.reason, /gh repo create <名稱> --public --source \. --push（預設公開/);
  assert.ok(isDeny(pre('s4', 'Bash', { command: 'gh repo create fresh --source .' }, dir)));
  assert.ok(isDeny(pre('s4', 'Bash', { command: 'gh repo create fresh --private --source .' }, dir)));
  assert.strictEqual(pre('s4', 'Bash', { command: 'gh repo create fresh --public --source . --push' }, dir), null);
  const ctx = post('s4', 'gh repo create fresh --public --source . --push', 'https://github.com/u/fresh\n').hookSpecificOutput.additionalContext;
  assert.match(ctx, /github\.com\/u\/fresh 已設為公開/);
  assert.strictEqual(post('s4', 'gh repo create fresh --public', 'HTTP 422'), null);
  assert.strictEqual(post('s4', 'git status', 'https://github.com/u/fresh'), null);
});

test('使用者在 prompt 指定私人就用私人', () => {
  const dir = path.join(tmp, 'fresh2');
  fs.mkdirSync(dir);
  prompt('s6', '幫我開個私人 repo 放筆記');
  assert.ok(isDeny(pre('s6', 'Bash', { command: 'gh repo create notes --public' }, dir)));
  assert.strictEqual(pre('s6', 'Bash', { command: 'gh repo create notes --private' }, dir), null);
});

test('既有 repo 可見性：使用者這一輪沒提就不能改', () => {
  const dir = path.join(tmp, 'fresh2');
  const cmd = 'gh repo edit u/a --visibility private --accept-visibility-change-consequences';
  prompt('s9', '幫我改 README');
  assert.match(pre('s9', 'Bash', { command: cmd }, dir).hookSpecificOutput.permissionDecisionReason, /沿用/);
  prompt('s9', '把這個 repo 改成私人');
  assert.strictEqual(pre('s9', 'Bash', { command: cmd }, dir), null);
  prompt('s9', '好，繼續');
  assert.ok(isDeny(pre('s9', 'Bash', { command: cmd }, dir)));
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

test('純函式：遠端擁有者、push 參數', () => {
  assert.strictEqual(L.remoteOwner('https://github.com/a/b.git'), 'a');
  assert.strictEqual(L.remoteOwner('git@github.com:A/b.git'), 'A'); // toolkeeper: allow
  assert.strictEqual(L.remoteOwner('ssh://git@h:22/o/r'), 'o');
  assert.strictEqual(L.remoteOwner('https://u:t@github.com/x/y'), 'x'); // toolkeeper: allow
  assert.strictEqual(L.remoteOwner('C:\\x\\y.git'), null);
  assert.strictEqual(L.remoteOwner('../r.git'), null);
  assert.strictEqual(H.pushArg(' -u origin main'), 'origin');
  assert.strictEqual(H.pushArg(' -o ci.skip --force'), null);
  assert.strictEqual(H.pushArg(' --repo=https://github.com/z/w'), 'https://github.com/z/w');
});

test('別人的 repo：不准 push，Stop 只要求 commit', () => {
  const dir = makeRepo('r10');
  sh(dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/other/r10.git');
  pre('s10', 'Edit', { file_path: path.join(dir, 'a.txt') }, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'w');
  const r = stop('s10');
  assert.match(r.reason, /別人的 repo（other）：只 commit/);
  assert.doesNotMatch(r.reason, /push 到 origin/);
  for (const cmd of ['git push', 'git push -u origin main', 'git add . && git commit -m x && git push']) assert.ok(isDeny(pre('s10', 'Bash', { command: cmd }, dir)), cmd);
  assert.ok(isDeny(pre('s10', 'Bash', { command: `git -C "${dir}" push` }, tmp)));
  assert.ok(isDeny(pre('s10', 'PowerShell', { command: `cd "${dir}"; git push origin main` }, tmp)));
  assert.strictEqual(pre('s10', 'Bash', { command: 'echo "git push" > notes.md' }, dir), null);
  sh(dir, 'commit', '-q', '-am', 'x');
  assert.strictEqual(stop('s10', true), null);
});

test('自己的 repo（gh 帳號或 owners）與本機遠端：push 放行', () => {
  const dir = makeRepo('r11');
  sh(dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/Me/r11.git');
  assert.strictEqual(pre('s11', 'Bash', { command: 'git push' }, dir), null);
  assert.ok(isDeny(pre('s11', 'Bash', { command: 'git push https://github.com/other/x.git main' }, dir)));
  fs.writeFileSync(path.join(home, 'config.local.json'), JSON.stringify({ owners: ['Other'] }));
  assert.strictEqual(pre('s11', 'Bash', { command: 'git push https://github.com/other/x.git main' }, dir), null);
  fs.rmSync(path.join(home, 'config.local.json'));
  assert.strictEqual(pre('s11', 'Bash', { command: 'git push' }, makeRepo('r12')), null);
});

test('豁免暫存資料夾', () => {
  fs.writeFileSync(path.join(home, 'config.local.json'), JSON.stringify({ exemptTmp: true }));
  const dir = makeRepo('r8');
  pre('s8', 'Edit', { file_path: path.join(dir, 'a.txt') }, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'q');
  assert.strictEqual(stop('s8'), null);
  fs.rmSync(path.join(home, 'config.local.json'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`全部通過（${n} 項）`);
