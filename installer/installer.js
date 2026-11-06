'use strict';

// Claude Salesforce Bridge - interactive installer
// Author: Matheus Bertol (https://github.com/Matheus-Bertol)
// Source: https://github.com/Matheus-Bertol/claude-salesforce-bridge
// License: MIT
// Registers mcp-remote connections named "salesforce-conector-<name>" in
// Claude Code (%USERPROFILE%\.claude.json) and Claude Desktop
// (claude_desktop_config.json), runs the first sign-in and tests the connection.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const VERSION = '0.1.0-beta';
const PREFIX = 'salesforce-conector-';
const APP = 'CLAUDE SALESFORCE BRIDGE';
const WIDTH = 66;
const DEFAULT_PORT = 8080;
const TEST_TIMEOUT_MS = 180000;
// mcp-remote args that change the hash of its login files (see loginFiles).
const HASH_FLAGS = ['--resource', '--header', '--authorize-param', '--client-metadata-url', '--token-endpoint'];

// ---------------------------------------------------------------- terminal UI

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inverse: '\x1b[7m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const paint = (color, s) => color + s + c.reset;
const out = (s = '') => process.stdout.write(s + '\n');
const ok = (s) => out(paint(c.green, '  [ok] ') + s);
const warn = (s) => out(paint(c.yellow, '  [!]  ') + s);
const fail = (s) => out(paint(c.red, '  [x]  ') + s);
const info = (s) => out('  ' + s);
const row = (k, v) => out('  ' + paint(c.dim, k.padEnd(14)) + v);

function clear() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}
function header(crumbs = [], subtitle) {

  clear();
  const line = '-'.repeat(WIDTH);
  out(paint(c.cyan, line));
  out(paint(c.cyan, '|'));
  out(paint(c.cyan, '|  ') + paint(c.bold, [APP, ...crumbs].join('  >  ')));
  if (subtitle) out(paint(c.cyan, '|  ') + paint(c.dim, subtitle));
  out(paint(c.cyan, '|'));
  out(paint(c.cyan, line));
  out('');
}

function setRaw(v) {
  if (process.stdin.isTTY) process.stdin.setRawMode(v);
}

function exitNow() {
  setRaw(false);
  out('');
  process.exit(0);
}

// Arrow-key menu. Returns the chosen index, or -1 on Esc.
// With multi: true, Space toggles and Enter returns an array of indices.
function select(crumbs, prompt, options, { subtitle, body, multi = false, checked = [] } = {}) {
  return new Promise((resolve) => {
    let idx = options.findIndex((o) => !o.disabled);
    const marks = new Set(checked);

    const render = () => {
      header(crumbs, subtitle);
      if (body) body();
      if (prompt) {
        out('  ' + paint(c.bold, prompt));
        out('');
      }
      options.forEach((o, i) => {
        const box = multi ? (marks.has(i) ? '[x] ' : '[ ] ') : '';
        const text = `${i + 1}. ${box}${o.label}`;
        const hint = o.hint ? '  ' + paint(c.dim, o.hint) : '';
        if (o.disabled) out('     ' + paint(c.dim, text + (o.hint ? `  (${o.hint})` : '')));
        else if (i === idx) out('  ' + paint(c.cyan + c.inverse, ` > ${text} `) + hint);
        else out('     ' + text + hint);
      });
      out('');
      out(paint(c.dim, multi
        ? '  Up/Down move   Space mark/unmark   Enter confirm   Esc back'
        : '  Up/Down move   Enter select   1-9 shortcut   Esc back'));
    };

    const move = (d) => {
      let n = idx;
      for (let k = 0; k < options.length; k++) {
        n = (n + d + options.length) % options.length;
        if (!options[n].disabled) { idx = n; return; }
      }
    };

    const done = (v) => {
      process.stdin.removeListener('keypress', onKey);
      setRaw(false);
      process.stdin.pause();
      resolve(v);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') exitNow();
      if (key.name === 'up') { move(-1); render(); }
      else if (key.name === 'down' || key.name === 'tab') { move(1); render(); }
      else if (key.name === 'escape') done(-1);
      else if (multi && key.name === 'space' && idx >= 0) {
        if (marks.has(idx)) marks.delete(idx); else marks.add(idx);
        render();
      }
      else if (key.name === 'return' || key.name === 'enter') {
        if (multi) done([...marks].sort());
        else if (idx >= 0) done(idx);
      }
      else if (!multi && /^[1-9]$/.test(str || '')) {
        const n = Number(str) - 1;
        if (options[n] && !options[n].disabled) done(n);
      }
    };

    readline.emitKeypressEvents(process.stdin);
    setRaw(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    render();
  });
}

// Reads one line. Returns null on Esc. Only the first line of a multi-line paste
// is used: whatever arrives right after it is discarded so it does not fall
// into the next prompt.
function question(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    const finish = (a) => {
      if (closed) return;
      closed = true;
      process.stdin.removeListener('keypress', onKey);
      rl.close();
      setRaw(true);
      process.stdin.resume();
      setTimeout(() => {
        setRaw(false);
        process.stdin.pause();
        resolve(a);
      }, 50);
    };
    const onKey = (s, key = {}) => {
      if (key.name === 'escape') finish(null);
    };
    rl.on('SIGINT', () => { rl.close(); exitNow(); });
    rl.question(q, (a) => finish(a));
    process.stdin.on('keypress', onKey);
  });
}

// Text input in the "|  " style. Returns null to go back: Esc, "back"/"cancel",
// or Enter left empty with no current value.
async function ask(label, { help, current, mask, validate, normalize } = {}) {
  for (;;) {
    out('  ' + paint(c.bold, label));
    if (help) out('  ' + paint(c.dim, help));
    if (current !== undefined) {
      out('  ' + paint(c.dim, `Current: ${mask ? maskValue(current) : current}  (Enter keeps it, Esc or "back" cancels)`));
    } else {
      out('  ' + paint(c.dim, 'Leave empty and press Enter (or Esc, or type "back") to go back.'));
    }
    out(paint(c.cyan, '|'));
    const raw = await question(paint(c.cyan, '|  '));
    out('');
    if (raw === null) return null;
    let answer = raw.trim();
    if (/^(back|cancel)$/i.test(answer)) return null;
    if (answer === '') {
      if (current === undefined) return null;
      answer = current;
    }
    const value = normalize ? normalize(answer) : answer;
    const err = validate ? validate(value) : null;
    if (!err) return value;
    fail(err);
    out('');
  }
}

function pause(msg = 'Press any key to continue...') {
  return new Promise((resolve) => {
    out('');
    out(paint(c.dim, '  ' + msg));
    readline.emitKeypressEvents(process.stdin);
    setRaw(true);
    process.stdin.resume();
    process.stdin.once('keypress', (s, key = {}) => {
      if (key.ctrl && key.name === 'c') exitNow();
      setRaw(false);
      process.stdin.pause();
      resolve();
    });
  });
}

function maskValue(v) {
  if (!v) return '';
  return v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : '****';
}

// ---------------------------------------------------------------- config files

const claudeCodeConfig = () => path.join(os.homedir(), '.claude.json');

function desktopConfigPaths() {
  const list = [];
  const { APPDATA, LOCALAPPDATA } = process.env;
  if (APPDATA && fs.existsSync(path.join(APPDATA, 'Claude'))) {
    list.push(path.join(APPDATA, 'Claude', 'claude_desktop_config.json'));
  }
  if (LOCALAPPDATA) {
    const base = path.join(LOCALAPPDATA, 'Claude-Data'); // Microsoft Store version
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (d.startsWith('claude_')) list.push(path.join(base, d, 'claude_desktop_config.json'));
      }
    }
  }
  return list;
}

