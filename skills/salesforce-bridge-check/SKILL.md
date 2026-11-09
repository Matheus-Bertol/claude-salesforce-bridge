---
name: salesforce-bridge-check
description: Check or troubleshoot a Salesforce connector (salesforce-conector-* MCP server running mcp-remote against a Salesforce Hosted MCP server) in Claude Code or Claude Desktop on Windows. Use when the user asks is my Salesforce connection working, when the Salesforce tools are missing or fail, on sign-in or expired login problems, on 401, 404, redirect_uri_mismatch, port in use or ERR_SSL_PROTOCOL_ERROR errors, or to clear the saved login and sign in again.
---
# Salesforce Bridge: check and fix

You run the checks yourself on the user's Windows computer, explaining each in one short line. This skill needs nothing besides this text: no installer, no download of scripts, no other file.

Background: the connector is an entry named `salesforce-conector-<name>` under `mcpServers` in Claude's config. It runs `mcp-remote` (through `npx`, or `node.exe` with a local copy) as a local bridge to a Salesforce Hosted MCP server. The user signs in to Salesforce in the browser (OAuth with PKCE, no secret); the login is saved in `%USERPROFILE%\.mcp-auth`.

## Rules
- Read-only by default. Clearing a login, ending a process or restoring a backup happens only after the user says yes, and after you show what will change.
- Never ask for a Consumer Secret, password or token. Never print the full Consumer Key (first 4 and last 4 characters only), tokens, or the content of any file in `%USERPROFILE%\.mcp-auth` (file names are fine).
- Run commands and read files yourself. Do not ask the user to paste config files. If you cannot run commands, ask only for the specific result you need (for example the `node -v` output).
- If something does not match these steps, stop and tell the user. Do not improvise.

## Start here: getUserInfo
If a `salesforce-conector-*` tool is available in this session, call its `getUserInfo` first.
- It returns the user: the connection works. Tell the user and stop. Do not run the checks below, do not ask for anything else, do not add caveats.
- The tool is missing or the call fails: continue.

## Diagnose
1. **Node.js**: `node -v` must be 20 or newer. If it is missing or older, stop: the user installs Node.js LTS from nodejs.org.
2. **Config file**:
   - Claude Code: `%USERPROFILE%\.claude.json` (top-level `mcpServers`; an entry under `projects` only loads in that folder).
   - Claude Desktop reads only one file. If `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` exists (packaged/MSIX install), that file wins and `%APPDATA%\Claude` is ignored by the app. Otherwise `%APPDATA%\Claude\claude_desktop_config.json`.
   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
     ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json' } |
     Where-Object { Test-Path $_ }
   Test-Path "$env:APPDATA\Claude\claude_desktop_config.json"
   Test-Path "$env:USERPROFILE\.claude.json"
   ```
3. **Entry** (read-only; the key is printed masked). Run for each file found:
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
         name, where, command: s.command, firstArg: u > 0 ? a[0] : null,
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
   (Remove the leading indentation when you run it: the closing `'@` must start the line.)
   A good entry has: `url` starting with `https://`, a `port`, `hostLocalhost: true`, a `consumerKey`, and `command` either `npx` (args start with `-y mcp-remote`) or the full path of `node.exe` with `firstArg` pointing to a local `mcp-remote\dist\proxy.js` (then check that both paths exist with `Test-Path`).
   - No entry in the file the app reads: the connector is not installed there, or it was saved in the file the app ignores, or Claude Desktop was open while saving and overwrote it.
   - Invalid JSON: tell the user; do not rewrite the file.
   - Missing port or `--host localhost`: the entry must be fixed (the port must match the Callback URL in Salesforce, `http://localhost:<port>/oauth/callback`).
4. **Port**: `netstat -ano | findstr :<port>`. A line with `LISTENING` while Claude is closed is usually an old `mcp-remote`; see "Port in use" below.
5. **Saved login** (file names only, never the content). The login files are named with the MD5 of the Server URL exactly as written in the entry:
   ```powershell
   $url = '<server url from the entry>'
   $md5 = [System.Security.Cryptography.MD5]::Create()
   $hash = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($url)) | ForEach-Object { $_.ToString('x2') })
   Get-ChildItem "$env:USERPROFILE\.mcp-auth\mcp-remote-*\${hash}_*" -File -ErrorAction SilentlyContinue |
     Select-Object FullName, LastWriteTime
   ```
   A `..._tokens.json` file means a login is saved (it may still be expired). No file means the user never signed in. If the entry uses `--resource`, `--header` or similar extra options, or has an `env` block, the hash or the folder may be different: do not guess which files belong to it.
6. Tell the user what you found and which fix below applies.

