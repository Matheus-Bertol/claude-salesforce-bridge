# Claude Salesforce Bridge

Connects Claude Desktop and Claude Code to a Salesforce Hosted MCP server using [`mcp-remote`](https://github.com/geelen/mcp-remote) running locally. Each user signs in with their own Salesforce account (OAuth with PKCE), so Claude only sees the data that user is allowed to see.

This guide sets up the `sobject-reads` server (read-only). The same steps work for other Salesforce Hosted MCP servers; only the Server URL changes.

> The configuration targets Claude. Other MCP clients that run local servers can use the same setup with their own config file.

> **Tested environment:** only tested on Windows, with Claude Code and with Claude Desktop installed as a Windows package (MSIX: it runs from `C:\Program Files\WindowsApps\Claude_*` and reads its config from `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`). Other Claude Desktop installs (for example one that uses `%APPDATA%\Claude\` directly) and other operating systems were not tested.

```
Claude ──stdio──> mcp-remote (local) ──HTTPS/OAuth──> Salesforce Hosted MCP server
```

## Salesforce-side setup

Done once by a Salesforce admin.

1. **Setup → User Interface**: enable **Enable MCP Service**.
2. **Setup → MCP Servers**: activate `sobject-reads` (servers are inactive by default). Copy its **Server URL** exactly as shown. The URL depends on the org, so do not build it by hand.
3. **Setup → External Client App Manager**: create or edit the External Client App.
   - Enable OAuth Settings.
   - **Callback URL:** `http://localhost:8080/oauth/callback`. Salesforce only accepts `http://` with `localhost` and compares the value exactly. The port is the one in the client config (`args`, right after the Server URL; `8080` is the installer default). If you change it, use the same port here. If the client config has no port, `mcp-remote` picks one derived from the Server URL, so always set it.
   - **OAuth scopes:** `Access MCP servers (mcp_api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - **Require Proof Key for Code Exchange (PKCE)**: enabled.
   - **Issue JSON Web Token (JWT)-based access tokens for named users**: enabled. This is required. Without it Salesforce issues opaque tokens (starting with `00D`) and the MCP server returns `401 Invalid token`.
   - **Require secret for Web Server Flow** and **Require secret for Refresh Token Flow**: disabled. The app is a public client with PKCE, so no secret is shared with users.
   - **Policies → Permitted Users:** "Admin approved users are pre-authorized" (then grant access through a profile or permission set) or "All users may self-authorize".
4. **Manage Consumer Details**: copy the **Consumer Key**. Changes to the app can take up to 30 minutes to apply.

## Client-side setup

Done on each user's machine. **Use the installer** (recommended): it does every step below for you. If you prefer to do it by hand, follow [Manual setup](#manual-setup-without-the-installer); those steps still work.

For Claude Desktop, you can also let Claude do the setup for you: paste [fast-install-prompt.md](fast-install-prompt.md) into Claude Code (or any Claude that can run commands on your computer). Claude asks for each value and edits the config file.

### Installer (recommended)

The installer is `installer\install.ps1` (beta). Double-click `installer\install.cmd` (it only starts `install.ps1` from the same folder), or run it from a normal PowerShell or CMD window (not from inside Claude):

```
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

Before it starts, it checks this computer:

- **Node.js 20 or newer.** If Node.js is missing, it offers to install Node.js LTS with `winget` (Windows may ask for permission). Without `winget`, install it from [nodejs.org](https://nodejs.org).
- **mcp-remote** is installed once, with a fixed version, in `%LOCALAPPDATA%\ClaudeSalesforceBridge\ponte`. New connectors run `node.exe` by its full path with that copy, so they do not depend on `PATH` or on `npx` downloading the package each time Claude starts. If the local install fails, the connector falls back to `npx`.
- **Claude Desktop** rewrites its config file when it closes, so it must be closed while saving. If it is open, the installer asks before closing it (or offers to save only in Claude Code); nothing is closed without your confirmation. When the installer ends, it reopens Claude Desktop if it was closed during the run (`-NoRestart` skips this).

**Preconfigured installer.** To hand out an installer with your org's values, fill the "adjust here" block at the top of `install.ps1` (`Name`, `ServerUrl`, `ConsumerKey`, `Port`). Filled values are used in **Create** without asking; empty ones are asked. The same values can be passed as parameters (`-Name`, `-ServerUrl`, `-ConsumerKey`, `-Port`), which win over the block.

The installer runs in a straight line, with no menus:

1. Run the installer as shown above. It shows every `salesforce-conector-*` connection with its live status (**CONNECTED**, **LOGIN EXPIRED**, **NOT SIGNED IN** or **ERROR**), checked with Salesforce using the saved login, without opening the browser. For an expired or missing login it offers to sign in again (it clears that connection's saved login and opens the browser), because the token cannot be renewed automatically.
2. Answer **Y** to install a connection and enter (fields already filled in the "adjust here" block are skipped):
   - **Connection name:** saved as `salesforce-conector-<name>`.
   - **Server URL** and **Consumer Key** from the Salesforce-side setup.
   - **Callback port:** `8080` by default. It must match the Callback URL in the External Client App.

   The installer finds where Claude is installed and saves the connector in every place it finds: Claude Code (`%USERPROFILE%\.claude.json`, when it exists) and every Claude Desktop config location, because Desktop reads a different file depending on how it was installed: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` (packaged/MSIX version, the tested one; the file is created if missing), `%APPDATA%\Claude\` and `%LOCALAPPDATA%\Claude-Data\claude_*\`. Only the connector entry is added; the rest of each file is kept, and the same physical file is written once. The summary lists the files before saving.

   In any field, press **Esc** or type `back` (or `cancel`) to go back one step; when a field already has a value, Enter keeps it. Pasted values are trimmed and surrounding quotes are removed.
3. Check the summary and answer **Y** to save. No backup files are created. Saving is all or nothing: if one file fails, the files already saved are put back as they were. If a connector with the same name already exists, the installer asks before replacing it (default: no). If Claude Desktop is open, it asks to close it first.
4. Answer **Y** to sign in and test the connection. The browser opens the Salesforce login; after you sign in, the installer lists the available tools. The token is saved in `%USERPROFILE%\.mcp-auth` and reused by Claude.
5. Open Claude. `salesforce-conector-<name>` should be listed under MCP servers (Claude Code) or Settings → Developer (Claude Desktop). If it shows a warning, click **Reconnect**.

To edit a connection, run the installer again with the same name (it replaces it). Checking, removing and clearing the login are done with the command-line options below. Only `salesforce-conector-*` connections are handled, so use `salesforce-conector-<name>` in the manual steps below too.

#### Command-line mode

With options, the installer runs without the menu, for scripts and agents:

```
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -Help
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -Version
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -List [-Json]
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -Check <name> [-Test] [-Json]
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -Remove <name> -From code|desktop|all -Yes [-Json]
powershell -ExecutionPolicy Bypass -File installer\install.ps1 -ClearLogin <name> -Yes [-Json]
```

- `<name>` can be given with or without the `salesforce-conector-` prefix.
- `-List` shows each connection with its place, config file, Server URL, port, `--host localhost` and whether a login is saved.
- `-Check` checks the entry, Node.js, mcp-remote (local copy or npx), the port and the saved login. `-Test` also signs in (the browser may open) and lists the tools.
- `-Remove` needs `-From` with `-Yes`; `code` and `all` include every Claude Code project.
- `-ClearLogin` moves only that connection's login files to a `backup-<date>` folder inside `%USERPROFILE%\.mcp-auth`. Connections with the same Server URL share the login.
- Without `-Yes`, `-Remove` and `-ClearLogin` only show what they would do and change nothing.
- `-Json` prints machine-readable output.
- Command-line mode does not install Node.js or mcp-remote and does not close or reopen Claude Desktop.
- Exit codes: `0` ok, `1` problem found or action failed, `2` usage error (including a missing `-Yes`).

### Claude Code plugin and claude.ai skills

The repository is also a Claude Code plugin: the skills in `skills\` (`salesforce-bridge-install`, `salesforce-bridge-check`, `salesforce-bridge-usage`, `salesforce-bridge-org-setup`) and two agents (`salesforce-bridge-setup`, `salesforce-bridge-doctor`) that follow the install and check skills. Each skill is a single self-contained `SKILL.md`: Claude does the steps itself, with no installer and nothing to download.

- **Claude Code:** add the marketplace and install the plugin:

  ```
  /plugin marketplace add Matheus-Bertol/claude-salesforce-bridge
  /plugin install salesforce-bridge@salesforce-bridge
  ```

  Then ask Claude to install or check the Salesforce connector. Claude shows what it will write and asks before saving; the browser sign-in is still done by you in a normal terminal, with the command Claude gives you.
- **claude.ai:** compress one skill folder (for example `skills\salesforce-bridge-install`) into a ZIP and upload it as a skill in the settings. There Claude cannot run commands on your computer, so it guides you through the steps.

The agents only work in Claude Code; on claude.ai only the skills are available.

### Manual setup (without the installer)

Use these steps if you do not want to run the installer. Connectors set up this way use `npx`, and the installer still recognizes them.

1. Install [Node.js LTS](https://nodejs.org) and check it in a terminal: `node -v` and `npx -v`.
2. Sign in once from a terminal before configuring Claude (see [TESTING.md](TESTING.md), section 2). Claude stops a server that takes longer than about 30 seconds to start, which is not enough time to sign in through the browser. The token is saved in `%USERPROFILE%\.mcp-auth` and reused by Claude.
3. Close Claude completely, including the system tray icon. Claude rewrites its config files and may overwrite your changes.
4. Add the server to the config file, replacing `YOUR_SERVER_URL` and `YOUR_CONSUMER_KEY`:

   **Claude Code**: `%USERPROFILE%\.claude.json` (a file in the user folder, not the `%USERPROFILE%\.claude\` folder).

   ```json
   {
     ...
     "mcpServers": {
       "salesforce-conector-sales": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "YOUR_SERVER_URL",
           "8080",
           "--static-oauth-client-info",
           "{\"client_id\":\"YOUR_CONSUMER_KEY\"}",
           "--host",
           "localhost"
         ]
       }
     }
     ...
   }
   ```

   Name the server `salesforce-conector-<name>` (here `sales`) so the installer can find it. `8080` is the callback port and must match the Callback URL.

   Use the top-level `mcpServers` key so the server is available in every folder. A server added under `projects` → `<folder>` → `mcpServers` only loads when Claude Code runs in that folder.

   **Claude Desktop (chat)**: `claude_desktop_config.json`, opened from **Settings → Developer → Edit Config**. For the packaged (MSIX) version (the tested one) it is in `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`; edit that file, because this version ignores `%APPDATA%\Claude\` when it has its own copy. Other installs use `%APPDATA%\Claude\` (not tested). Add the same `mcpServers` entry at the top level.

   A ready-to-copy example is in [`config/claude_desktop_config.example.json`](config/claude_desktop_config.example.json).
5. Open Claude. `salesforce-conector-sales` should be listed under MCP servers (Claude Code) or Settings → Developer (Claude Desktop). If it shows a warning, click **Reconnect**.

`--host localhost` is needed on Windows: by default `mcp-remote` sends `127.0.0.1` as the callback host, which does not match the Callback URL.

Test checklist: [TESTING.md](TESTING.md).

## Troubleshooting

- **`redirect_uri_mismatch`:** the `redirect_uri` sent does not match the Callback URL. Run with `--debug` and look for `redirect_uri=` in the log. If it shows `127.0.0.1`, add `"--host", "localhost"` to `args`.
- **`401 Invalid token`, or `scope parameter not supported` in the `mcp-remote` log:** JWT-based access tokens are not enabled in the External Client App. Enable them, delete `%USERPROFILE%\.mcp-auth` and sign in again.
- **`ERR_SSL_PROTOCOL_ERROR` on `https://localhost:<port>/oauth/callback` after signing in:** the sign-in callback must be `http`, not `https`. Change `https://` to `http://` in the address bar and press Enter (the code is still valid for a few minutes). Then check that the Callback URL in the External Client App starts with `http://`; if it does, the browser forced HTTPS: clear the HSTS rule for `localhost` at `edge://net-internals/#hsts` (or `chrome://net-internals/#hsts`) → "Delete domain security policies".
- **`404 Server definition not found`:** the URL is not the Server URL from Setup → MCP Servers, or the server is not active.
- **Sign-in page never appears when starting from Claude:** sign in from a terminal first (Client-side setup, step 2), then click Reconnect.
- **Browser opens and closes immediately:** expected when you are already signed in to the org. Sign-in succeeded.
- **`Invalid expires_in detected` in the log:** harmless. Salesforce does not return `expires_in`.
- **Port 8080 in use:** usually an old `mcp-remote` process. Find it with `netstat -ano | findstr :8080` and end that `node.exe`. If you change the port, update the Callback URL too.
- **Quotes in the `client_id` JSON break:** copy `config/oauth_client_info.example.json` to `config/oauth_client_info.json`, fill it in, and replace that argument with `"@C:\\path\\to\\config\\oauth_client_info.json"`.
- **Claude cannot find `npx`:** use `"command": "cmd"` and start `args` with `"/c", "npx"`.
- **Stuck sign-in or invalid token:** delete `%USERPROFILE%\.mcp-auth` and restart Claude. To affect only one connection instead, run `powershell -ExecutionPolicy Bypass -File installer\install.ps1 -ClearLogin <name> -Yes`.
- **Logs:** add `"--debug"` to `args`. The log is written to `%USERPROFILE%\.mcp-auth\<hash>_debug.log`.

## Known limitations

- **Tested environment:** Windows only, with Claude Code and the packaged (MSIX) Claude Desktop. See the note at the top.
- **Node.js path:** connectors saved by the installer point to `node.exe` by its full path. If Node.js is moved or reinstalled in another folder, run the installer again and edit (or recreate) the connection.

- **Token renewal:** Salesforce does not return `expires_in`, and `mcp-remote` sends `scope` on refresh, which Salesforce rejects. When the token expires, delete `%USERPROFILE%\.mcp-auth` and sign in again.

## Roadmap

- **Installer:** available as a beta, `installer/install.ps1` (see [Installer (recommended)](#installer-recommended)). It checks or installs Node.js, installs a fixed mcp-remote version locally, shows the live status of each connection, asks for the Server URL and Consumer Key (or takes them from its "adjust here" block), updates `%USERPROFILE%\.claude.json` and every `claude_desktop_config.json`, runs the first sign-in and checks the connection. It also removes connections, clears the saved login of one connection, and has a command-line mode (`-List`, `-Check`, `-Remove`, `-ClearLogin`, `-Json`). Next: a stable release.
- **Other Salesforce MCP servers:** test servers beyond `sobject-reads`, such as record updates, running Flows and calling Agentforce agents.
- **Data dictionary:** context that maps the words users actually use to the org's data model, so Claude picks the right object and field:
  - synonyms, abbreviations and internal terms used by each team, mapped to objects and fields;
  - which fields to use and which to ignore (for example, new field vs. legacy field);
  - what each picklist value means, and relevant business rules;
  - tested queries for common questions.
- **Authentication:**
  - **Token renewal:** keep the session alive without deleting `%USERPROFILE%\.mcp-auth` and signing in again (see Known limitations).
  - **Unattended use:** support automations and integrations with systems other than Claude, using a dedicated integration user, sign-in without a browser and automatic token renewal.

## References

- mcp-remote: https://github.com/geelen/mcp-remote
- Salesforce Hosted MCP Servers, org setup: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/setup-overview.html
- Salesforce Developers blog, Connect Claude with Salesforce Hosted MCP Servers: https://developer.salesforce.com/blogs/2026/05/connect-claude-with-salesforce-hosted-mcp-servers