function targets() {
  const file = claudeCodeConfig();
  const list = [{ client: 'Claude Code', file, exists: fs.existsSync(file) }];
  for (const f of desktopConfigPaths()) list.push({ client: 'Claude Desktop', file: f, exists: fs.existsSync(f) });
  return list;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not read ${file}: invalid JSON (${e.message}). Nothing was changed.`);
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeJsonWithBackup(file, data) {
  let backup = null;
  if (fs.existsSync(file)) {
    const st = stamp();
    backup = `${file}.bak-${st}`;
    for (let n = 2; fs.existsSync(backup); n++) backup = `${file}.bak-${st}-${n}`; // never overwrite a backup
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
    if (backup) e.backup = backup;
    throw e;
  }
  return backup;
}

// Undoes writes made by writeJsonWithBackup ({ file, backup }), newest first:
// restores the backup, or removes the file when it did not exist before.
// Returns the writes that could not be undone.
function rollback(written) {
  const failed = [];
  for (const w of written.slice().reverse()) {
    try {
      if (w.backup) fs.copyFileSync(w.backup, w.file);
      else fs.unlinkSync(w.file);
    } catch {
      failed.push(w);
    }
  }
  return failed;
}

function serversIn(data, scope) {
  if (scope) return data.projects && data.projects[scope] ? data.projects[scope].mcpServers : undefined;
  return data.mcpServers;
}

function buildServer(cfg) {
  return {
    command: 'npx',
    args: [
      '-y', 'mcp-remote', cfg.url, String(cfg.port),
      '--static-oauth-client-info', JSON.stringify({ client_id: cfg.clientId }),
      '--host', 'localhost',
    ],
  };
}

function parseServer(server) {
  const args = server && Array.isArray(server.args) ? server.args.map(String) : [];
  const u = args.findIndex((a) => /^https?:\/\//i.test(a));
  const url = u >= 0 ? args[u] : '';
  const portSet = u >= 0 && /^\d+$/.test(args[u + 1] || '');
  const port = portSet ? Number(args[u + 1]) : DEFAULT_PORT;
  let clientId = '';
  let infoFile = '';
  const o = args.indexOf('--static-oauth-client-info');
  if (o >= 0 && args[o + 1]) {
    if (args[o + 1].startsWith('@')) infoFile = args[o + 1].slice(1);
    try {
      let raw = args[o + 1];
      if (raw.startsWith('@')) raw = fs.readFileSync(raw.slice(1), 'utf8');
      clientId = JSON.parse(raw).client_id || '';
    } catch { /* shown as "not found" */ }
  }
  const h = args.indexOf('--host');
  const hostLocalhost = h >= 0 && args[h + 1] === 'localhost';
  const hashFlags = HASH_FLAGS.filter((f) => args.includes(f));
  const authDir = server && server.env && server.env.MCP_REMOTE_CONFIG_DIR ? String(server.env.MCP_REMOTE_CONFIG_DIR) : '';
  return { url, port, portSet, clientId, infoFile, hostLocalhost, hashFlags, authDir };
}

// Updates URL, port and client id in an existing entry, keeping any other
// arguments the user added (--debug, "cmd /c", ...). Builds a new entry otherwise.
// With a "writes" array, a client info file (@file) is queued there instead of
// being written right away, so the caller can write it after the main config.
function applyConfig(server, cfg, writes) {
  if (!server || !Array.isArray(server.args)) return buildServer(cfg);
  const s = JSON.parse(JSON.stringify(server));
  const a = s.args;
  const u = a.findIndex((x) => /^https?:\/\//i.test(String(x)));
  if (u < 0) return buildServer(cfg);
  a[u] = cfg.url;
  if (/^\d+$/.test(String(a[u + 1] || ''))) a[u + 1] = String(cfg.port);
  else a.splice(u + 1, 0, String(cfg.port));
  const o = a.indexOf('--static-oauth-client-info');
  const infoArg = JSON.stringify({ client_id: cfg.clientId });
  if (o < 0) a.push('--static-oauth-client-info', infoArg);
  else if (String(a[o + 1] || '').startsWith('@')) {
    const infoFile = String(a[o + 1]).slice(1);
    const current = fs.existsSync(infoFile) ? readJson(infoFile) : {};
    current.client_id = cfg.clientId;
    if (writes) writes.push({ file: infoFile, data: current });
    else writeJsonWithBackup(infoFile, current);
  } else a[o + 1] = infoArg;
  if (!a.includes('--host')) a.push('--host', 'localhost');
  return s;
}

// Writes the main config first, then any client info file. If one write fails,
// the ones already made are undone. Successful writes are added to "written".
function saveEntry({ file, scope, oldName, name, cfg, written }) {
  const data = readJson(file); // read right before writing
  let servers;
  if (scope) {
    data.projects = data.projects || {};
    data.projects[scope] = data.projects[scope] || {};
    servers = data.projects[scope].mcpServers = data.projects[scope].mcpServers || {};
  } else {
    servers = data.mcpServers = data.mcpServers || {};
  }
  const base = oldName ? servers[oldName] : servers[name];
  const writes = [];
  const server = applyConfig(base, cfg, writes);
  if (oldName && oldName !== name) delete servers[oldName];
  servers[name] = server;
  const mine = [];
  try {
    mine.push({ file, backup: writeJsonWithBackup(file, data) });
    for (const w of writes) mine.push({ file: w.file, backup: writeJsonWithBackup(w.file, w.data) });
  } catch (e) {
    const failed = rollback(mine);
    e.message += failed.length
      ? ` Could not undo the change in: ${failed.map((w) => w.file).join(', ')}.`
      : (mine.length ? ' The change was undone.' : '');
    e.backups = mine.map((w) => w.backup).concat(e.backup || []).filter(Boolean);
    throw e;
  }
  if (written) written.push(...mine);
  return mine[0].backup;
}

// Removes only the server key from its mcpServers, keeping the rest of the JSON.
// Backup first. Successful writes are added to "written". Returns the backup.
function removeEntry({ file, scope, name, written }) {
  const data = readJson(file); // read right before writing
  const servers = serversIn(data, scope);
  if (!servers || typeof servers !== 'object' || !servers[name]) {
    throw new Error(`${name} was not found in ${file}${scope ? ` (project ${scope})` : ''}.`);
  }
  delete servers[name];
  const backup = writeJsonWithBackup(file, data);
  if (written) written.push({ file, backup });
  return backup;
}

// All or nothing: removes each { file, scope, name }; if one fails, the files
// already changed are restored. Used by the menu (and later by --remove).
function removeEntries(entries) {
  const written = [];
  const removed = [];
  for (const e of entries) {
    try {
      removed.push({ entry: e, backup: removeEntry({ file: e.file, scope: e.scope, name: e.name, written }) });
    } catch (err) {
      const notUndone = rollback(written);
      const kept = written.filter((w) => w.backup && !notUndone.includes(w)).map((w) => w.backup)
        .concat(err.backup || []);
      return { ok: false, removed: [], error: { entry: e, message: err.message }, notUndone, kept };
    }
  }
  return { ok: true, removed, notUndone: [], kept: [] };
}

function serverExists(file, name, scope) {
  try {
    const servers = serversIn(readJson(file), scope);
    return !!(servers && servers[name]);
  } catch {
    return false;
  }
}

function findInstallations() {
  const found = [];
  const errors = [];
  for (const t of targets()) {
    if (!t.exists) continue;
    let data;
    try { data = readJson(t.file); } catch (e) { errors.push(e.message); continue; }
    const scan = (servers, scope) => {
      if (!servers || typeof servers !== 'object') return;
      for (const [name, server] of Object.entries(servers)) {
        if (name.startsWith(PREFIX)) found.push({ name, client: t.client, file: t.file, scope, ...parseServer(server) });
      }
    };
    scan(data.mcpServers, null);
    if (t.client === 'Claude Code' && data.projects && typeof data.projects === 'object') {
      for (const p of Object.keys(data.projects)) scan(serversIn(data, p), p);
    }
  }
  return { found, errors };
}

// ---------------------------------------------------------------- environment

function npxCliPath() {
  const p = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return fs.existsSync(p) ? p : null;
}

function claudeRunning() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { encoding: 'utf8' });
  return /claude\.exe/i.test(r.stdout || '');
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, 'localhost');
  });
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

let envCache;
function envBody() {
  if (!envCache) {
    const t = targets();
    envCache = {
      node: process.versions.node,
      npx: !!npxCliPath(),
      code: t.find((x) => x.client === 'Claude Code'),
      desktop: t.filter((x) => x.client === 'Claude Desktop'),
    };
  }
  const e = envCache;
  ok(`Node.js v${e.node}`);
  if (e.npx) ok('npx'); else fail('npx not found next to Node.js');
  if (e.code.exists) ok(`Claude Code   ${paint(c.dim, e.code.file)}`);
  else warn(`Claude Code config not found ${paint(c.dim, '(will be created if you install there)')}`);
  if (e.desktop.length) e.desktop.forEach((d) => ok(`Claude Desktop ${paint(c.dim, d.file)}`));
  else warn('Claude Desktop not found');
  out('');
}

// ---------------------------------------------------------------- fields

// Pasted values often come with spaces or quotes around them.
const clean = (v) => String(v).trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();

const FIELDS = {
  name: {
    label: 'Set the connection name',
    help: [
      'A short name that identifies this Salesforce connection in Claude.',
      `  It is saved as ${PREFIX}<name>, for example ${PREFIX}sales or ${PREFIX}sandbox.`,
      '  Use lowercase letters, numbers and hyphens (max 40 characters).',
      '  Tip: use different names for each org (production, sandbox...).',
    ].join('\n'),
    normalize: (v) => {
      const s = clean(v).toLowerCase();
      return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
    },
    validate: (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(v) && !v.endsWith('-') && !v.includes('--')
      ? null
      : 'Use lowercase letters, numbers and single hyphens (max 40), starting and ending with a letter or number.'),
  },
  url: {
    label: 'Set the Server URL',
    help: [
      'The address of the Salesforce Hosted MCP server Claude will connect to.',
      '  Find it in Salesforce: Setup > MCP Servers > your server > Server URL.',
      '  Copy it exactly as shown - it depends on the org, do not type it by hand.',
      '  The server must be active. If you do not have access to Setup,',
      '  ask your Salesforce administrator.',
    ].join('\n'),
    normalize: clean,
    validate: (v) => {
      let u = null;
      try { u = new URL(v); } catch { /* invalid */ }
      if (!u || !/^https:\/\/\S+$/i.test(v) || u.protocol !== 'https:' || !u.hostname) {
        return 'It must be the full Server URL, starting with https://';
      }
      if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())) {
        return 'The Server URL must point to Salesforce, not to this computer (localhost).';
      }
      return null;
    },
  },
  clientId: {
    label: 'Set the Consumer Key',
    help: [
      'Identifies the External Client App that Claude uses to sign you in.',
      '  Find it in Salesforce: Setup > External Client App Manager > your app >',
      '  Manage Consumer Details > Consumer Key.',
      '  Only the Consumer Key is needed - no Consumer Secret.',
      '  If you do not have access to Setup, ask your Salesforce administrator.',
    ].join('\n'),
    mask: true,
    normalize: clean,
    validate: (v) => (/^\S{10,}$/.test(v)
      ? null
      : 'Paste the full Consumer Key, without spaces.'),
  },
  port: {
    label: 'Set the callback port',
    help: [
      'This is the local port used only during sign-in: Salesforce sends you back to',
      '  http://localhost:<port>/oauth/callback after you log in.',
      '  It must match the Callback URL configured in the External Client App.',
      '  Default is 8080. Press Enter to keep it.',
      '  If you are not sure, ask your Salesforce administrator.',
    ].join('\n'),
    normalize: clean,
    validate: (v) => (/^\d+$/.test(v) && +v >= 1024 && +v <= 65535
      ? null
      : 'Use a number between 1024 and 65535 (for example 8080).'),
  },
};

async function askField(key, current) {
  const f = FIELDS[key];
  const cur = current === undefined || current === null || current === '' ? undefined : String(current);
  const v = await ask(f.label, { help: f.help, current: cur, mask: f.mask, validate: f.validate, normalize: f.normalize });
  if (v === null) return null;
  return key === 'port' ? Number(v) : v;
}

// ---------------------------------------------------------------- flows

async function chooseTargets(crumbs, subtitle, current) {
  const list = targets();
  const options = list.map((t) => ({
    label: t.client,
    hint: t.exists ? t.file : `${t.file}  (not found, will be created)`,
  }));
  if (!list.some((t) => t.client === 'Claude Desktop')) options.push({ label: 'Claude Desktop', hint: 'not found', disabled: true });
  const checked = current
    ? list.map((t, i) => (current.some((x) => x.file === t.file) ? i : -1)).filter((i) => i >= 0)
    : list.map((t, i) => (t.exists ? i : -1)).filter((i) => i >= 0);
  let error = '';
  for (;;) {
    const picked = await select(crumbs, 'Where should it be installed?', options, {
      subtitle, multi: true, checked,
      body: error ? () => { fail(error); out(''); } : undefined,
    });
    if (picked === -1) return null;
    if (picked.length) return picked.map((i) => list[i]);
    error = 'Mark at least one with Space.';
  }
}

function reviewBody(s, warnings) {
  row('Name', paint(c.bold, PREFIX + s.name));
  row('Server URL', s.url);
  row('Consumer Key', maskValue(s.clientId));
  if (s.mode !== 'create' && s.entry.portSet === false && s.port === s.entry.port) {
    row('Callback URL', paint(c.yellow, '(not set; mcp-remote picks a port from the server URL)'));
    row('', paint(c.dim, `Saving sets port ${s.port}: http://localhost:${s.port}/oauth/callback`));
  } else {
    row('Callback URL', `http://localhost:${s.port}/oauth/callback`);
  }
  if (s.mode === 'create') {
    s.targets.forEach((t, i) => row(i ? '' : 'Install in', `${t.client}  ${paint(c.dim, t.file)}`));
  } else {
    row('Installed in', `${s.entry.client}  ${paint(c.dim, s.entry.file)}`);
    if (s.entry.scope) row('Project', s.entry.scope);
  }
  out('');
  warnings.forEach(warn);
  if (warnings.length) out('');
}

