---
name: salesforce-bridge-check
description: Check or troubleshoot a Claude Salesforce Bridge connection (salesforce-conector-* MCP server running mcp-remote) in Claude Code or Claude Desktop on Windows. Use when the user asks to verify the Salesforce connector, when its tools are missing or fail, on sign-in, token, 401, 404, redirect_uri or port errors, or to restore a config backup.
---
# Salesforce Bridge: check

## Rules
- Read-only by default. Clearing a login, removing or restoring only after the user says yes, with Claude fully closed and a `<file>.bak-<yyyyMMdd-HHmmss>` backup first.
- Never ask for a Consumer Secret. Never print the full Consumer Key, tokens or `.mcp-auth` content.
- Do not run the installer (`installer\install.cmd`); do the checks below yourself. It is a menu for users who prefer not to edit the config: mention it only as an option for them to run on their own.
- Run commands and read files yourself. Do not ask the user to paste config files. If you cannot run commands on the user's machine, ask only for the specific result you need (for example the `node -v` output), never a whole file.

## Start here: getUserInfo
If a `salesforce-conector-*` tool is available in this session, call its `getUserInfo` first. If it returns the user, the connection works: tell the user it is set up and stop. Do not run the checks below, do not ask for anything else and do not add caveats about other clients. Go on to the checks only if the tool is missing or the call fails.

## Checks
1. `node -v` (18+) and `npx -v`. Stop here if Node is missing or older.
2. Find the entry (`salesforce-conector-<name>`, or the old name `conector-salesforce`) under `mcpServers` (top level, and `projects[<folder>].mcpServers` in Claude Code) in:
   - `%USERPROFILE%\.claude.json`
   - `%APPDATA%\Claude\claude_desktop_config.json`, `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` or `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json` (Windows may redirect `%APPDATA%\Claude` to the `Packages` folder, so two paths can be the same file)
3. Expected args: `-y mcp-remote <https URL> <port> --static-oauth-client-info {"client_id":"..."} --host localhost`.
4. Port free: `netstat -ano | findstr :<port>`.
5. Login saved if `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_tokens.json` exists, where `<hash>` is:
   `node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex'))" "<SERVER_URL>"`
6. Test: the user runs in `cmd.exe` and signs in in the browser:
   `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<KEY>\"}" --host localhost`
   Then open Claude and Reconnect the connector.

## Confirm it works
After a fix, ask the user to restart Claude and ask it who they are in Salesforce. If `getUserInfo` returns their user, it is done; nothing else to test.

## Common errors
- **Worked before, now 401 / invalid token**: the token expired (renewal does not work). Clear the login: move `%USERPROFILE%\.mcp-auth\mcp-remote-*\<hash>_*` to a backup folder. Sign in again.
- **`redirect_uri_mismatch`**: port in args differs from the Callback URL `http://localhost:<port>/oauth/callback`, or `--host localhost` is missing. With no port in args, mcp-remote derives one from the URL, so always set it.
- **Port in use / `EADDRINUSE`**: end the old `node.exe` shown by `netstat`, or change the port in args and in the Callback URL.
- **401 / `scope parameter not supported` on first sign-in**: admin must enable JWT-based access tokens in the External Client App; then clear the login.
- **404 / `Server definition not found`**: wrong Server URL or server inactive (Setup > MCP Servers).

## Restore a backup
List `dir "<file>.bak-*"`, let the user pick, close Claude, back up the current file, copy the chosen backup over it, run the check again.
