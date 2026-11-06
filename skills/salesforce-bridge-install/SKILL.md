---
name: salesforce-bridge-install
description: Install, guide the installation of, or remove a Claude Salesforce Bridge connection (salesforce-conector-<name>, mcp-remote against a Salesforce Hosted MCP server) in Claude Code and/or Claude Desktop on Windows, with or without the installer. Use when the user wants to connect Claude to Salesforce or add, edit or remove the Salesforce connector.
---
# Salesforce Bridge: install

## Rules
- Never guess values; ask the user. Never ask for a Consumer Secret (public client with PKCE). Do not echo the full Consumer Key.
- Before writing any config: user confirms, Claude fully closed (including tray icon), backup `<file>.bak-<yyyyMMdd-HHmmss>` made. Change only the connector key.
- On any error, use `salesforce-bridge-check`.

## Prerequisites
- Node.js 18+ (`node -v`, `npx -v`).
- Salesforce admin: MCP Service enabled, MCP server active; External Client App with Callback URL `http://localhost:<port>/oauth/callback`, scopes `mcp_api` and `refresh_token, offline_access`, PKCE on, JWT-based access tokens on, no secret required.

## Ask the user
- **Name**: saved as `salesforce-conector-<name>`; lowercase letters, digits, single hyphens, max 40.
- **Server URL**: `https://...` from Setup > MCP Servers.
- **Consumer Key**: from the External Client App.
- **Port**: default `8080`, must match the Callback URL.
- **Destination**: Claude Code, Claude Desktop, or both.

## With the installer (preferred)
The menu needs a real terminal, so the user runs it:
1. Close Claude. Run `installer\install.cmd`.
2. **Configure connection > Create**, enter the values, **Save** (backups are made automatically).
3. **Sign in and test the connection now**, sign in in the browser.
4. Then verify: `installer\install.cmd --check <name> --json`.

## Without the installer
1. Files (top-level `mcpServers`):
   - Claude Code: `%USERPROFILE%\.claude.json`
   - Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json` (Store version: `%LOCALAPPDATA%\Claude-Data\claude_<id>\`)
2. Entry to add (show it to the user first; ask before replacing an existing one):
   ```json
   "salesforce-conector-<name>": {
     "command": "npx",
     "args": ["-y", "mcp-remote", "<SERVER_URL>", "<PORT>",
              "--static-oauth-client-info", "{\"client_id\":\"<CONSUMER_KEY>\"}",
              "--host", "localhost"]
   }
   ```
3. Close Claude, back up the file, add only that key keeping the rest of the JSON, then validate:
   `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^﻿/,''))" "<file>"`
   If invalid, restore the backup.
4. First sign-in (before opening Claude): the user runs in `cmd.exe` and signs in in the browser, then Ctrl+C:
   `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<KEY>\"}" --host localhost`
5. Open Claude, Reconnect the connector if needed, run `salesforce-bridge-check` and walk the user through `TESTING.md`.

## Remove
Confirm with the user what and where.
- Installer: `installer\install.cmd --remove <name> --json` (dry run), then `--remove <name> --from code|desktop|all --yes --json`.
- Manual: close Claude, back up, delete only that key, validate the JSON.