function reviewWarnings(s, portBusy) {
  const name = PREFIX + s.name;
  const w = [];
  // Same name in other places of the file (global list or Claude Code projects).
  const elsewhere = (client, file, skipScope) => {
    let data;
    try { data = readJson(file); } catch { return; }
    if (skipScope && serversIn(data, null) && serversIn(data, null)[name]) w.push(`${name} also exists in ${client} (global).`);
    if (!data.projects || typeof data.projects !== 'object') return;
    for (const p of Object.keys(data.projects)) {
      const servers = serversIn(data, p);
      if (p !== skipScope && servers && servers[name]) w.push(`${name} also exists in ${client} (project ${p}).`);
    }
  };
  if (s.mode === 'create') {
    for (const t of s.targets) {
      if (serverExists(t.file, name, null)) w.push(`${name} already exists in ${t.client}. Saving replaces it.`);
      elsewhere(t.client, t.file, null);
    }
  } else if (name !== s.entry.name) {
    if (serverExists(s.entry.file, name, s.entry.scope)) w.push(`${name} already exists in ${s.entry.client}. Saving replaces it.`);
    elsewhere(s.entry.client, s.entry.file, s.entry.scope);
  }
  if (s.port !== DEFAULT_PORT) w.push(`Port ${s.port}: update the Callback URL in Salesforce to match.`);
  if (portBusy) w.push(`Port ${s.port} is in use right now (often by Claude or an old mcp-remote). Sign-in may fail until it is free.`);
  return w;
}

