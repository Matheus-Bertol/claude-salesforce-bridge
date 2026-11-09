<#
  Claude Salesforce Bridge - installer (Windows)
  Author: Matheus Bertol (https://github.com/Matheus-Bertol)
  Source: https://github.com/Matheus-Bertol/claude-salesforce-bridge
  License: MIT

  Registers mcp-remote connections named "salesforce-conector-<name>" in Claude Code
  (%USERPROFILE%\.claude.json) and in Claude Desktop (claude_desktop_config.json, in
  every place it is found), runs the first sign-in and tests the connection.

  Usage (PowerShell or CMD):
      powershell -ExecutionPolicy Bypass -File install.ps1          interactive menu
      powershell -ExecutionPolicy Bypass -File install.ps1 -Help    command-line options

  Before the menu it:
    1. checks Node.js 20+ (offers to install Node.js LTS with winget if it is missing);
    2. installs mcp-remote once in %LOCALAPPDATA%\ClaudeSalesforceBridge\ponte (pinned
       version), so Claude runs node.exe by its full path, without PATH or npx;
    3. at the end, reopens Claude Desktop if it was closed while the installer ran.

  The menus, config files and command-line mode run in the Node.js code embedded at
  the end of this file (written to %LOCALAPPDATA%\ClaudeSalesforceBridge\installer).
#>
[CmdletBinding()]
param(
  [switch]$List,
  [string]$Check,
  [switch]$Test,
  [string]$Remove,
  [ValidateSet('code', 'desktop', 'all')][string]$From,
  [string]$ClearLogin,
  [switch]$Yes,
  [switch]$Json,
  [switch]$Help,
  [switch]$Version,
  [switch]$NoRestart,
  [string]$Name,
  [string]$ServerUrl,
  [string]$ConsumerKey,
  [string]$Port
)

# ============================== adjust here ==============================
# Fill these to hand out a preconfigured installer: in "Configure connection >
# Create", filled values are used without asking. Leave empty to ask.
# The parameters -Name, -ServerUrl, -ConsumerKey and -Port override them.
$Preset = @{
  Name        = ''   # connection name, saved as salesforce-conector-<name>
  ServerUrl   = ''   # Salesforce Hosted MCP Server URL (https://...)
  ConsumerKey = ''   # Consumer Key of the External Client App (no secret)
  Port        = ''   # callback port; empty = asked (default 8080)
}
$McpRemoteVersion = '0.16.5'
$AppFolder = Join-Path $env:LOCALAPPDATA 'ClaudeSalesforceBridge'
# =========================================================================

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Ok($m)   { Write-Host "  [ok]  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]   $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [x]   $m" -ForegroundColor Red }

# Interactive runs usually have their own window: keep it open on errors.
function Exit-Installer([int]$Code) {
  if (-not $script:Cli -and $Code -ne 0 -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    try { Read-Host 'Press Enter to close' | Out-Null } catch {}
  }
  exit $Code
}

# ---------------------------------------------------------------- Node.js

function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Get-NodeExe {
  $node = Find-Node
  if (-not $node) {
    if ($script:Cli) { Fail 'Node.js was not found. Install Node.js LTS (20 or newer) from https://nodejs.org.'; Exit-Installer 1 }
    Warn 'Node.js was not found. It is needed to run the connector.'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Fail 'winget is not available. Install Node.js LTS from https://nodejs.org and run this again.'
      Exit-Installer 1
    }
    $a = Read-Host '  Install Node.js LTS now with winget? [Y/n]'
    if ($a -match '^\s*(n|no)\s*$') { Exit-Installer 1 }
    Write-Host '  Installing Node.js LTS (Windows may ask for permission)...' -ForegroundColor Cyan
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent | Out-Host
    Update-PathFromRegistry
    $node = Find-Node
    if (-not $node) { Fail 'Node.js is still not available. Restart the computer and run this again.'; Exit-Installer 1 }
  }
  $v = (& $node -v).Trim().TrimStart('v')
  if ([int]($v.Split('.')[0]) -lt 20) {
    Fail "Node.js $v is too old: 20 or newer is required (winget upgrade OpenJS.NodeJS.LTS)."
    Exit-Installer 1
  }
  return $node
}

