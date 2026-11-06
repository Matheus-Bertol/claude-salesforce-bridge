# Fast install prompt (Claude Desktop, Windows)

Copy everything below the line and paste it into Claude Code, or any Claude that can run commands on your computer. Claude asks you for each value and sets up the Salesforce connector in Claude Desktop for you.

You need: Node.js 18 or newer, Claude Desktop installed, and the **Server URL** and **Consumer Key** from your Salesforce admin. There is **no client secret**.

---

You are going to install a Salesforce connector in my **Claude Desktop** on Windows by running commands yourself. The connector is an `mcp-remote` entry in `claude_desktop_config.json` that points to a Salesforce Hosted MCP server and signs in with OAuth (PKCE, public client, no secret). Talk to me in my language. Explain each step in one short line before you run it.

## Rules

- Ask me for **one value at a time** and wait for my answer. Never invent or guess a value.
- **Never ask for a client secret, password or token.** If I paste one, tell me it is not needed and do not use it or write it anywhere.
- Change only the `mcpServers` entry of this connector. Keep everything else in the config file exactly as it is.
- Back up every config file before you change it.
- If something fails or does not match these steps, stop and tell me. Do not improvise workarounds.

## Step 1: collect the values

Ask for these in order, and check each one before you move on:

1. **Connection name**: a short name, for example `sales`. Use lowercase letters, numbers and single hyphens, at most 40 characters, starting and ending with a letter or number. The entry will be called `salesforce-conector-<name>`.
2. **Server URL**: the full Salesforce Hosted MCP URL. It must start with `https://` and must not point to `localhost`.
3. **Consumer Key**: the Consumer Key of the External Client App / Connected App in Salesforce. It is not secret, but do not repeat it back in full. Show only the first and last 4 characters.
4. **Callback port**: press Enter for `8080`. If I type a value, it must be a number from 1024 to 65535.

Then show me a summary (name, URL, masked key, port, and the Callback URL `http://localhost:<port>/oauth/callback`) and ask me to confirm before you continue.

## Step 2: check the computer

Run these in PowerShell:

```powershell
node -v
Get-Command npx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

Node must be v18 or newer and `npx` must be found. If not, tell me to install Node.js LTS from https://nodejs.org and stop.

## Step 3: make sure Claude Desktop is closed

Claude Desktop rewrites its config when it closes, so it must not be running while you edit the file. Check it with this command:

```powershell
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  Where-Object { $_.ExecutablePath -match '\\WindowsApps\\Claude_' -or $_.ExecutablePath -like "$env:LOCALAPPDATA\AnthropicClaude\*" } |
  Select-Object ProcessId, ExecutablePath
```

This matches only Claude Desktop, not Claude Code. If it lists anything, ask me to fully quit Claude Desktop (including the tray icon) and run the check again. Do not kill the process yourself unless I tell you to.

## Step 4: find the config file

Claude Desktop can use either of these locations:

- Regular install: `%APPDATA%\Claude\claude_desktop_config.json`
- Microsoft Store install: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`

```powershell
$cands = @("$env:APPDATA\Claude\claude_desktop_config.json")
$cands += Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json' }
foreach ($f in $cands) {
  if (Test-Path $f) { "$f  exists  id=$((fsutil file queryFileID $f) -replace '.*:\s*','')" }
  else { "$f  missing (folder exists: $(Test-Path (Split-Path $f)))" }
}
```

- Update **every file that exists**. If two paths show the same `id`, they are the same file, so update it only once.
- If no file exists but one of the folders exists, create the file in that folder. Prefer the Store folder if it exists.
- If neither the files nor the folders exist, ask me to open Claude Desktop once, close it, and run this step again.

Show me which file(s) you will change and wait for my OK.

## Step 5: back up and write the entry

For each file, first make a backup next to it:

```powershell
Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

Then write the entry with Node. This keeps the rest of the file intact and avoids quoting problems. Pass the values through environment variables and fill in what I gave you:

```powershell
$env:SFB_FILE = $f
$env:SFB_NAME = 'salesforce-conector-<name>'
$env:SFB_URL  = '<server url>'
$env:SFB_KEY  = '<consumer key>'
$env:SFB_PORT = '<port>'
node -e @'
const fs = require('fs'); const path = require('path');
const f = process.env.SFB_FILE;
let cfg = {};
if (fs.existsSync(f)) {
  const raw = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  if (raw.trim()) cfg = JSON.parse(raw);
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
const existed = Object.prototype.hasOwnProperty.call(cfg.mcpServers, process.env.SFB_NAME);
cfg.mcpServers[process.env.SFB_NAME] = {
  command: 'npx',
  args: ['-y', 'mcp-remote', process.env.SFB_URL, process.env.SFB_PORT,
    '--static-oauth-client-info', JSON.stringify({ client_id: process.env.SFB_KEY }),
    '--host', 'localhost'],
};
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(f, 'utf8'));
console.log((existed ? 'Replaced ' : 'Added ') + process.env.SFB_NAME + ' in ' + f);
'@
Remove-Item Env:SFB_FILE, Env:SFB_NAME, Env:SFB_URL, Env:SFB_KEY, Env:SFB_PORT
```

Before you run it, check whether `salesforce-conector-<name>` already exists in that file. If it does, ask me whether to replace it. If the file is not valid JSON, stop and tell me. Do not overwrite it.

Notes on the entry:
- Keep `--host localhost`. It is required on Windows.
- Always write the port. Without it, `mcp-remote` picks a port from the URL and the Callback URL in Salesforce would not match.

## Step 6: finish

Tell me:

1. In Salesforce, the app's **Callback URL** must be exactly `http://localhost:<port>/oauth/callback`, and the app must not require a secret (PKCE, public client).
2. Open Claude Desktop. The connector `salesforce-conector-<name>` should show up in the connectors list.
3. The first time it connects, a browser window opens for the Salesforce login. Sign in with my own user. The login is saved in `%USERPROFILE%\.mcp-auth`.
4. If the browser shows `redirect_uri_mismatch`, the Callback URL in Salesforce does not match the port. If the port is busy, close other Claude windows or old `mcp-remote` processes and try again.
5. Where the backup file(s) are, in case I want to undo.
