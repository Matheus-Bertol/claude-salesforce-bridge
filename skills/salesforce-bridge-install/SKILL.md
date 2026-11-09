---
name: salesforce-bridge-install
description: Install, edit or remove a Salesforce connector (salesforce-conector-* entry running mcp-remote against a Salesforce Hosted MCP server, per-user OAuth sign-in with PKCE and no secret) in Claude Code and/or Claude Desktop on Windows. Use when the user says connect Claude to Salesforce, install the Salesforce connector, add a Salesforce MCP server, change the Server URL, Consumer Key or port of the connector, or remove the Salesforce connector.
---
# Salesforce Bridge: install, edit, remove

You do the steps yourself on the user's Windows computer, one at a time, explaining each in one short line before running it. This skill needs nothing besides this text: no installer, no download of scripts, no other file.

What gets installed: one entry named `salesforce-conector-<name>` under `mcpServers` in Claude's config file. It runs `mcp-remote` (an npm package started with `npx`, which downloads it from the npm registry on first use) as a local bridge to the org's Salesforce Hosted MCP server. Each user signs in to Salesforce in the browser; the login is saved in `%USERPROFILE%\.mcp-auth`.

## Rules
- Ask for one value at a time and wait. Never guess or invent a value.
- Never ask for a Consumer Secret, password or token (the app is a public client with PKCE). If the user pastes one, say it is not needed and do not use or store it.
- Never print the full Consumer Key (show the first 4 and last 4 characters), tokens, or anything inside `%USERPROFILE%\.mcp-auth`.
- Before writing a file: show the user the file path and the entry, wait for a clear yes, and make a backup. Change only the connector entry; keep the rest of the file as it is.
- Do not close Claude Desktop or end any process yourself; ask the user to do it.
- If something does not match these steps, stop and tell the user. Do not improvise.
- Only tested on Windows with Claude Code and the packaged (MSIX) Claude Desktop. Say so if the user has another setup.
- If you cannot run commands on the user's computer, see "If you cannot run commands".

## Step 1: what and where
Ask what the user wants (install, edit or remove) and where: Claude Code, Claude Desktop, or both.

## Step 2: values (install or edit)
Ask in this order and check each answer:
1. **Connection name**, for example `sales`. Lowercase letters, digits and single hyphens, at most 40 characters, starting and ending with a letter or digit. The entry is `salesforce-conector-<name>`. Suggest one name per org (production, sandbox).
2. **Server URL**: copied from Salesforce (Setup > MCP Servers > the server > Server URL). Must start with `https://` and must not be `localhost`. It depends on the org; never build it by hand.
3. **Consumer Key** of the External Client App (Setup > External Client App Manager > the app > Manage Consumer Details). Not a secret, but mask it when you show it.
4. **Callback port**: `8080` unless the user gives another number from 1024 to 65535.

If the user does not have these, they come from the Salesforce admin. The app's Callback URL in Salesforce must be exactly `http://localhost:<port>/oauth/callback` (`http`, not `https`).

Show a summary (name, URL, masked key, port, Callback URL) and ask for confirmation.

## Step 3: check Node.js
```powershell
node -v
Get-Command npx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```
Node.js must be 20 or newer and `npx` must be found. If not, ask the user to install Node.js LTS from nodejs.org, then run the check again. Do not install it yourself.

## Step 4: find the config file
- **Claude Code**: `%USERPROFILE%\.claude.json` (a file in the user folder, not the `.claude` folder). Use the top-level `mcpServers` key so the connector works in every folder.
- **Claude Desktop**: it reads only one file. If a `Packages` file exists it wins, and `%APPDATA%\Claude` is ignored by the app:
```powershell
$pkg = Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json' } |
  Where-Object { Test-Path $_ }
$app = "$env:APPDATA\Claude\claude_desktop_config.json"
if ($pkg) { $pkg } else { "$app  file exists: $(Test-Path $app)  folder exists: $(Test-Path (Split-Path $app))" }
```
  - A `Packages` path is listed: change only that file.
  - Otherwise use `%APPDATA%\Claude\claude_desktop_config.json` (create it if only the folder exists).
  - Nothing exists: ask the user to open Claude Desktop once (Settings > Developer > Edit Config creates the file), close it, and run this step again.