# ---------------------------------------------------------------- mcp-remote (local)

# Installs the pinned mcp-remote in its own folder and returns the path of its
# proxy.js, or $null (the Node.js code then falls back to npx).
function Install-McpRemote([string]$NodeExe, [string]$Ponte) {
  $proxy = Join-Path $Ponte 'node_modules\mcp-remote\dist\proxy.js'
  $pkg = Join-Path $Ponte 'node_modules\mcp-remote\package.json'
  if ((Test-Path $proxy) -and (Test-Path $pkg)) {
    try {
      if ((Get-Content $pkg -Raw | ConvertFrom-Json).version -eq $McpRemoteVersion) { return $proxy }
    } catch {}
  }
  New-Item -ItemType Directory -Force -Path $Ponte | Out-Null
  Write-Host "  Installing mcp-remote $McpRemoteVersion (only once)..." -ForegroundColor Cyan
  $npmCli = Join-Path (Split-Path $NodeExe) 'node_modules\npm\bin\npm-cli.js'
  $npmArgs = @('install', '--prefix', $Ponte, '--no-audit', '--no-fund', '--omit=dev', "mcp-remote@$McpRemoteVersion")
  try {
    if (Test-Path $npmCli) { & $NodeExe $npmCli @npmArgs | Out-Host } else { & npm.cmd @npmArgs | Out-Host }
    if ($LASTEXITCODE -ne 0) { throw "npm exited with code $LASTEXITCODE" }
  } catch {
    Warn "Could not install mcp-remote locally ($($_.Exception.Message)). npx will be used instead."
    return $null
  }
  if (-not (Test-Path $proxy)) { Warn 'mcp-remote was installed, but proxy.js was not found. npx will be used instead.'; return $null }
  Ok "mcp-remote $McpRemoteVersion installed in $Ponte"
  return $proxy
}

# ---------------------------------------------------------------- Claude Desktop

# Same rule as the Node.js code: detect Claude Desktop by its executable path,
# not by name (Claude Code also runs as claude.exe).
function Get-DesktopProcesses {
  $la = "$env:LOCALAPPDATA".ToLower()
  @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $p = "$($_.ExecutablePath)".ToLower()
    $p -and ($p.Contains('\windowsapps\claude_') -or $p.StartsWith("$la\anthropicclaude\"))
  })
}

function Start-ClaudeDesktop($WasRunning) {
  $exe = ($WasRunning | Select-Object -First 1).ExecutablePath
  try {
    if ($exe -and $exe -notmatch '\\WindowsApps\\') { Start-Process $exe; Ok 'Claude Desktop reopened.'; return }
    # Packaged (MSIX) app: its exe cannot be started directly.
    $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -like 'Claude_*' } | Select-Object -First 1
    if ($pkg) {
      $appId = $null
      try { $appId = ((Get-AppxPackageManifest $pkg).Package.Applications.Application | Select-Object -First 1).Id } catch {}
      if (-not $appId) { $appId = 'Claude' }
      Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"
      Ok 'Claude Desktop reopened.'
      return
    }
  } catch {}
  Warn 'Open Claude Desktop again from the Start menu.'
}

# ---------------------------------------------------------------- main