async function confirmClaudeClosed(crumbs, continueLabel = 'Save anyway') {
  for (;;) {
    if (!claudeRunning()) return true;
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Check again', hint: 'after closing Claude' },
      { label: continueLabel },
      { label: 'Cancel' },
    ], {
      subtitle: 'Claude is running',
      body: () => {
        warn('Claude seems to be open. It rewrites its config files and may undo this change.');
        info('Close Claude completely, including the icon in the system tray.');
        out('');
      },
    });
    if (i !== 0) return i === 1;
  }
}

async function save(crumbs, s) {
  const name = PREFIX + s.name;
  // Saving over an existing connector with the same name needs an explicit yes.
  const taken = s.mode === 'create'
    ? s.targets.filter((t) => serverExists(t.file, name, null))
    : (name !== s.entry.name && serverExists(s.entry.file, name, s.entry.scope) ? [s.entry] : []);
  if (taken.length) {
    const r = await select(crumbs, taken.length === 1
      ? `Replace existing connector ${name} in ${taken[0].client}?`
      : `Replace existing connector ${name} in ${taken.length} places?`, [
      { label: 'No, back to review' },
      { label: 'Yes, replace it' },
    ], {
      subtitle: 'Save',
      body: () => {
        taken.forEach((t) => warn(`${name} already exists in ${t.client}${t.scope ? ` (project ${t.scope})` : ''}.`));
        taken.forEach((t) => info(paint(c.dim, t.file)));
        out('');
      },
    });
    if (r !== 1) return false;
  }
  if (!(await confirmClaudeClosed(crumbs))) return false;
  const cfg = { url: s.url, clientId: s.clientId, port: s.port };
  const jobs = s.mode === 'create'
    ? s.targets.map((t) => ({ client: t.client, file: t.file, scope: null, oldName: null }))
    : [{ client: s.entry.client, file: s.entry.file, scope: s.entry.scope, oldName: s.entry.name }];

  // All or nothing: if one file fails, the files already saved are restored.
  const written = [];
  const saved = [];
  let error = null;
  for (const j of jobs) {
    try {
      saved.push({ j, backup: saveEntry({ ...j, name, cfg, written }) });
    } catch (e) {
      error = { j, e };
      break;
    }
  }
  const notUndone = error ? rollback(written) : [];
  envCache = undefined;

  const allOk = !error;
  const lines = [];
  if (allOk) {
    for (const { j, backup } of saved) {
      lines.push(() => ok(`${j.client}: saved ${name}`));
      lines.push(() => info(paint(c.dim, j.file)));
      if (backup) lines.push(() => info(paint(c.dim, `Backup: ${backup}`)));
    }
  } else {
    lines.push(() => fail(`${error.j.client}: ${error.e.message}`));
    lines.push(() => info(paint(c.dim, error.j.file)));
    for (const j of jobs) {
      if (j === error.j) continue;
      const wasSaved = saved.some((x) => x.j === j);
      if (!wasSaved) lines.push(() => info(`${j.client}: not changed`));
      else if (!notUndone.some((w) => w.file === j.file)) lines.push(() => info(`${j.client}: not changed (the save was undone)`));
      lines.push(() => info(paint(c.dim, j.file)));
    }
    for (const w of notUndone) {
      lines.push(() => fail(w.backup
        ? `Could not undo the change in ${w.file}. Restore it from ${w.backup}`
        : `Could not remove ${w.file}, created by this save.`));
    }
    const kept = written.filter((w) => w.backup && !notUndone.includes(w)).map((w) => w.backup)
      .concat(error.e.backups || []);
    if (kept.length) {
      lines.push(() => out(''));
      lines.push(() => info('Backups made before the error were kept on disk:'));
      kept.forEach((b) => lines.push(() => info(paint(c.dim, b))));
    }
  }

  const i = await select(crumbs, allOk ? 'Saved. Next step:'
    : (notUndone.length ? 'Save failed and could not be fully undone.' : 'Save failed. Nothing was changed.'), allOk
    ? [{ label: 'Sign in and test the connection now', hint: 'recommended' }, { label: 'Back to menu' }]
    : [{ label: 'Back to review' }], {
    subtitle: 'Save',
    body: () => { lines.forEach((l) => l()); out(''); },
  });
  if (!allOk) return false;
  if (i === 0) await testConnection(crumbs, { name, ...cfg });
  return true;
}

async function reviewFlow(crumbs, s) {
  for (;;) {
    const options = [
      { label: 'Save', key: 'save' },
      { label: 'Change connection name', key: 'name' },
      { label: 'Change Server URL', key: 'url' },
      { label: 'Change Consumer Key', key: 'clientId' },
      { label: 'Change callback port', key: 'port' },
    ];
    if (s.mode === 'create') options.push({ label: 'Change where to install', key: 'targets' });
    options.push({ label: 'Cancel', key: 'cancel' });

    // Non-blocking check; gives up after a short wait.
    const portBusy = await Promise.race([
      portFree(s.port).then((free) => !free),
      new Promise((r) => setTimeout(r, 500, false)),
    ]);
    const warnings = reviewWarnings(s, portBusy);
    const i = await select(crumbs, 'Review and save', options, {
      subtitle: s.mode === 'create' ? 'Review' : `Editing ${s.entry.name}`,
      body: () => reviewBody(s, warnings),
    });
    const key = i < 0 ? 'cancel' : options[i].key;
    if (key === 'cancel') return false;
    if (key === 'save') {
      if (await save(crumbs, s)) return true;
      continue;
    }
    if (key === 'targets') {
      const t = await chooseTargets(crumbs, 'Change where to install', s.targets);
      if (t) s.targets = t;
      continue;
    }
    header(crumbs, 'Change value');
    const v = await askField(key, s[key]);
    if (v !== null) s[key] = v;
  }
}

async function createFlow() {
  const crumbs = ['Configure', 'Create'];
  const s = { mode: 'create', name: '', url: '', clientId: '', port: DEFAULT_PORT, targets: [] };
  const steps = ['name', 'url', 'clientId', 'port'];
  // "Back" (Esc) returns one step; on step 1 it returns to the menu.
  for (let n = 0; n <= steps.length;) {
    if (n === steps.length) {
      const t = await chooseTargets(crumbs, 'Step 5 of 5', null);
      if (!t) { n--; continue; }
      s.targets = t;
      break;
    }
    header(crumbs, `Step ${n + 1} of 5`);
    const v = await askField(steps[n], s[steps[n]]);
    if (v === null) {
      if (n === 0) return;
      n--;
      continue;
    }
    s[steps[n]] = v;
    n++;
  }
  await reviewFlow(crumbs, s);
}

