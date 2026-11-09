---
name: salesforce-bridge-check
description: Check or troubleshoot a Claude Salesforce Bridge connection (salesforce-conector-* MCP server running mcp-remote) in Claude Code or Claude Desktop on Windows. Use when the user asks to verify the Salesforce connector, when its tools are missing or fail, on sign-in, token, 401, 404, redirect_uri or port errors, or to restore a config backup.
---
# Salesforce Bridge: check

## Rules
- Read-only by default. Clearing a login, removing or restoring only after the user says yes.
- Never ask for a Consumer Secret. Never print the full Consumer Key, tokens or `.mcp-auth` content.
- Run commands and read files yourself. Do not ask the user to paste config files. If you cannot run commands on the user's machine, ask only for the specific result you need (for example the `node -v` output), never a whole file.
- Recommend the installer's check options first; the manual checks are more complex and easier to get wrong. Ask before downloading anything.

## Start here: getUserInfo
If a `salesforce-conector-*` tool is available in this session, call its `getUserInfo` first. If it returns the user, the connection works: tell the user it is set up and stop. Do not run the checks below, do not ask for anything else and do not add caveats about other clients. Go on only if the tool is missing or the call fails.

## Option 1: installer (recommended, easier)
1. Ask whether the user has the installer (`install.ps1`, from the project's `installer` folder) and where. If not, suggest getting it from https://github.com/Matheus-Bertol/claude-salesforce-bridge (Code > Download ZIP), or, with the user's OK, download the single file:
   `Invoke-WebRequest https://raw.githubusercontent.com/Matheus-Bertol/claude-salesforce-bridge/main/installer/install.ps1 -OutFile "$env:USERPROFILE\Downloads\claude-salesforce-bridge\install.ps1"` (create the folder first).
2. Run (`<name>` with or without the `salesforce-conector-` prefix; prefix each with `powershell -ExecutionPolicy Bypass -File "<path>\install.ps1"`):
   - `-List -Json`: every connection with place, config file, URL, port, `--host localhost` and saved login.
   - `-Check <name> -Json`: entry, Node.js, mcp-remote, port and saved login; any `error` means a problem.
   - Only after telling the user the browser may open: `-Check <name> -Test -Json` (signs in, lists tools, `hints` on failure).
   - Expired or invalid login: `-ClearLogin <name> -Json` (dry run), then with `-Yes` after the user agrees. Then the user signs in again: run the installer without options (it offers the sign-in for expired logins) or `-Check <name> -Test`.
   Exit codes: `0` ok, `1` problem found, `2` usage error or dry run.
3. To fix a wrong value (URL, key, port), the user runs the installer again with the same name; see `salesforce-bridge-install`.

## Option 2: manual (no installer, more complex)
1. `node -v` (20+). Stop here if Node is missing or older.
2. Find the entry (`salesforce-conector-<name>`, or the old name `conector-salesforce`) under `mcpServers` (top level, and `projects[<folder>].mcpServers` in Claude Code) in:
   - `%USERPROFILE%\.claude.json`
   - Claude Desktop: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` if it exists (packaged/MSIX install; the app ignores `%APPDATA%\Claude\` then), otherwise `%APPDATA%\Claude\claude_desktop_config.json`.
3. Expected args: either `-y mcp-remote <https URL> <port> --static-oauth-client-info {"client_id":"..."} --host localhost` (`npx`), or, for installer entries, `command` = full path of `node.exe` and the first arg `...\ClaudeSalesforceBridge\ponte\node_modules\mcp-remote\dist\proxy.js` (check that both paths exist).
4. Port free: `netstat -ano | findstr :<port>`.
5. Login saved if `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_tokens.json` exists, where `<hash>` is:
   `node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex'))" "<SERVER_URL>"`
6. Sign-in test: the user runs in `cmd.exe` and signs in in the browser:
   `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<KEY>\"}" --host localhost`
   Then open Claude and Reconnect the connector.

## Common errors
- **Worked before, now 401 / invalid token / `scope parameter not supported` on refresh**: the token expired (renewal does not work). Clear that login (installer `-ClearLogin`, or move `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_*` to a backup folder) and sign in again.
- **`redirect_uri_mismatch`**: port in args differs from the Callback URL `http://localhost:<port>/oauth/callback`, or `--host localhost` is missing.
- **`ERR_SSL_PROTOCOL_ERROR` on `https://localhost:<port>/oauth/callback`**: change `https://` to `http://` in the address bar and press Enter; if the browser keeps forcing HTTPS, delete the HSTS rule for `localhost` at `edge://net-internals/#hsts` or `chrome://net-internals/#hsts`.
- **Port in use / `EADDRINUSE`**: end the old `node.exe` shown by `netstat`, or change the port in args and in the Callback URL.
- **401 on the first sign-in**: admin must enable JWT-based access tokens in the External Client App; then clear the login.
- **404 / `Server definition not found`**: wrong Server URL or server inactive (Setup > MCP Servers).
- **Connector missing after install**: Claude Desktop was open while saving, or the wrong Desktop file was edited (see manual step 2). Restart Claude.

## Confirm it works
After a fix, ask the user to restart Claude and ask it who they are in Salesforce. If `getUserInfo` returns their user, it is done; nothing else to test.

## Restore a backup
For manual edits: list `dir "<file>.bak-*"`, let the user pick, close Claude, back up the current file, copy the chosen backup over it, check again. (The installer does not create backup files.)