Tell the user which file(s) you will change.

## Step 5: Claude Desktop must be closed
Claude Desktop rewrites its config when it closes, so a change made while it is open is lost. This lists only Claude Desktop, not Claude Code:
```powershell
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  Where-Object { $_.ExecutablePath -match '\\WindowsApps\\Claude_' -or $_.ExecutablePath -like "$env:LOCALAPPDATA\AnthropicClaude\*" } |
  Select-Object ProcessId, ExecutablePath
```
If it lists anything, ask the user to quit Claude Desktop completely (including the tray icon) and check again. Skip this step when only Claude Code is changed.

## Step 6: look at what is there (read-only)
For each file that exists, list the current connectors (the key is printed masked):
```powershell
$env:SFB_FILE = '<config file path>'
node -e @'
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.SFB_FILE, 'utf8').replace(/^\uFEFF/, ''));
const show = (servers, where) => {
  for (const [name, s] of Object.entries(servers || {})) {
    if (!name.startsWith('salesforce-conector-')) continue;
    const a = Array.isArray(s.args) ? s.args.map(String) : [];
    const u = a.findIndex((x) => /^https?:\/\//i.test(x));
    const o = a.indexOf('--static-oauth-client-info');
    const h = a.indexOf('--host');
    let key = '';
    try { if (o >= 0) key = JSON.parse(a[o + 1]).client_id || ''; } catch (e) {}
    console.log(JSON.stringify({
      name, where, command: s.command,
      url: u >= 0 ? a[u] : null,
      port: u >= 0 && /^\d+$/.test(a[u + 1] || '') ? a[u + 1] : null,
      hostLocalhost: h >= 0 && a[h + 1] === 'localhost',
      consumerKey: key.length > 8 ? key.slice(0, 4) + '...' + key.slice(-4) : null,
    }));
  }
};
show(cfg.mcpServers, 'top level');
for (const [p, v] of Object.entries(cfg.projects || {})) show(v && v.mcpServers, 'project ' + p);
'@
Remove-Item Env:SFB_FILE
```
- If it fails because the file is not valid JSON, stop and tell the user. Do not rewrite the file.
- Install: if the name already exists, ask whether to replace it.
- Edit: show the current values, ask which one changes, and keep the others. Saving replaces the whole entry with the standard one in Step 7; if the current entry has a different `command`, extra arguments or an `env` block, tell the user they will be replaced and ask first.

## Step 7: show, back up, save (install or edit)
Show the user exactly this, with the key masked, and the file path(s), then ask "Save?":
```json
"salesforce-conector-<name>": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "<SERVER_URL>", "<PORT>",
           "--static-oauth-client-info", "{\"client_id\":\"<CONSUMER_KEY>\"}",
           "--host", "localhost"]
}
```
Always write the port (without it `mcp-remote` picks another port and the Callback URL will not match) and keep `--host localhost` (required on Windows).

After the yes, for each file, run this as one block. It copies the file to a backup next to it, then uses Node.js to add or replace only this entry and re-reads the file to confirm it is valid JSON. The values go through environment variables to avoid quoting problems and are cleared at the end:
```powershell
$f = '<config file path>'
if (Test-Path $f) { Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
$env:SFB_FILE = $f
$env:SFB_NAME = 'salesforce-conector-<name>'
$env:SFB_URL  = '<server url>'
$env:SFB_KEY  = '<consumer key>'
$env:SFB_PORT = '<port>'
node -e @'
const fs = require('fs');
const f = process.env.SFB_FILE;
const name = process.env.SFB_NAME;
let cfg = {};
if (fs.existsSync(f)) {
  const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  if (raw.trim()) cfg = JSON.parse(raw);
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
const existed = Object.prototype.hasOwnProperty.call(cfg.mcpServers, name);
cfg.mcpServers[name] = {
  command: 'npx',
  args: ['-y', 'mcp-remote', process.env.SFB_URL, process.env.SFB_PORT,
    '--static-oauth-client-info', JSON.stringify({ client_id: process.env.SFB_KEY }),
    '--host', 'localhost'],
};
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(f, 'utf8'));
console.log((existed ? 'Replaced ' : 'Added ') + name + ' in ' + f);
'@
Remove-Item Env:SFB_FILE, Env:SFB_NAME, Env:SFB_URL, Env:SFB_KEY, Env:SFB_PORT
```
If the command fails, nothing was written (an invalid file stops it before saving); tell the user. If the file ends up wrong, copy the backup back over it. Tell the user where the backup is.