function editState(entry) {
  return {
    mode: 'edit', entry,
    name: entry.name.slice(PREFIX.length),
    url: entry.url, clientId: entry.clientId, port: entry.port,
  };
}

function listBody(found, errors) {
  info(paint(c.dim, `Searching for ${PREFIX}* in:`));
  targets().forEach((t) => info(paint(c.dim, `  ${t.client.padEnd(15)} ${t.file}${t.exists ? '' : '  (not found)'}`)));
  out('');
  errors.forEach(fail);
  if (!found.length) {
    warn('No connections found.');
  } else {
    ok(`${found.length} connection(s) found:`);
    out('');
    found.forEach((e) => {
      out('     ' + paint(c.bold, e.name) + '  ' + paint(c.dim, e.client + (e.scope ? ` (project ${e.scope})` : '')));
      out('     ' + paint(c.dim, e.url || '(Server URL not found)'));
    });
  }
  out('');
}

async function pickInstallation(crumbs) {
  const { found, errors } = findInstallations();
  if (!found.length) {
    header(crumbs);
    errors.forEach(fail);
    warn(`No ${PREFIX}* connections found.`);
    await pause();
    return null;
  }
  const options = found.map((e) => ({ label: e.name, hint: e.client + (e.scope ? ` - project ${e.scope}` : '') }));
  options.push({ label: 'Back' });
  const i = await select(crumbs, 'Which one?', options, { body: errors.length ? () => { errors.forEach(fail); out(''); } : undefined });
  return i < 0 || i === found.length ? null : found[i];
}

function detailsBody(e) {
  row('Name', paint(c.bold, e.name));
  row('Client', e.client);
  if (e.scope) row('Project', `${e.scope}  ${paint(c.dim, '(loads only in this folder)')}`);
  row('Config file', e.file);
  row('Server URL', e.url || paint(c.yellow, '(not found in args)'));
  row('Consumer Key', e.clientId ? maskValue(e.clientId) : paint(c.yellow, '(not found)'));
  row('Callback URL', e.portSet === false
    ? paint(c.yellow, '(not set; mcp-remote picks a port from the server URL)')
    : `http://localhost:${e.port}/oauth/callback`);
  out('');
}

const placeText = (e) => `${e.client}${e.scope ? ` (project ${e.scope})` : ''}`;

// Removes a connector from one or more places. Returns true if something was removed.
async function removeFlow(crumbs, e) {
  crumbs = [...crumbs, 'Remove'];
  const places = findInstallations().found.filter((x) => x.name === e.name);
  const same = (x) => x.file === e.file && x.scope === e.scope;
  if (!places.some(same)) places.unshift(e);
  let chosen = places;
  if (places.length > 1) {
    let error = '';
    for (;;) {
      const picked = await select(crumbs, `Remove ${e.name} from where?`, places.map((x) => ({
        label: placeText(x), hint: x.file,
      })), {
        subtitle: e.name, multi: true, checked: [places.findIndex(same)],
        body: error ? () => { fail(error); out(''); } : undefined,
      });
      if (picked === -1) return false;
      if (picked.length) { chosen = picked.map((i) => places[i]); break; }
      error = 'Mark at least one with Space.';
    }
  }

  // The installer never creates @client-info files, so they are always kept.
  const infoFiles = [...new Set(chosen.map((x) => x.infoFile).filter(Boolean))];
  const r = await select(crumbs, `Remove ${e.name}?`, [
    { label: 'Cancel' },
    { label: 'Remove', hint: 'a backup of each file is made first' },
  ], {
    subtitle: 'Confirm',
    body: () => {
      info('This removes only this connector entry. Everything else in the files is kept:');
      out('');
      chosen.forEach((x) => { row('From', placeText(x)); row('', paint(c.dim, x.file)); });
      out('');
      infoFiles.forEach((f) => info(paint(c.dim, `Client info file kept (not created by this installer): ${f}`)));
      if (infoFiles.length) out('');
    },
  });
  if (r !== 1) return false;
  if (!(await confirmClaudeClosed(crumbs, 'Continue anyway'))) return false;

  const res = removeEntries(chosen);
  envCache = undefined;
  await select(crumbs, res.ok ? 'Removed.'
    : (res.notUndone.length ? 'Remove failed and could not be fully undone.' : 'Remove failed. Nothing was changed.'),
  [{ label: 'Back' }], {
    subtitle: 'Remove',
    body: () => {
      if (res.ok) {
        res.removed.forEach(({ entry, backup }) => {
          ok(`${placeText(entry)}: removed ${entry.name}`);
          info(paint(c.dim, entry.file));
          if (backup) info(paint(c.dim, `Backup: ${backup}`));
        });
      } else {
        fail(`${placeText(res.error.entry)}: ${res.error.message}`);
        res.notUndone.forEach((w) => fail(w.backup
          ? `Could not undo the change in ${w.file}. Restore it from ${w.backup}`
          : `Could not undo the change in ${w.file}.`));
        if (res.kept.length) {
          out('');
          info('Backups made before the error were kept on disk:');
          res.kept.forEach((b) => info(paint(c.dim, b)));
        }
      }
      out('');
    },
  });
  return res.ok;
}

async function openMenu(e) {
  const crumbs = ['Check installations', 'Open'];
  for (;;) {
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Sign in and test connection', disabled: !e.url || !e.clientId },
      { label: 'Open config file in Notepad' },
      { label: 'Remove', hint: 'delete this connector from Claude' },
      { label: 'Back' },
    ], { subtitle: e.name, body: () => detailsBody(e) });
    if (i === 0) await testConnection(crumbs, e);
    else if (i === 1) spawn('notepad.exe', [e.file], { detached: true, stdio: 'ignore' }).unref();
    else if (i === 2) { if (await removeFlow(crumbs, e)) return; }
    else return;
  }
}

async function configureMenu() {
  const crumbs = ['Configure'];
  for (;;) {
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Create', hint: 'new connection' },
      { label: 'Edit existing' },
      { label: 'Back' },
    ]);
    if (i === 0) await createFlow();
    else if (i === 1) {
      const e = await pickInstallation([...crumbs, 'Edit existing']);
      if (e) await reviewFlow([...crumbs, 'Edit existing'], editState(e));
    } else return;
  }
}

async function checkMenu() {
  const crumbs = ['Check installations'];
  for (;;) {
    const { found, errors } = findInstallations();
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Open one of them', disabled: !found.length },
      { label: 'Edit', disabled: !found.length },
      { label: 'Back' },
    ], { body: () => listBody(found, errors) });
    if (i === 0) {
      const e = await pickInstallation([...crumbs, 'Open']);
      if (e) await openMenu(e);
    } else if (i === 1) {
      const e = await pickInstallation([...crumbs, 'Edit']);
      if (e) await reviewFlow([...crumbs, 'Edit'], editState(e));
    } else return;
  }
}

// ---------------------------------------------------------------- connection test

