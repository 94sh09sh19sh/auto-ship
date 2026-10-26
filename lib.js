// auto-ship 共用函式：設定、session 狀態、git 查詢
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = process.env.AUTO_SHIP_HOME || __dirname;
const STATE = path.join(HOME, 'state');
const WIN = process.platform === 'win32';
const KEEP_DAYS = 7;

const slash = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const norm = (p) => (WIN ? slash(p).toLowerCase() : slash(p));
const under = (p, dir) => { const a = norm(p); const b = norm(dir); return a === b || a.startsWith(`${b}/`); };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  const cfg = { skip: [], exempt: [], exemptTmp: true, ...readJson(path.join(HOME, 'config.json'), {}), ...readJson(path.join(HOME, 'config.local.json'), {}) };
  cfg.exemptDirs = [...cfg.exempt, ...(cfg.exemptTmp ? [os.tmpdir()] : [])];
  return cfg;
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// porcelain 開頭的空白有意義，raw 時不 trim
function git(dir, args, raw = false) {
  try {
    const s = execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return raw ? s : s.trim();
  } catch { return null; }
}

// 路徑還不存在（Write 到新資料夾）就往上找存在的祖先
function repoRoot(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) return null; d = up; }
  return git(d, ['rev-parse', '--show-toplevel']);
}

// porcelain -z：{ 相對路徑: 'XY' }；改名的條目後面多一個原路徑要跳過
function status(root) {
  const raw = git(root, ['status', '--porcelain=v1', '-z'], true);
  const map = {};
  if (raw === null) return map;
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    map[p.slice(3)] = xy;
    if (/[RC]/.test(xy[0])) i++;
  }
  return map;
}

const head = (root) => git(root, ['rev-parse', '-q', '--verify', 'HEAD']);

// session 狀態：多個 hook 可能同時跑，記錄一律附加寫入或 wx 建檔，不改寫共用檔
function sessionDir(sid) {
  const d = path.join(STATE, String(sid).replace(/[^\w-]/g, '_'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const repoFile = (sd, root) => path.join(sd, `repo-${crypto.createHash('sha1').update(norm(root)).digest('hex').slice(0, 12)}.json`);
const readLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function saveBaseline(sd, root) {
  const file = repoFile(sd, root);
  if (fs.existsSync(file)) return;
  const h = head(root);
  // 還沒有任何 commit 的 repo 視為本 session 新增，裡面的檔都算本輪產物
  const rec = { root: slash(root), head: h, base: h ? status(root) : {}, newRepo: !h };
  try { fs.writeFileSync(file, JSON.stringify(rec), { flag: 'wx' }); } catch {}
}

function cleanup() {
  let names = [];
  try { names = fs.readdirSync(STATE); } catch { return; }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const n of names) {
    const d = path.join(STATE, n);
    try { if (fs.statSync(d).mtimeMs < cutoff) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { HOME, STATE, slash, norm, under, readJson, loadConfig, readStdin, git, repoRoot, status, head, sessionDir, repoFile, readLines, saveBaseline, cleanup };
