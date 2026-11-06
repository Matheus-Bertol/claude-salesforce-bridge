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

function question(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { rl.close(); exitNow(); });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

// Text input in the "|  " style. Returns null when left empty with no current value.
async function ask(label, { help, current, mask, validate, normalize } = {}) {
  for (;;) {
    out('  ' + paint(c.bold, label));
    if (help) out('  ' + paint(c.dim, help));
    if (current !== undefined) {
      out('  ' + paint(c.dim, `Current: ${mask ? maskValue(current) : current}  (Enter keeps it)`));
    } else {
      out('  ' + paint(c.dim, 'Leave empty and press Enter to go back.'));
    }
    out(paint(c.cyan, '|'));
    let answer = (await question(paint(c.cyan, '|  '))).trim();
    out('');
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
    backup = `${file}.bak-${stamp()}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return backup;
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
  const port = u >= 0 && /^\d+$/.test(args[u + 1] || '') ? Number(args[u + 1]) : DEFAULT_PORT;
  let clientId = '';
  const o = args.indexOf('--static-oauth-client-info');
  if (o >= 0 && args[o + 1]) {
    try {
      let raw = args[o + 1];
      if (raw.startsWith('@')) raw = fs.readFileSync(raw.slice(1), 'utf8');
      clientId = JSON.parse(raw).client_id || '';
    } catch { /* shown as "not found" */ }
  }
  return { url, port, clientId };
}

// Updates URL, port and client id in an existing entry, keeping any other
// arguments the user added (--debug, "cmd /c", ...). Builds a new entry otherwise.
function applyConfig(server, cfg) {
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
    writeJsonWithBackup(infoFile, current);
  } else a[o + 1] = infoArg;
  if (!a.includes('--host')) a.push('--host', 'localhost');
  return s;
}

function saveEntry({ file, scope, oldName, name, cfg }) {
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
  const server = applyConfig(base, cfg);
  if (oldName && oldName !== name) delete servers[oldName];
  servers[name] = server;
  return writeJsonWithBackup(file, data);
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
      const s = v.trim().toLowerCase();
      return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
    },
    validate: (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(v)
      ? null
      : 'Use lowercase letters, numbers and hyphens (max 40), starting with a letter or number.'),
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
    validate: (v) => (/^https:\/\/\S+$/i.test(v)
      ? null
      : 'It must be the full Server URL, starting with https://'),
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
  row('Callback URL', `http://localhost:${s.port}/oauth/callback`);
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

function reviewWarnings(s) {
  const name = PREFIX + s.name;
  const w = [];
  if (s.mode === 'create') {
    for (const t of s.targets) if (serverExists(t.file, name, null)) w.push(`${name} already exists in ${t.client}. Saving replaces it.`);
  } else if (name !== s.entry.name && serverExists(s.entry.file, name, s.entry.scope)) {
    w.push(`${name} already exists in ${s.entry.client}. Saving replaces it.`);
  }
  if (s.port !== DEFAULT_PORT) w.push(`Port ${s.port}: update the Callback URL in Salesforce to match.`);
  return w;
}

async function confirmClaudeClosed(crumbs) {
  for (;;) {
    if (!claudeRunning()) return true;
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Check again', hint: 'after closing Claude' },
      { label: 'Save anyway' },
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
  if (!(await confirmClaudeClosed(crumbs))) return false;
  const name = PREFIX + s.name;
  const cfg = { url: s.url, clientId: s.clientId, port: s.port };
  const jobs = s.mode === 'create'
    ? s.targets.map((t) => ({ client: t.client, file: t.file, scope: null, oldName: null }))
    : [{ client: s.entry.client, file: s.entry.file, scope: s.entry.scope, oldName: s.entry.name }];

  const lines = [];
  let allOk = true;
  for (const j of jobs) {
    try {
      const backup = saveEntry({ ...j, name, cfg });
      lines.push(() => ok(`${j.client}: saved ${name}`));
      lines.push(() => info(paint(c.dim, j.file)));
      if (backup) lines.push(() => info(paint(c.dim, `Backup: ${backup}`)));
    } catch (e) {
      allOk = false;
      lines.push(() => fail(`${j.client}: ${e.message}`));
    }
  }
  envCache = undefined;

  const i = await select(crumbs, allOk ? 'Saved. Next step:' : 'Some files were not saved.', allOk
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

    const warnings = reviewWarnings(s);
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
  for (let n = 0; n < steps.length; n++) {
    header(crumbs, `Step ${n + 1} of 5`);
    const v = await askField(steps[n], steps[n] === 'port' ? s.port : undefined);
    if (v === null) return;
    s[steps[n]] = v;
  }
  const t = await chooseTargets(crumbs, 'Step 5 of 5', null);
  if (!t) return;
  s.targets = t;
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
  row('Callback URL', `http://localhost:${e.port}/oauth/callback`);
  out('');
}

async function openMenu(e) {
  const crumbs = ['Check installations', 'Open'];
  for (;;) {
    const i = await select(crumbs, 'What do you want to do?', [
      { label: 'Sign in and test connection', disabled: !e.url || !e.clientId },
      { label: 'Open config file in Notepad' },
      { label: 'Back' },
    ], { subtitle: e.name, body: () => detailsBody(e) });
    if (i === 0) await testConnection(crumbs, e);
    else if (i === 1) spawn('notepad.exe', [e.file], { detached: true, stdio: 'ignore' }).unref();
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

async function testConnection(crumbs, cfg) {
  const cli = npxCliPath();
  if (!cli) {
    header(crumbs, 'Sign in and test connection');
    fail('npx was not found next to Node.js. Reinstall Node.js LTS from https://nodejs.org.');
    return pause();
  }
  if (!(await portFree(cfg.port))) {
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

  header(crumbs, 'Sign in and test connection');
  info('If you are not signed in yet, your browser opens the Salesforce login.');
  info('Sign in there, then come back to this window.');
  out('');

  return new Promise((resolve) => {
    const args = [
      cli, '-y', 'mcp-remote', cfg.url, String(cfg.port),
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

    const line = (fn) => { process.stdout.write('\r\x1b[K'); fn(); };
    const spin = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      process.stdout.write('\r\x1b[K' + paint(c.cyan, `  [${'|/-\\'[frame++ % 4]}] `) + `Waiting for Salesforce... ${secs}s  ` + paint(c.dim, '(Esc to cancel)'));
    }, 120);
    const timer = setTimeout(() => finish(false, `No answer after ${TEST_TIMEOUT_MS / 1000}s.`), TEST_TIMEOUT_MS);

    const onKey = (s, key = {}) => {
      if (key.ctrl && key.name === 'c') { killTree(child); exitNow(); }
      if (key.name === 'escape') finish(false, 'Cancelled.', true);
    };
    readline.emitKeypressEvents(process.stdin);
    setRaw(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);

    async function finish(success, message, quiet = false) {
      if (finished) return;
      finished = true;
      clearInterval(spin);
      clearTimeout(timer);
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
          failureHints(log, cfg.port).forEach((h) => warn(h));
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
          line(() => ok(`Signed in and connected to ${server}.`));
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish(false, `Could not list tools: ${msg.error.message}`);
          const tools = (msg.result && msg.result.tools) || [];
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
          line(() => {
            warn('Sign in in the browser. If it did not open, copy this URL:');
            info(paint(c.dim, url[0]));
          });
        } else if (/EADDRINUSE/i.test(l)) {
          finish(false, `Port ${cfg.port} is in use.`);
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

// ---------------------------------------------------------------- main

async function main() {
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

module.exports = { applyConfig, buildServer, parseServer, saveEntry, findInstallations, targets, FIELDS };