function failureHints(log, port) {
  const text = log.join('\n');
  const hints = [];
  if (/redirect_uri_mismatch/i.test(text)) hints.push(`Callback URL in Salesforce must be exactly http://localhost:${port}/oauth/callback`);
  if (/scope parameter not supported|invalid[_ ]token/i.test(text)) hints.push('Enable "Issue JWT-based access tokens for named users" in the External Client App, delete %USERPROFILE%\\.mcp-auth and try again.');
  if (/server definition not found|\b404\b/i.test(text)) hints.push('Check the Server URL (Setup > MCP Servers) and that the server is active.');
  if (/EADDRINUSE/i.test(text)) hints.push(`Port ${port} is in use. Find it with: netstat -ano | findstr :${port}`);
  return hints;
}

// With a "report" object it runs without the screen (command line mode): prints
// nothing to stdout, does not wait for keys, and fills report with the result.
async function testConnection(crumbs, cfg, report) {
  const batch = !!report;
  const cli = npxCliPath();
  if (!cli && batch) {
    Object.assign(report, { success: false, message: 'npx was not found next to Node.js.' });
    return false;
  }
  if (!cli) {
    header(crumbs, 'Sign in and test connection');
    fail('npx was not found next to Node.js. Reinstall Node.js LTS from https://nodejs.org.');
    return pause();
  }
  // Entries saved without a port: mcp-remote picks it, so do not add one here.
  const portKnown = cfg.portSet !== false;
  const portText = portKnown ? cfg.port : '<port>';
  if (portKnown && !batch && !(await portFree(cfg.port))) {
    const i = await select(crumbs, 'What do you want to do?', [{ label: 'Try anyway' }, { label: 'Back' }], {
      subtitle: 'Sign in and test connection',
      body: () => {
        warn(`Port ${cfg.port} is already in use, usually by an old mcp-remote process.`);
        info(paint(c.dim, `Find it with: netstat -ano | findstr :${cfg.port}   then end that node.exe`));
        out('');
      },
    });
    if (i !== 0) return false;
  }

  if (!batch) {
    header(crumbs, 'Sign in and test connection');
    info('If you are not signed in yet, your browser opens the Salesforce login.');
    info('Sign in there, then come back to this window.');
    out('');
  }

  return new Promise((resolve) => {
    const args = [
      cli, '-y', 'mcp-remote', cfg.url, ...(portKnown ? [String(cfg.port)] : []),
      '--static-oauth-client-info', JSON.stringify({ client_id: cfg.clientId }),
      '--host', 'localhost',
    ];
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const started = Date.now();
    const log = [];
    let finished = false;
    let outBuf = '';
    let errBuf = '';
    let authShown = false;
    let frame = 0;

    const line = (fn) => { if (batch) return; process.stdout.write('\r\x1b[K'); fn(); };
    const spin = batch ? null : setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      process.stdout.write('\r\x1b[K' + paint(c.cyan, `  [${'|/-\\'[frame++ % 4]}] `) + `Waiting for Salesforce... ${secs}s  ` + paint(c.dim, '(Esc to cancel)'));
    }, 120);
    const timer = setTimeout(() => finish(false, `No answer after ${TEST_TIMEOUT_MS / 1000}s.`), TEST_TIMEOUT_MS);

    const onKey = (s, key = {}) => {
      if (key.ctrl && key.name === 'c') { killTree(child); exitNow(); }
      if (key.name === 'escape') finish(false, 'Cancelled.', true);
    };
    if (!batch) {
      readline.emitKeypressEvents(process.stdin);
      setRaw(true);
      process.stdin.resume();
      process.stdin.on('keypress', onKey);
    }

    async function finish(success, message, quiet = false) {
      if (finished) return;
      finished = true;
      clearInterval(spin);
      clearTimeout(timer);
      if (batch) {
        killTree(child);
        Object.assign(report, { success, message, hints: success ? [] : failureHints(log, portText) });
        return resolve(success);
      }
      process.stdin.removeListener('keypress', onKey);
      setRaw(false);
      process.stdin.pause();
      killTree(child);
      process.stdout.write('\r\x1b[K');
      out('');
      if (success) {
        ok(message);
        info(`Open Claude: ${paint(c.bold, cfg.name)} should be listed under MCP servers.`);
        info(paint(c.dim, 'If it shows a warning, click Reconnect.'));
      } else {
        fail(message);
        if (!quiet) {
          failureHints(log, portText).forEach((h) => warn(h));
          if (log.length) {
            out('');
            info(paint(c.dim, 'Last lines from mcp-remote:'));
            log.slice(-8).forEach((l) => info(paint(c.dim, l.slice(0, WIDTH + 30))));
          }
        }
      }
      await pause();
      resolve(success);
    }

    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* process gone */ } };
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish(false, `Could not start mcp-remote: ${e.message}`));
    child.on('exit', (code) => finish(false, `mcp-remote stopped (exit code ${code}).`));

    child.stdout.on('data', (d) => {
      outBuf += d.toString();
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const raw = outBuf.slice(0, i).trim();
        outBuf = outBuf.slice(i + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(false, `Server rejected the connection: ${msg.error.message}`);
          const server = msg.result && msg.result.serverInfo ? msg.result.serverInfo.name : 'server';
          if (batch) report.server = server;
          line(() => ok(`Signed in and connected to ${server}.`));
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish(false, `Could not list tools: ${msg.error.message}`);
          const tools = (msg.result && msg.result.tools) || [];
          if (batch) report.tools = tools.map((t) => t.name);
          line(() => ok(`${tools.length} tool(s) available:`));
          tools.slice(0, 15).forEach((t) => info(paint(c.dim, `  - ${t.name}`)));
          if (tools.length > 15) info(paint(c.dim, `  ...and ${tools.length - 15} more`));
          return finish(true, 'Connection OK. The token is saved and Claude will reuse it.');
        }
      }
    });

    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const l = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!l) continue;
        log.push(l);
        const url = l.match(/https:\/\/\S+\/authorize\S*/i);
        if (url && !authShown) {
          authShown = true;
          // The authorize URL carries the Consumer Key, so it is not printed here.
          if (batch) process.stderr.write('Sign in to Salesforce in the browser window that opened...\n');
          line(() => {
            warn('Sign in in the browser. If it did not open, copy this URL:');
            info(paint(c.dim, url[0]));
          });
        } else if (/EADDRINUSE/i.test(l)) {
          finish(false, `Port ${portText} is in use.`);
        }
      }
    });

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-salesforce-bridge-installer', version: VERSION },
      },
    });
  });
}

// ---------------------------------------------------------------- command line

const USAGE = [
  `Claude Salesforce Bridge installer v${VERSION}`,
  '',
  'Without options it opens the interactive menu. Options:',
  '  --list [--json]                       List salesforce-conector-* connections',
  '  --check <name> [--test] [--json]      Check a connection. --test also signs in',
  '                                        (may open the browser) and lists the tools',
  '  --remove <name> --from code|desktop|all --yes [--json]',
  '                                        Remove a connection (backup .bak first).',
  '                                        --from is required with --yes; code and',
  '                                        all include every Claude Code project',
  '  --clear-login <name> --yes [--json]   Move the saved login of a connection to',
  '                                        a backup folder inside .mcp-auth',
  '  --version, --help',
  '',
  'Without --yes, --remove and --clear-login only show what they would do',
  'and exit with code 2 (nothing is changed).',
  'Exit codes: 0 ok, 1 problem found or action failed, 2 usage error.',
].join('\n');