## Step 8: first sign-in
Claude stops a connector that takes more than about 30 seconds to start, which is too short for a browser login, so the first sign-in is done from a terminal. Ask the user to open a normal **Command Prompt** (`cmd.exe`) and run this (give it with their values filled in):
```
npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<CONSUMER_KEY>\"}" --host localhost
```
The browser opens the Salesforce login. The user signs in with their own Salesforce user; when the terminal shows it is connected, they press Ctrl+C. A browser tab that opens and closes at once is normal when already signed in to the org.

If the sign-in fails:
- `redirect_uri_mismatch`: the Callback URL in Salesforce is not exactly `http://localhost:<port>/oauth/callback`.
- `ERR_SSL_PROTOCOL_ERROR` on `https://localhost:...`: change `https://` to `http://` in the address bar and press Enter.
- `401 Invalid token` or `scope parameter not supported`: the admin must enable JWT-based access tokens in the External Client App.
- `404 Server definition not found`: wrong Server URL, or the MCP server is not active in Salesforce.
- Port in use: an old `mcp-remote` is still running; close other Claude windows and try again.

## Step 9: confirm
Ask the user to open Claude Desktop again and/or start a new Claude Code session (Claude Code reads the config only when a session starts). The connector appears under MCP servers (Claude Code) or Settings > Developer (Claude Desktop); if it shows a warning, click Reconnect. Then the user asks Claude "who am I in Salesforce?". If the connector's `getUserInfo` tool returns their user, the install is done: nothing else to configure or test.

## Remove
1. Steps 4 to 6 to find the entry (Claude Code may also have it under a project; the list in Step 6 shows where).
2. Show the user the name, file and place that will be removed and ask for a yes.
3. For each file, as one block (backup, then delete only that key; leave `SFB_PROJECT` empty for the top level, or set it to the project path printed in Step 6):
```powershell
$f = '<config file path>'
Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
$env:SFB_FILE = $f
$env:SFB_NAME = 'salesforce-conector-<name>'
$env:SFB_PROJECT = ''
node -e @'
const fs = require('fs');
const f = process.env.SFB_FILE;
const name = process.env.SFB_NAME;
const scope = process.env.SFB_PROJECT;
const cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const servers = scope ? ((cfg.projects || {})[scope] || {}).mcpServers : cfg.mcpServers;
if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) {
  console.error(name + ' was not found. Nothing was changed.');
  process.exit(1);
}
delete servers[name];
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(f, 'utf8'));
console.log('Removed ' + name + ' from ' + f);
'@
Remove-Item Env:SFB_FILE, Env:SFB_NAME, Env:SFB_PROJECT
```
4. The connector disappears after Claude Desktop is reopened or a new Claude Code session starts. The saved login in `%USERPROFILE%\.mcp-auth` is not removed; leave it unless the user asks.

## If you cannot run commands
Guide the user instead: collect the values (Step 2), ask them to close Claude Desktop, open the config file in a text editor (Claude Desktop: Settings > Developer > Edit Config; Claude Code: `%USERPROFILE%\.claude.json`), keep a copy of the file, add the entry from Step 7 inside the top-level `mcpServers` object (they type the Consumer Key themselves), save, then do Steps 8 and 9. Ask only for the specific result you need, never for the whole file.