function Invoke-Installer {
  # Command-line mode: the PowerShell switches become the options of the Node.js code.
  $cliArgs = @()
  if ($Help) { $cliArgs += '--help' }
  if ($Version) { $cliArgs += '--version' }
  if ($List) { $cliArgs += '--list' }
  if ($script:Bound.ContainsKey('Check')) { $cliArgs += @('--check', $Check) }
  if ($script:Bound.ContainsKey('Remove')) { $cliArgs += @('--remove', $Remove) }
  if ($script:Bound.ContainsKey('ClearLogin')) { $cliArgs += @('--clear-login', $ClearLogin) }
  if ($Test) { $cliArgs += '--test' }
  if ($From) { $cliArgs += @('--from', $From.ToLower()) }
  if ($Yes) { $cliArgs += '--yes' }
  if ($Json) { $cliArgs += '--json' }
  $script:Cli = $cliArgs.Count -gt 0

  if (-not $script:Cli) {
    Write-Host '------------------------------------------------------------------' -ForegroundColor Cyan
    Write-Host '|  CLAUDE SALESFORCE BRIDGE - checking this computer' -ForegroundColor Cyan
    Write-Host '------------------------------------------------------------------' -ForegroundColor Cyan
  }
  $nodeExe = Get-NodeExe

  # Embedded Node.js code (menus, config files, command-line mode).
  $jsDir = Join-Path $AppFolder 'installer'
  New-Item -ItemType Directory -Force -Path $jsDir | Out-Null
  $jsFile = Join-Path $jsDir 'installer.js'
  [IO.File]::WriteAllText($jsFile, $script:InstallerJs, $Utf8NoBom)

  # mcp-remote: installed in interactive mode; command-line mode only uses it if present.
  $ponte = Join-Path $AppFolder 'ponte'
  $proxy = Join-Path $ponte 'node_modules\mcp-remote\dist\proxy.js'
  if (-not $script:Cli) { $proxy = Install-McpRemote $nodeExe $ponte }
  elseif (-not (Test-Path $proxy)) { $proxy = $null }
  $env:BRIDGE_PROXY = if ($proxy) { $proxy } else { '' }

  # Values for Create: parameters win over the "adjust here" block.
  foreach ($k in 'Name', 'ServerUrl', 'ConsumerKey', 'Port') {
    if ($script:Bound.ContainsKey($k)) { $Preset[$k] = [string]$script:Bound[$k] }
  }
  $env:BRIDGE_NAME = $Preset.Name
  $env:BRIDGE_URL = $Preset.ServerUrl
  $env:BRIDGE_CLIENT_ID = $Preset.ConsumerKey
  $env:BRIDGE_PORT = $Preset.Port
  $env:BRIDGE_REOPEN = if (-not $script:Cli -and -not $NoRestart) { '1' } else { '' }

  $desktopBefore = Get-DesktopProcesses
  & $nodeExe $jsFile @cliArgs
  $code = $LASTEXITCODE

  if (-not $script:Cli -and -not $NoRestart -and $desktopBefore.Count -gt 0 -and (Get-DesktopProcesses).Count -eq 0) {
    Start-ClaudeDesktop $desktopBefore
  }
  Exit-Installer $code
}

$script:Bound = $PSBoundParameters
$script:Cli = $false

# ---------------------------------------------------------------- embedded Node.js code
# Do not edit the copy written to %LOCALAPPDATA%: it is replaced on every run.
$script:InstallerJs = @'
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

const VERSION = '0.2.0-beta';
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