// mcp-remote keeps the login in <base>\mcp-remote-<version>\<hash>_*.json, where
// <hash> is the md5 of the Server URL as written in the args (other parts only
// with HASH_FLAGS, which are not supported here) and <base> is
// MCP_REMOTE_CONFIG_DIR or %USERPROFILE%\.mcp-auth.
function loginFiles(e) {
  const base = e.authDir || process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth');
  const r = { base, supported: false, reason: '', hash: '', files: [], saved: false };
  if (!e.url) { r.reason = 'Server URL not found in args.'; return r; }
  if (e.hashFlags.length) { r.reason = `Uses ${e.hashFlags.join(', ')}: its login files cannot be identified safely.`; return r; }
  r.supported = true;
  r.hash = crypto.createHash('md5').update(e.url).digest('hex');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('mcp-remote-'));
  } catch { /* no login saved yet */ }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(base, d.name)); } catch { /* unreadable */ }
    for (const f of names) if (f.startsWith(`${r.hash}_`)) r.files.push(path.join(base, d.name, f));
  }
  r.saved = r.files.some((f) => f.endsWith('_tokens.json'));
  return r;
}

function entryJson(e) {
  const login = loginFiles(e);
  return {
    name: e.name, client: e.client, scope: e.scope, file: e.file, url: e.url || null,
    port: e.portSet ? e.port : null, portSet: e.portSet, hostLocalhost: e.hostLocalhost,
    clientIdFound: !!e.clientId,
    login: { supported: login.supported, saved: login.supported ? login.saved : null },
  };
}

function parseCli(argv) {
  const o = { cmd: null, name: null, json: false, yes: false, test: false, from: null };
  const cmds = ['--help', '--version', '--list', '--check', '--remove', '--clear-login'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (cmds.includes(a)) {
      if (o.cmd) throw new Error('Use only one command at a time.');
      o.cmd = a.slice(2);
      if (['check', 'remove', 'clear-login'].includes(o.cmd)) {
        o.name = argv[++i];
        if (!o.name || o.name.startsWith('--')) throw new Error(`${a} needs a connection name.`);
      }
    } else if (a === '--json') o.json = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--test') o.test = true;
    else if (a === '--from') o.from = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!o.cmd) throw new Error('Missing command.');
  if (o.test && o.cmd !== 'check') throw new Error('--test works only with --check.');
  if (o.from !== null && o.cmd !== 'remove') throw new Error('--from works only with --remove.');
  if (o.from !== null && !['code', 'desktop', 'all'].includes(o.from)) throw new Error('--from must be code, desktop or all.');
  if (o.cmd === 'remove' && o.yes && o.from === null) {
    throw new Error('--remove with --yes needs --from code, desktop or all (code and all include every Claude Code project).');
  }
  if (o.name !== null) {
    const n = FIELDS.name.normalize(o.name);
    if (FIELDS.name.validate(n)) throw new Error(`Invalid connection name: ${o.name}`);
    o.name = PREFIX + n;
  }
  return o;
}

async function cliList(o) {
  const { found, errors } = findInstallations();
  const connections = found.map(entryJson);
  if (o.json) {
    console.log(JSON.stringify({ version: VERSION, ok: !errors.length, connections, errors }, null, 2));
  } else {
    errors.forEach(fail);
    if (!connections.length) warn('No connections found.');
    connections.forEach((x) => {
      out(`  ${x.name}  ${x.client}${x.scope ? ` (project ${x.scope})` : ''}`);
      row('  Config file', x.file);
      row('  Server URL', x.url || '(not found in args)');
      row('  Port', x.portSet ? String(x.port) : '(not set; mcp-remote picks it)');
      row('  Host', x.hostLocalhost ? '--host localhost' : '(--host localhost missing)');
      row('  Login', !x.login.supported ? '(cannot be checked)' : x.login.saved ? 'saved' : 'not saved');
      out('');
    });
  }
  return errors.length ? 1 : 0;
}

async function cliCheck(o) {
  const { found, errors } = findInstallations();
  const places = found.filter((e) => e.name === o.name);
  const add = (list, level, id, message) => list.push({ id, level, message });
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  add(checks, major >= 18 ? 'ok' : 'error', 'node', `Node.js v${process.versions.node}${major >= 18 ? '' : ' (18 or newer is required)'}`);
  add(checks, npxCliPath() ? 'ok' : 'error', 'npx', npxCliPath() ? 'npx found' : 'npx not found next to Node.js');
  errors.forEach((m) => add(checks, 'warn', 'config', m));
  if (!places.length) add(checks, 'error', 'entry', `${o.name} was not found.`);

  const result = { version: VERSION, name: o.name, ok: true, checks, places: [] };
  for (const p of places) {
    const pc = [];
    const urlErr = p.url ? FIELDS.url.validate(p.url) : 'Server URL not found in args.';
    add(pc, urlErr ? 'error' : 'ok', 'url', urlErr || `Server URL ${p.url}`);
    add(pc, p.clientId ? 'ok' : 'error', 'clientId', p.clientId ? 'Consumer Key found' : 'Consumer Key not found');
    add(pc, p.hostLocalhost ? 'ok' : 'error', 'host', p.hostLocalhost ? '--host localhost present' : '--host localhost missing (needed on Windows)');
    if (!p.portSet) {
      add(pc, 'warn', 'port', 'Port not set; mcp-remote picks a port from the server URL');
    } else {
      const portErr = FIELDS.port.validate(String(p.port));
      add(pc, portErr ? 'error' : 'ok', 'port', portErr || `Callback URL http://localhost:${p.port}/oauth/callback`);
      if (!portErr) {
        const free = await Promise.race([portFree(p.port), new Promise((r) => setTimeout(r, 500, true))]);
        add(pc, free ? 'ok' : 'warn', 'portFree', free ? `Port ${p.port} is free` : `Port ${p.port} is in use (often by Claude or an old mcp-remote)`);
      }
    }
    const login = loginFiles(p);
    add(pc, login.supported && login.saved ? 'ok' : 'warn', 'login',
      !login.supported ? login.reason : login.saved ? 'Login saved' : 'No saved login (sign in with --test or from Claude)');
    result.places.push({ client: p.client, scope: p.scope, file: p.file, checks: pc });
  }

  if (o.test) {
    const p = places.find((x) => x.url && x.clientId);
    if (!p) add(checks, 'error', 'test', 'Nothing to test: no entry with Server URL and Consumer Key.');
    else if (p.hashFlags.length || p.authDir) {
      add(checks, 'warn', 'test', 'Test not supported for this entry (custom auth dir or extra mcp-remote flags).');
    } else {
      if (!o.json) info(`Testing ${p.client}${p.scope ? ` (project ${p.scope})` : ''}... the browser may open for the Salesforce login.`);
      const report = {};
      await testConnection([], p, report);
      result.test = { client: p.client, scope: p.scope, file: p.file, success: !!report.success, message: report.message,
        server: report.server || null, tools: report.tools || [], hints: report.hints || [] };
    }
  }

  const all = checks.concat(...result.places.map((x) => x.checks));
  result.ok = !all.some((x) => x.level === 'error') && (!result.test || result.test.success);
  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const show = (x) => (x.level === 'ok' ? ok : x.level === 'warn' ? warn : fail)(x.message);
    checks.forEach(show);
    result.places.forEach((x) => {
      out('');
      out(`  ${o.name}  ${x.client}${x.scope ? ` (project ${x.scope})` : ''}`);
      info(paint(c.dim, x.file));
      x.checks.forEach(show);
    });
    if (result.test) {
      out('');
      (result.test.success ? ok : fail)(result.test.message || 'Test failed.');
      if (result.test.server) info(`Server: ${result.test.server}`);
      result.test.tools.forEach((t) => info(paint(c.dim, `  - ${t}`)));
      result.test.hints.forEach(warn);
    }
    out('');
    (result.ok ? ok : fail)(result.ok ? 'No problems found.' : 'Problems found.');
  }
  return result.ok ? 0 : 1;
}

