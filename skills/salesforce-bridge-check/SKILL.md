---
name: salesforce-bridge-check
description: Check or troubleshoot a Claude Salesforce Bridge connection (salesforce-conector-* MCP server running mcp-remote) in Claude Code or Claude Desktop on Windows. Use when the user asks to verify the Salesforce connector, when its tools are missing or fail, on sign-in, token, 401, 404, redirect_uri or port errors, or to restore a config backup.
---
# Salesforce Bridge: check

## Rules
- Read-only by default. Clearing a login, removing or restoring only after the user says yes, with Claude fully closed and a `<file>.bak-<yyyyMMdd-HHmmss>` backup first.
- Never ask for a Consumer Secret. Never print the full Consumer Key, tokens or `.mcp-auth` content.
- Do not run the installer (`installer\install.cmd`); do the checks below yourself. It is a menu for users who prefer not to edit the config: mention it only as an option for them to run on their own.

## Checks
1. Find the entry (`salesforce-conector-<name>`, or the old name `conector-salesforce`) under `mcpServers` (top level, and `projects[<folder>].mcpServers` in Claude Code) in:
   - `%USERPROFILE%\.claude.json`
   - `%APPDATA%\Claude\claude_desktop_config.json`, `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` or `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json` (Windows may redirect `%APPDATA%\Claude` to the `Packages` folder, so two paths can be the same file)
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
- **Worked before, now 401 / invalid token**: the token expired (renewal does not work). Clear the login: move `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_*` to a backup folder. Sign in again.
- **`redirect_uri_mismatch`**: port in args differs from the Callback URL `http://localhost:<port>/oauth/callback`, or `--host localhost` is missing. With no port in args, mcp-remote derives one from the URL, so always set it.
- **Port in use / `EADDRINUSE`**: end the old `node.exe` shown by `netstat`, or change the port in args and in the Callback URL.
- **401 / `scope parameter not supported` on first sign-in**: admin must enable JWT-based access tokens in the External Client App; then clear the login.
- **404 / `Server definition not found`**: wrong Server URL or server inactive (Setup > MCP Servers).

## Restore a backup
List `dir "<file>.bak-*"`, let the user pick, close Claude, back up the current file, copy the chosen backup over it, run the check again.