// Claude Desktop reads its config from different places depending on how it was
// installed, so the connector is saved in every candidate found (only the entry
// is merged; the rest of each file is kept):
//  1. packaged (MSIX) install: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
//     (the file is created if missing; this is the copy the packaged app reads)
//  2. classic install:          %APPDATA%\Claude\
//  3. newer Store builds:       %LOCALAPPDATA%\Claude-Data\claude_*\
function desktopConfigPaths() {
  const list = [];
  const { APPDATA, LOCALAPPDATA } = process.env;
  const name = 'claude_desktop_config.json';
  if (LOCALAPPDATA) {
    const pkgs = path.join(LOCALAPPDATA, 'Packages');
    if (fs.existsSync(pkgs)) {
      for (const d of fs.readdirSync(pkgs)) {
        if (/^Claude_/i.test(d)) list.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', name));
      }
    }
  }
  if (APPDATA && fs.existsSync(path.join(APPDATA, 'Claude'))) list.push(path.join(APPDATA, 'Claude', name));
  if (LOCALAPPDATA) {
    const base = path.join(LOCALAPPDATA, 'Claude-Data');
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (/^claude_/i.test(d) && fs.statSync(path.join(base, d)).isDirectory()) list.push(path.join(base, d, name));
      }
    }
  }
  // Run from inside the packaged app, %APPDATA%\Claude is redirected to the Packages
  // folder (same physical file): keep each file once.
  const seen = new Set();
  return list.filter((f) => {
    let key;
    try {
      const s = fs.statSync(fs.existsSync(f) ? f : path.dirname(f), { bigint: true });
      key = `${s.dev}:${s.ino}`;
    } catch {
      key = path.resolve(f).toLowerCase();
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function targets() {
  const file = claudeCodeConfig();
  const list = [{ client: 'Claude Code', file, exists: fs.existsSync(file) }];
  for (const f of desktopConfigPaths()) list.push({ client: 'Claude Desktop', file: f, exists: fs.existsSync(f) });
  return list;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
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

// No backup files (user decision): the original content is kept in memory and
// returned (null when the file did not exist), so a failed save can be undone.
function writeJson(file, data) {
  let original = null;
  if (fs.existsSync(file)) original = fs.readFileSync(file, 'utf8');
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
    throw e;
  }
  return original;
}

// Undoes writes made by writeJson ({ file, original }), newest first: writes the
// original content back, or removes the file when it did not exist before.
// Returns the writes that could not be undone.
function rollback(written) {
  const failed = [];
  for (const w of written.slice().reverse()) {
    try {
      if (typeof w.original === 'string') fs.writeFileSync(w.file, w.original, 'utf8');
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

// mcp-remote installed once by install.ps1 in a local folder (pinned version).
// When it is there, Claude runs node.exe by its full path with that script, so the
// connector depends neither on PATH nor on npx downloading the package.
function localProxy() {
  const p = process.env.BRIDGE_PROXY;
  return p && fs.existsSync(p) ? p : null;
}

function buildServer(cfg) {
  const rest = [
    cfg.url, String(cfg.port),
    '--static-oauth-client-info', JSON.stringify({ client_id: cfg.clientId }),
    '--host', 'localhost',
  ];
  const proxy = localProxy();
  if (proxy) return { command: process.execPath, args: [proxy, ...rest] };
  return { command: 'npx', args: ['-y', 'mcp-remote', ...rest] };
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
    else writeJson(infoFile, current);
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
    mine.push({ file, original: writeJson(file, data) });
    for (const w of writes) mine.push({ file: w.file, original: writeJson(w.file, w.data) });
  } catch (e) {
    const failed = rollback(mine);
    e.message += failed.length
      ? ` Could not undo the change in: ${failed.map((w) => w.file).join(', ')}.`
      : (mine.length ? ' The change was undone.' : '');
    throw e;
  }
  if (written) written.push(...mine);
  return null;
}

// Removes only the server key from its mcpServers, keeping the rest of the JSON.
// Successful writes are added to "written".
function removeEntry({ file, scope, name, written }) {
  const data = readJson(file); // read right before writing
  const servers = serversIn(data, scope);
  if (!servers || typeof servers !== 'object' || !servers[name]) {
    throw new Error(`${name} was not found in ${file}${scope ? ` (project ${scope})` : ''}.`);
  }
  delete servers[name];
  const original = writeJson(file, data);
  if (written) written.push({ file, original });
  return null;
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

function desktopProcesses() {
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 8000 });
    const list = JSON.parse(r.stdout || '[]');
    const rows = Array.isArray(list) ? list : [list];
    const localApp = (process.env.LOCALAPPDATA || '').toLowerCase();
    const pids = rows
      .filter((p) => {
        const ep = (p.ExecutablePath || '').toLowerCase();
        if (!ep || !/claude\.exe$/i.test(ep)) return false;
        return ep.includes('\\windowsapps\\claude_') ||
          (localApp && ep.startsWith(localApp + '\\anthropicclaude\\'));
      })
      .map((p) => p.ProcessId);
    if (!pids.length) return { pids: [], selfInside: false };
    const pidSet = new Set(pids);
    // Walk process ancestors of this Node process to detect "inside Desktop".
    const parentOf = {};
    rows.forEach((p) => { parentOf[p.ProcessId] = p.ParentProcessId; });
    let cur = process.pid;
    let selfInside = false;
    for (let i = 0; i < 20 && cur; i++) {
      if (pidSet.has(cur)) { selfInside = true; break; }
      cur = parentOf[cur];
    }
    return { pids, selfInside };
  } catch (_) {
    // Safe fallback: treat as "may be open". Use empty pids so closeDesktop skips taskkill.
    return { pids: [-1], selfInside: false };
  }
}

function closeDesktop(pids) {
  for (const pid of pids.filter((p) => p > 0)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore' });
  }
  // Wait ~4 s, sleeping 1 s between checks to avoid blocking the event loop.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    spawnSync('cmd', ['/c', 'timeout /t 1 /nobreak >nul'], { stdio: 'ignore' });
    const { pids: remaining } = desktopProcesses();
    if (!remaining.filter((p) => p > 0).length) return { closed: true };
  }
  const { pids: remaining } = desktopProcesses();
  return { closed: remaining.filter((p) => p > 0).length === 0 };
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
      proxy: localProxy(),
      code: t.find((x) => x.client === 'Claude Code'),
      desktop: t.filter((x) => x.client === 'Claude Desktop'),
    };
  }
  const e = envCache;
  ok(`Node.js v${e.node}`);
  if (e.proxy) ok(`mcp-remote (local) ${paint(c.dim, e.proxy)}`);
  else if (e.npx) warn('mcp-remote local install not found: using npx');
  else fail('mcp-remote not found (no local install and no npx next to Node.js)');
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

// Every place Claude was found: Claude Code when ~/.claude.json exists, plus each
// Claude Desktop config path found by desktopConfigPaths().
function installTargets() {
  return targets().filter((t) => t.client === 'Claude Desktop' || t.exists);
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
  const proxy = localProxy();
  const cli = proxy || npxCliPath();
  if (!cli && batch) {
    Object.assign(report, { success: false, message: 'mcp-remote was not found (no local install and no npx next to Node.js).' });
    return false;
  }
  if (!cli) {
    header(crumbs, 'Sign in and test connection');
    fail('mcp-remote was not found (no local install and no npx next to Node.js). Run install.ps1 again.');
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
      ...(proxy ? [proxy] : [cli, '-y', 'mcp-remote']), cfg.url, ...(portKnown ? [String(cfg.port)] : []),
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
  'Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [options]',
  '',
  'Without options it opens the interactive menu. Options:',
  '  -List [-Json]                         List salesforce-conector-* connections',
  '  -Check <name> [-Test] [-Json]         Check a connection. -Test also signs in',
  '                                        (may open the browser) and lists the tools',
  '  -Remove <name> -From code|desktop|all -Yes [-Json]',
  '                                        Remove a connection.',
  '                                        -From is required with -Yes; code and',
  '                                        all include every Claude Code project',
  '  -ClearLogin <name> -Yes [-Json]       Move the saved login of a connection to',
  '                                        a backup folder inside .mcp-auth',
  '  -Version, -Help',
  '',
  'Interactive mode also accepts -Name, -ServerUrl, -ConsumerKey and -Port',
  '(or the "adjust here" block at the top of install.ps1): filled values are',
  'not asked again in Create. -NoRestart: do not reopen Claude Desktop.',
  '',
  'Without -Yes, -Remove and -ClearLogin only show what they would do',
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
  if (o.test && o.cmd !== 'check') throw new Error('-Test works only with -Check.');
  if (o.from !== null && o.cmd !== 'remove') throw new Error('-From works only with -Remove.');
  if (o.from !== null && !['code', 'desktop', 'all'].includes(o.from)) throw new Error('-From must be code, desktop or all.');
  if (o.cmd === 'remove' && o.yes && o.from === null) {
    throw new Error('-Remove with -Yes needs -From code, desktop or all (code and all include every Claude Code project).');
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
  add(checks, major >= 20 ? 'ok' : 'error', 'node', `Node.js v${process.versions.node}${major >= 20 ? '' : ' (20 or newer is required)'}`);
  if (localProxy()) add(checks, 'ok', 'mcp-remote', `mcp-remote (local) ${localProxy()}`);
  else add(checks, npxCliPath() ? 'warn' : 'error', 'mcp-remote', npxCliPath() ? 'mcp-remote local install not found: using npx' : 'mcp-remote not found (no local install and no npx next to Node.js)');
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
      !login.supported ? login.reason : login.saved ? 'Login saved' : 'No saved login (sign in with -Test or from Claude)');
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
    result = { ok: false, dryRun: true, wouldRemove: where, error: 'Nothing was removed. Add -Yes to remove.' };
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
    if (result.removed && result.removed.length) warn('Claude sessions already open keep this connector until they are restarted.');
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
      result = { ok: false, dryRun: true, wouldMove: files, error: 'Nothing was moved. Add -Yes to clear the login.' };
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

// ---------------------------------------------------------------- live status

// Checks a connection against Salesforce with its saved token (no browser, no
// mcp-remote): sends an MCP "initialize" and looks at the HTTP status.
// state: 'connected' | 'expired' | 'no-login' | 'error'.
async function connectionStatus(e) {
  if (!e.url) return { state: 'error', detail: 'Server URL not found in the entry' };
  const login = loginFiles(e);
  if (!login.supported) return { state: 'error', detail: login.reason };
  const tokenFile = login.files
    .filter((f) => f.endsWith('_tokens.json'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!tokenFile) return { state: 'no-login', detail: 'No saved login' };
  let token = '';
  try { token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).access_token || ''; } catch { /* unreadable */ }
  if (!token) return { state: 'no-login', detail: 'The saved login is empty' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(e.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-salesforce-bridge-installer', version: VERSION } },
      }),
    });
    try { if (r.body) await r.body.cancel(); } catch { /* ignore */ }
    if (r.ok) return { state: 'connected', detail: 'Connected' };
    if (r.status === 401 || r.status === 403) return { state: 'expired', detail: 'Login expired' };
    return { state: 'error', detail: `Salesforce answered HTTP ${r.status}` };
  } catch (err) {
    const why = err && err.name === 'AbortError' ? 'no answer (timeout)' : ((err && err.cause && err.cause.code) || (err && err.message) || String(err));
    return { state: 'error', detail: `Could not reach Salesforce: ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

// Prints every salesforce-conector-* connection with its live status.
// Returns one row per connection: { e, places, st }.
async function showStatus(title) {
  out('  ' + paint(c.bold, title));
  const { found, errors } = findInstallations();
  errors.forEach((m) => warn(m));
  if (!found.length) {
    info(paint(c.dim, `No ${PREFIX}* connection yet.`));
    out('');
    return [];
  }
  const groups = new Map(); // same name and Server URL = same login
  for (const e of found) {
    const k = `${e.name}|${e.url}`;
    if (!groups.has(k)) groups.set(k, { e, places: new Set() });
    groups.get(k).places.add(e.client + (e.scope ? ` (project ${e.scope})` : ''));
  }
  out(paint(c.dim, '  Checking with Salesforce...'));
  const rows = await Promise.all([...groups.values()].map(async (g) => ({ e: g.e, places: [...g.places], st: await connectionStatus(g.e) })));
  process.stdout.write('\x1b[1A\x1b[2K');
  for (const r of rows) {
    const label = `${r.e.name}  ${paint(c.dim, r.places.join(', '))}`;
    if (r.st.state === 'connected') ok(`${label}  ${paint(c.green, 'CONNECTED')}`);
    else if (r.st.state === 'expired') fail(`${label}  ${paint(c.red, 'LOGIN EXPIRED')}`);
    else if (r.st.state === 'no-login') warn(`${label}  ${paint(c.yellow, 'NOT SIGNED IN')}`);
    else fail(`${label}  ${paint(c.red, 'ERROR')}  ${paint(c.dim, r.st.detail)}`);
  }
  out('');
  return rows;
}

// ---------------------------------------------------------------- linear install

// Yes/no question. Enter = default, Esc = no.
async function yesNo(q, def = true) {
  for (;;) {
    const a = await question(`  ${paint(c.bold, q)} ${paint(c.dim, def ? '[Y/n]' : '[y/N]')} `);
    if (a === null) return false;
    const v = a.trim().toLowerCase();
    if (!v) return def;
    if (/^(y|yes|s|sim)$/.test(v)) return true;
    if (/^(n|no|nao)$/.test(v)) return false;
  }
}

// Claude Desktop rewrites its config when it closes, so it must be closed while
// saving. Returns 'ok', 'skip' (save without Desktop) or 'cancel'.
async function desktopCheck(hasOtherTargets) {
  for (;;) {
    const { pids, selfInside } = desktopProcesses();
    if (!pids.length) return 'ok';
    warn('Claude Desktop is open. It rewrites its config when it closes and may undo this change.');
    if (selfInside) {
      info('This installer runs inside Claude Desktop, so it cannot close it. Close Desktop');
      info('(including the tray icon), or run install.cmd from a normal window.');
      if (await yesNo('I closed Claude Desktop. Check again?')) continue;
    } else {
      const reopen = process.env.BRIDGE_REOPEN === '1' ? ' It is reopened at the end.' : '';
      if (await yesNo(`Close Claude Desktop now?${reopen}`)) {
        if (closeDesktop(pids).closed) { ok('Claude Desktop closed.'); return 'ok'; }
        warn('Claude Desktop did not close in time.');
        if (await yesNo('Force close it? Open Desktop sessions may be lost.', false)) {
          for (const pid of desktopProcesses().pids.filter((p) => p > 0)) {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          }
          continue;
        }
      }
    }
    if (hasOtherTargets && await yesNo('Save only in Claude Code (skip Claude Desktop)?')) return 'skip';
    return 'cancel';
  }
}

// The saved token cannot be renewed (mcp-remote sends "scope" on refresh and
// Salesforce rejects it), so signing in again means: clear that login, sign in.
async function signInAgain(e) {
  out('');
  await cliClearLogin({ name: e.name, yes: true, json: false });
  await testConnection([], { name: e.name, url: e.url, clientId: e.clientId, port: e.port, portSet: e.portSet });
}

async function linearInstall() {
  header([], `Installer v${VERSION}`);
  envBody();
  const before = await showStatus('Connections');

  for (const r of before.filter((x) => x.st.state === 'expired' || x.st.state === 'no-login')) {
    if (await yesNo(`Sign in to ${r.e.name} again now? The browser opens.`)) {
      await signInAgain(r.e);
      header([], `Installer v${VERSION}`);
      await showStatus('Connections');
    }
  }

  const targetsFound = installTargets();
  if (!targetsFound.length) {
    fail('Claude Code and Claude Desktop were not found on this computer.');
    return 1;
  }
  out('');
  if (!(await yesNo('Install a Salesforce connection now?', !before.length))) return 0;
  out('');

  // Values filled in the "adjust here" block of install.ps1 (or its parameters):
  // a valid value is used without asking; an invalid one is asked, shown as the current value.
  const s = { name: '', url: '', clientId: '', port: DEFAULT_PORT };
  const preset = { name: process.env.BRIDGE_NAME, url: process.env.BRIDGE_URL, clientId: process.env.BRIDGE_CLIENT_ID, port: process.env.BRIDGE_PORT };
  const steps = [];
  for (const key of ['name', 'url', 'clientId', 'port']) {
    const raw = preset[key];
    if (raw === undefined || String(raw).trim() === '') { steps.push(key); continue; }
    const v = FIELDS[key].normalize(raw);
    s[key] = key === 'port' && /^\d+$/.test(v) ? Number(v) : v;
    if (FIELDS[key].validate(v)) steps.push(key);
  }
  // Esc or "back" returns one step; on the first step it cancels.
  for (let n = 0; n < steps.length;) {
    out(paint(c.dim, `  Step ${n + 1} of ${steps.length}`));
    const v = await askField(steps[n], s[steps[n]]);
    if (v === null) {
      if (n === 0) { warn('Nothing was saved.'); return 0; }
      n--;
      continue;
    }
    s[steps[n]] = v;
    n++;
  }

  const name = PREFIX + s.name;
  out('  ' + paint(c.bold, 'Summary'));
  row('Name', paint(c.bold, name));
  row('Server URL', s.url);
  row('Consumer Key', maskValue(s.clientId));
  row('Callback URL', `http://localhost:${s.port}/oauth/callback`);
  targetsFound.forEach((t, i) => row(i ? '' : 'Install in', `${t.client}  ${paint(c.dim, t.file + (t.exists ? '' : '  (will be created)'))}`));
  out('');
  if (s.port !== DEFAULT_PORT) warn(`Port ${s.port}: the Callback URL in Salesforce must use this port.`);
  if (!(await portFree(s.port))) warn(`Port ${s.port} is in use right now (often by Claude or an old mcp-remote). Sign-in may fail until it is free.`);
  const taken = targetsFound.filter((t) => serverExists(t.file, name, null));
  taken.forEach((t) => warn(`${name} already exists in ${t.client}. Saving replaces it.`));
  if (!(await yesNo(taken.length ? 'Replace and save?' : 'Save?', !taken.length))) { warn('Nothing was saved.'); return 0; }

  let jobs = targetsFound;
  if (jobs.some((j) => j.client === 'Claude Desktop')) {
    const g = await desktopCheck(jobs.some((j) => j.client !== 'Claude Desktop'));
    if (g === 'cancel') { warn('Nothing was saved.'); return 1; }
    if (g === 'skip') jobs = jobs.filter((j) => j.client !== 'Claude Desktop');
  } else if (claudeRunning()) {
    warn('Claude seems to be open. It rewrites its config files and may undo this change.');
    if (!(await yesNo('Save anyway?', false))) { warn('Nothing was saved.'); return 1; }
  }

  // All or nothing: if one file fails, the files already saved are restored.
  const cfg = { url: s.url, clientId: s.clientId, port: s.port };
  const written = [];
  for (const j of jobs) {
    try {
      saveEntry({ file: j.file, scope: null, oldName: null, name, cfg, written });
    } catch (e) {
      const notUndone = rollback(written);
      fail(`Could not save in ${j.file}: ${e.message}`);
      notUndone.forEach((w) => fail(`Could not undo the change in ${w.file}`));
      if (written.length && !notUndone.length) info('The files already saved were restored. Nothing was changed.');
      return 1;
    }
  }
  envCache = undefined;
  out('');
  jobs.forEach((j) => ok(`Saved in ${j.client}  ${paint(c.dim, j.file)}`));
  out('');

  if (await yesNo('Sign in and test the connection now? The browser may open.')) {
    await testConnection([], { name, ...cfg });
    header([], 'Done');
  }
  await showStatus('Connections');
  info(`Open Claude: ${name} is listed under MCP servers (Claude Code)`);
  info('or Settings > Developer (Claude Desktop).');
  return 0;
}

// ---------------------------------------------------------------- main

async function main() {
  if (process.argv.length > 2) {
    process.exitCode = await runCli(process.argv.slice(2));
    setTimeout(() => process.exit(), 1000).unref(); // do not hang on leftover handles
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('Run this installer in a terminal window: powershell -ExecutionPolicy Bypass -File install.ps1');
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`Node.js 20 or newer is required (found v${process.versions.node}). Install Node.js LTS from https://nodejs.org.`);
    process.exit(1);
  }
  const code = await linearInstall();
  await pause('Press any key to close...');
  process.exit(code);
}

if (require.main === module) {
  main().catch((e) => {
    setRaw(false);
    out('');
    fail(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}

module.exports = { applyConfig, buildServer, parseServer, saveEntry, findInstallations, targets, FIELDS, rollback, removeEntry, removeEntries, loginFiles, runCli, connectionStatus };
'@

Invoke-Installer