async function cliRemove(o) {
  const from = o.from || 'all';
  const { found } = findInstallations();
  const places = found.filter((e) => e.name === o.name
    && (from === 'all' || (from === 'code') === (e.client === 'Claude Code')));
  const warnings = [];
  if (claudeRunning()) warnings.push('Claude seems to be open. It rewrites its config files and may undo this change. Restart Claude afterwards.');
  [...new Set(places.map((x) => x.infoFile).filter(Boolean))]
    .forEach((f) => warnings.push(`Client info file kept (not created by this installer): ${f}`));
  const where = places.map((x) => ({ client: x.client, scope: x.scope, file: x.file }));
  let result;
  let code;
  if (!places.length) {
    result = { ok: false, error: `${o.name} was not found${from === 'all' ? '' : ` in ${from}`}.` };
    code = 1;
  } else if (!o.yes) {
    result = { ok: false, dryRun: true, wouldRemove: where, error: 'Nothing was removed. Add --yes to remove.' };
    code = 2;
  } else {
    const res = removeEntries(places);
    envCache = undefined;
    result = {
      ok: res.ok,
      removed: res.removed.map((x) => ({ client: x.entry.client, scope: x.entry.scope, file: x.entry.file, backup: x.backup })),
      error: res.ok ? null : `${res.error.entry.client}: ${res.error.message}`,
      notUndone: res.notUndone, keptBackups: res.kept,
    };
    code = res.ok ? 0 : 1;
  }
  result = { version: VERSION, name: o.name, ...result, warnings };
  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    (result.wouldRemove || []).forEach((x) => info(`Would remove from ${x.client}${x.scope ? ` (project ${x.scope})` : ''}: ${x.file}`));
    (result.removed || []).forEach((x) => {
      ok(`Removed from ${x.client}${x.scope ? ` (project ${x.scope})` : ''}: ${x.file}`);
      if (x.backup) info(paint(c.dim, `Backup: ${x.backup}`));
    });
    if (result.error) fail(result.error);
    (result.notUndone || []).forEach((w) => fail(`Could not undo the change in ${w.file}${w.backup ? `. Restore it from ${w.backup}` : ''}`));
    (result.keptBackups || []).forEach((b) => info(paint(c.dim, `Backup kept: ${b}`)));
    warnings.forEach(warn);
  }
  return code;
}

async function cliClearLogin(o) {
  const { found } = findInstallations();
  const places = found.filter((e) => e.name === o.name);
  const warnings = [];
  let result;
  let code = 0;
  const logins = places.map(loginFiles);
  const bad = logins.find((l) => !l.supported);
  if (!places.length) {
    result = { ok: false, error: `${o.name} was not found.` };
    code = 1;
  } else if (bad) {
    result = { ok: false, error: `Login files not changed. ${bad.reason}` };
    code = 1;
  } else {
    const files = [...new Set([].concat(...logins.map((l) => l.files)))];
    const keys = new Set(logins.map((l) => `${l.base}|${l.hash}`));
    const shared = [...new Set(found.filter((e) => e.name !== o.name && e.url && !e.hashFlags.length)
      .filter((e) => { const l = loginFiles(e); return keys.has(`${l.base}|${l.hash}`); })
      .map((e) => e.name))];
    if (shared.length) warnings.push(`Same Server URL, so the same login: ${shared.join(', ')} will need to sign in again too.`);
    if (claudeRunning()) warnings.push('Claude seems to be open. Restart it so it does not keep using the old login.');
    if (!files.length) {
      result = { ok: true, moved: [], message: 'No saved login found.' };
    } else if (!o.yes) {
      result = { ok: false, dryRun: true, wouldMove: files, error: 'Nothing was moved. Add --yes to clear the login.' };
      code = 2;
    } else {
      // Moved (not deleted) to <base>\backup-<date>\<mcp-remote folder>\, which mcp-remote does not read.
      const moved = [];
      const st = stamp();
      const backupDir = {}; // one new backup folder per base, never an existing one
      try {
        for (const f of files) {
          const base = logins.find((l) => l.files.includes(f)).base;
          if (!backupDir[base]) {
            let d = path.join(base, `backup-${st}`);
            for (let n = 2; fs.existsSync(d); n++) d = path.join(base, `backup-${st}-${n}`);
            backupDir[base] = d;
          }
          const to = path.join(backupDir[base], path.basename(path.dirname(f)), path.basename(f));
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(f, to);
          moved.push({ from: f, to });
        }
        result = { ok: true, moved, message: 'Login cleared. The next connection asks you to sign in again.' };
      } catch (e) {
        const notUndone = [];
        for (const m of moved.slice().reverse()) {
          try { fs.renameSync(m.to, m.from); } catch { notUndone.push(m); }
        }
        result = { ok: false, moved: notUndone, error: `${e.message}${notUndone.length ? ' Some files could not be moved back (see moved).' : ' Nothing was changed.'}` };
        code = 1;
      }
    }
  }
  result = { version: VERSION, name: o.name, ...result, warnings };
  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    (result.wouldMove || []).forEach((f) => info(`Would move: ${f}`));
    (result.moved || []).forEach((m) => info(`Moved: ${m.from}\n      to: ${m.to}`));
    if (result.message) ok(result.message);
    if (result.error) fail(result.error);
    warnings.forEach(warn);
  }
  return code;
}

async function runCli(argv) {
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    if (argv.includes('--json')) console.log(JSON.stringify({ version: VERSION, ok: false, error: e.message }, null, 2));
    else { console.error(e.message); console.error(''); console.error(USAGE); }
    return 2;
  }
  try {
    if (o.cmd === 'help') { console.log(USAGE); return 0; }
    if (o.cmd === 'version') { console.log(VERSION); return 0; }
    if (o.cmd === 'list') return await cliList(o);
    if (o.cmd === 'check') return await cliCheck(o);
    if (o.cmd === 'remove') return await cliRemove(o);
    return await cliClearLogin(o);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (o.json) console.log(JSON.stringify({ version: VERSION, ok: false, error: message }, null, 2));
    else console.error(`Error: ${message}`);
    return 1;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  if (process.argv.length > 2) {
    process.exitCode = await runCli(process.argv.slice(2));
    setTimeout(() => process.exit(), 1000).unref(); // do not hang on leftover handles
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('Run this installer in a terminal window (double-click install.cmd).');
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Node.js 18 or newer is required (found v${process.versions.node}). Install Node.js LTS from https://nodejs.org.`);
    process.exit(1);
  }
  for (;;) {
    const i = await select([], 'Main menu', [
      { label: 'Configure connection', hint: 'create or edit' },
      { label: 'Check installations', hint: `find ${PREFIX}*` },
      { label: 'Exit' },
    ], { subtitle: `Installer v${VERSION}`, body: envBody });
    if (i === 0) await configureMenu();
    else if (i === 1) await checkMenu();
    else {
      clear();
      out('Bye.');
      process.exit(0);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    setRaw(false);
    out('');
    fail(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}

module.exports = { applyConfig, buildServer, parseServer, saveEntry, findInstallations, targets, FIELDS, rollback, reviewWarnings, save, removeEntry, removeEntries, loginFiles, runCli };