## Clear the login of one connection and sign in again
Use when the login is expired or invalid (it worked before and now fails with 401, `invalid token`, or `scope parameter not supported`). The token cannot be renewed automatically, so the fix is a new sign-in.
1. Run diagnose step 5 and show the user the file names. Say that connections with the same Server URL share this login. Ask for a yes.
2. Ask the user to close Claude (Desktop and Code sessions using the connector), so no old `mcp-remote` keeps the old token.
3. Move only those files to a dated backup folder inside `.mcp-auth` (nothing is deleted). Run as one block:
   ```powershell
   $url = '<server url from the entry>'
   $md5 = [System.Security.Cryptography.MD5]::Create()
   $hash = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($url)) | ForEach-Object { $_.ToString('x2') })
   $dest = "$env:USERPROFILE\.mcp-auth\backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
   Get-ChildItem "$env:USERPROFILE\.mcp-auth\mcp-remote-*\${hash}_*" -File | ForEach-Object {
     $d = Join-Path $dest $_.Directory.Name
     New-Item -ItemType Directory -Force -Path $d | Out-Null
     Move-Item $_.FullName $d
     "moved $($_.Name)"
   }
   ```
4. Sign in again. Claude stops a connector that takes more than about 30 seconds to start, so the sign-in is done from a terminal. Ask the user to open a normal **Command Prompt** (`cmd.exe`) and run this with the values from the entry (they copy the Consumer Key from the config file or get it from their admin; do not print it in full):
   ```
   npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<CONSUMER_KEY>\"}" --host localhost
   ```
   `npx` downloads `mcp-remote` from the npm registry if needed. The browser opens the Salesforce login; after signing in and seeing the terminal connect, the user presses Ctrl+C. A browser tab that opens and closes at once is normal when already signed in to the org.
5. Open Claude again, click Reconnect on the connector if it shows a warning, and go to "Confirm it works".

## Common errors
- **Worked before, now 401 / `invalid token` / `scope parameter not supported`**: the token expired and renewal does not work with Salesforce (known limitation). Clear that login and sign in again (section above).
- **401 `Invalid token` on the very first sign-in**: the Salesforce admin must enable "Issue JSON Web Token (JWT)-based access tokens for named users" in the External Client App. Then clear the login and sign in again. App changes can take up to 30 minutes to apply.
- **404 / `Server definition not found`**: the URL is not the Server URL shown in Salesforce (Setup > MCP Servers), or that server is not active. The user asks the admin for the exact URL; do not build it by hand.
- **`redirect_uri_mismatch`**: the port in the entry differs from the Callback URL in the External Client App (must be exactly `http://localhost:<port>/oauth/callback`), or `--host localhost` is missing from the entry (without it the callback is sent as `127.0.0.1`).
- **`ERR_SSL_PROTOCOL_ERROR` on `https://localhost:<port>/oauth/callback`**: the callback must be `http`. Change `https://` to `http://` in the address bar and press Enter (the code stays valid for a few minutes). If the Callback URL in Salesforce already starts with `http://`, the browser forced HTTPS: delete the security policy for `localhost` at `edge://net-internals/#hsts` or `chrome://net-internals/#hsts` ("Delete domain security policies").
- **Port in use / `EADDRINUSE`**: usually an old `mcp-remote`. Find the process id in the last column of `netstat -ano | findstr :<port>`, confirm it is `node.exe` with `tasklist /FI "PID eq <pid>"`, and ask the user before ending it (`taskkill /PID <pid>`), or ask them to close all Claude windows. Changing the port instead means changing it in the entry and in the Callback URL.
- **Sign-in page never appears when starting from Claude**: sign in from a terminal first (step 4 above), then Reconnect.
- **Connector missing in Claude**: wrong Claude Desktop file (see diagnose step 2), Claude Desktop was open while the entry was saved, or the Claude Code session started before the entry existed (start a new session).
- **Claude cannot find `npx`**: in the entry, use `"command": "cmd"` and start `args` with `"/c", "npx"`. Show the change and ask before saving, with a backup.
- **`Invalid expires_in detected` in the log**: harmless.
- **Need more detail**: with the user's OK, add `"--debug"` to the entry's `args`; the log goes to `%USERPROFILE%\.mcp-auth` (`<hash>_debug.log`). It can contain sensitive values: read it yourself, quote only the error lines, and remove `--debug` afterwards.

## Changing a config file
Any fix that changes a config file: show the user the file and the exact change, wait for a yes, have Claude Desktop fully closed (it rewrites its config on close), copy the file to `<file>.bak-<yyyyMMdd-HHmmss>` first, change only the connector entry, and check that the file is still valid JSON. To undo, list the backups (`Get-ChildItem "<file>.bak-*"`), let the user pick one, close Claude, and copy it back over the file.

## Confirm it works
After a fix, ask the user to restart Claude and ask "who am I in Salesforce?". If `getUserInfo` returns their user, it is done; nothing else to test.
