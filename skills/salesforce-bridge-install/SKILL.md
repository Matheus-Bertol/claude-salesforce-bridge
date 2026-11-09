---
name: salesforce-bridge-install
description: Install, guide the installation of, or remove a Claude Salesforce Bridge connection (salesforce-conector-*, mcp-remote against a Salesforce Hosted MCP server) in Claude Code and/or Claude Desktop on Windows. Use when the user wants to connect Claude to Salesforce or add, edit or remove the Salesforce connector.
---
# Salesforce Bridge: install

## Rules
- Never guess values; ask the user. Never ask for a Consumer Secret (public client with PKCE). Do not echo the full Consumer Key.
- Recommend the installer first. Offer the manual path only if the user cannot or does not want to use it, and say it is more complex and easier to get wrong.
- The installer is bundled with this skill: `scripts/install.ps1`, in the same folder as this `SKILL.md`. Use that file; do not download it from anywhere else and do not edit it.
- Do not close Claude Desktop yourself.
- On any error, use `salesforce-bridge-check`.

## Prerequisites (check first)
- Windows. Node.js 20+ (`node -v`); the installer offers to install it with `winget` if missing.
- From the Salesforce admin: **Server URL** (Setup > MCP Servers) and **Consumer Key** of the External Client App, with Callback URL `http://localhost:<port>/oauth/callback` (default port `8080`), PKCE on, JWT-based access tokens on, no secret required.

## Option 1: installer (recommended, easier)
1. Get the installer path (`<path>` below):
   - **You can run commands on the user's Windows computer (Claude Code):** `<path>` is the full path of the bundled `scripts\install.ps1` in this skill's folder. Use it where it is.
   - **You cannot (claude.ai and similar):** give the bundled `scripts/install.ps1` to the user as a file to download (do not paste its content in the chat). Ask them to save it, for example in `Downloads`; `<path>` is where they saved it.
2. Ask for the values: **Name** (saved as `salesforce-conector-<name>`; lowercase letters, digits, single hyphens, max 40), **Server URL**, **Consumer Key**, **Port** (Enter = `8080`).
3. Installing is interactive, so the user always runs it in a normal PowerShell or CMD window (not inside Claude). Give them the command with the values filled in, so it only asks Y/N questions:
   `powershell -ExecutionPolicy Bypass -File "<path>\install.ps1" -Name <name> -ServerUrl "<url>" -ConsumerKey "<key>" -Port <port>`
   It checks Node.js, installs `mcp-remote` locally, saves the connector in every Claude Code / Claude Desktop config it finds, asks before closing Claude Desktop, and offers the browser sign-in at the end. To edit a connection, run it again with the same name.
4. When the user is done, go to **Confirm it works**.

Remove with the installer: first the dry run
`powershell -ExecutionPolicy Bypass -File "<path>\install.ps1" -Remove <name> -Json`, show what would change, and only after the user says yes:
`... -Remove <name> -From code|desktop|all -Yes -Json`.
Run these yourself when you can run commands on the user's computer; otherwise the user runs them and tells you the result.

## Option 2: manual (no installer, more complex)
Warn the user that this path has more steps and is easier to get wrong. Before writing any config: user confirms, Claude Desktop fully closed (including tray icon), backup `<file>.bak-<yyyyMMdd-HHmmss>` made. Change only the connector key.
1. Files (top-level `mcpServers`):
   - Claude Code: `%USERPROFILE%\.claude.json`
   - Claude Desktop: if `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` exists (packaged/MSIX install), edit that file; the app ignores `%APPDATA%\Claude\` in that case. Otherwise `%APPDATA%\Claude\claude_desktop_config.json`.
2. Entry to add (show it to the user first; ask before replacing an existing one):
   ```json
   "salesforce-conector-<name>": {
     "command": "npx",
     "args": ["-y", "mcp-remote", "<SERVER_URL>", "<PORT>",
              "--static-oauth-client-info", "{\"client_id\":\"<CONSUMER_KEY>\"}",
              "--host", "localhost"]
   }
   ```
   Always write the port and keep `--host localhost`.
3. Add only that key keeping the rest of the JSON, then validate:
   `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^﻿/,''))" "<file>"`
   If invalid, restore the backup.
4. First sign-in (before opening Claude): the user runs in `cmd.exe` and signs in in the browser, then Ctrl+C:
   `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<KEY>\"}" --host localhost`
5. Remove: confirm what and where (Claude Code: top level and `projects[<folder>].mcpServers`; Claude Desktop), close Claude, back up, delete only that key, validate the JSON.

## Confirm it works
Ask the user to open (or restart) Claude, Reconnect the connector if needed, and ask it who they are in Salesforce. If `getUserInfo` returns the user, the install is done; nothing else to configure or test. Use `salesforce-bridge-check` only if it fails.
