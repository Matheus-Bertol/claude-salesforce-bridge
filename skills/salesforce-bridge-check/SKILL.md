---
name: salesforce-bridge-check
description: Check or troubleshoot a Claude Salesforce Bridge connection (salesforce-conector-* MCP server running mcp-remote) in Claude Code or Claude Desktop on Windows. Use when the user asks to verify the Salesforce connector, when its tools are missing or fail, on sign-in, token, 401, 404, redirect_uri or port errors, or to restore a config backup.
---
# Salesforce Bridge: check

## Rules
- Read-only by default. Clearing a login, removing or restoring only after the user says yes, with Claude fully closed and a `<file>.bak-<yyyyMMdd-HHmmss>` backup first.
- Never ask for a Consumer Secret. Never print the full Consumer Key, tokens or `.mcp-auth` content.

## With the installer (preferred)
From the repo root (`<name>` with or without the `salesforce-conector-` prefix):
1. `installer\install.cmd --list --json`: connections with place, file, url, port, `hostLocalhost`, `login.saved`.
2. `installer\install.cmd --check <name> --json`: `checks[]` and `places[].checks[]`, each `{ id, level: ok|warn|error, message }` (ids `node`, `npx`, `config`, `entry`, `url`, `clientId`, `host`, `port`, `portFree`, `login`, and `test` with `--test`). `ok: false` if any `error` or the test fails.
3. Only after telling the user the browser may open: `installer\install.cmd --check <name> --test --json` (signs in, lists tools, `test.hints[]` on failure).

Exit codes: `0` ok, `1` problem found, `2` usage error or dry run.
The installer only finds `salesforce-conector-*`; for the old name `conector-salesforce`, check manually.

## Without the installer
1. Find the entry under `mcpServers` (top level, and `projects[<folder>].mcpServers` in Claude Code) in:
   - `%USERPROFILE%\.claude.json`
   - `%APPDATA%\Claude\claude_desktop_config.json` or `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json`
2. Expected args: `-y mcp-remote <https URL> <port> --static-oauth-client-info {"client_id":"..."} --host localhost`.
3. `node -v` (18+), `npx -v`, port free: `netstat -ano | findstr :<port>`.
4. Login saved if `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_tokens.json` exists, where `<hash>` is:
   `node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex'))" "<SERVER_URL>"`
5. Test: the user runs in `cmd.exe` and signs in in the browser:
   `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<KEY>\"}" --host localhost`
   Then open Claude and Reconnect the connector.

## End-to-end test with the user
To confirm it works in Claude, walk the user through `TESTING.md` at the repo root, one section at a time, and wait for their result before the next. It uses the example name `conector-salesforce`; tell the user to read it as their own connector name.

## Common errors
- **Worked before, now 401 / invalid token**: the token expired (renewal does not work). Clear the login: `installer\install.cmd --clear-login <name>` (dry run), then with `--yes`. Without the installer, move `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_*` to a backup folder. Sign in again.
- **`redirect_uri_mismatch`**: port in args differs from the Callback URL `http://localhost:<port>/oauth/callback`, or `--host localhost` is missing. With no port in args, mcp-remote derives one from the URL, so always set it.
- **Port in use / `EADDRINUSE`**: end the old `node.exe` shown by `netstat`, or change the port in args and in the Callback URL.
- **401 / `scope parameter not supported` on first sign-in**: admin must enable JWT-based access tokens in the External Client App; then clear the login.
- **404 / `Server definition not found`**: wrong Server URL or server inactive (Setup > MCP Servers).

## Restore a backup
List `dir "<file>.bak-*"`, let the user pick, close Claude, back up the current file, copy the chosen backup over it, run the check again.
