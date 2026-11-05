# Claude Salesforce Bridge

Connects Claude Desktop and Claude Code to a Salesforce Hosted MCP server using [`mcp-remote`](https://github.com/geelen/mcp-remote) running locally. Each user signs in with their own Salesforce account (OAuth with PKCE), so Claude only sees the data that user is allowed to see.

This guide sets up the `sobject-reads` server (read-only). The same steps work for other Salesforce Hosted MCP servers; only the Server URL changes.

> The configuration targets Claude. Other MCP clients that run local servers can use the same setup with their own config file.

```
Claude ──stdio──> mcp-remote (local) ──HTTPS/OAuth──> Salesforce Hosted MCP server
```

## Salesforce-side setup

Done once by a Salesforce admin.

1. **Setup → User Interface**: enable **Enable MCP Service**.
2. **Setup → MCP Servers**: activate `sobject-reads` (servers are inactive by default). Copy its **Server URL** exactly as shown. The URL depends on the org, so do not build it by hand.
3. **Setup → External Client App Manager**: create or edit the External Client App.
   - Enable OAuth Settings.
   - **Callback URL:** `http://localhost:8080/oauth/callback`. Salesforce only accepts `http://` with `localhost` and compares the value exactly. If you change the port in the client config, use the same port here.
   - **OAuth scopes:** `Access MCP servers (mcp_api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - **Require Proof Key for Code Exchange (PKCE)**: enabled.
   - **Issue JSON Web Token (JWT)-based access tokens for named users**: enabled. This is required. Without it Salesforce issues opaque tokens (starting with `00D`) and the MCP server returns `401 Invalid token`.
   - **Require secret for Web Server Flow** and **Require secret for Refresh Token Flow**: disabled. The app is a public client with PKCE, so no secret is shared with users.
   - **Policies → Permitted Users:** "Admin approved users are pre-authorized" (then grant access through a profile or permission set) or "All users may self-authorize".
4. **Manage Consumer Details**: copy the **Consumer Key**. Changes to the app can take up to 30 minutes to apply.

## Client-side setup

Done on each user's machine.

1. Install [Node.js LTS](https://nodejs.org) and check it in a terminal: `node -v` and `npx -v`.
2. Sign in once from a terminal before configuring Claude (see [TESTING.md](TESTING.md), section 2). Claude stops a server that takes longer than about 30 seconds to start, which is not enough time to sign in through the browser. The token is saved in `%USERPROFILE%\.mcp-auth` and reused by Claude.
3. Close Claude completely, including the system tray icon. Claude rewrites its config files and may overwrite your changes.
4. Add the server to the config file, replacing `YOUR_SERVER_URL` and `YOUR_CONSUMER_KEY`:

   **Claude Code**: `%USERPROFILE%\.claude.json` (a file in the user folder, not the `%USERPROFILE%\.claude\` folder).

   ```json
   {
     ...
     "mcpServers": {
       "conector-salesforce": {
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

   Use the top-level `mcpServers` key so the server is available in every folder. A server added under `projects` → `<folder>` → `mcpServers` only loads when Claude Code runs in that folder.

   **Claude Desktop (chat)**: `claude_desktop_config.json`, opened from **Settings → Developer → Edit Config**. It is in `%APPDATA%\Claude\`, or in `%LOCALAPPDATA%\Claude-Data\claude_<id>\` for the Microsoft Store version. Add the same `mcpServers` entry at the top level.

   A ready-to-copy example is in [`config/claude_desktop_config.example.json`](config/claude_desktop_config.example.json).
5. Open Claude. `conector-salesforce` should be listed under MCP servers (Claude Code) or Settings → Developer (Claude Desktop). If it shows a warning, click **Reconnect**.

`--host localhost` is needed on Windows: by default `mcp-remote` sends `127.0.0.1` as the callback host, which does not match the Callback URL.

Test checklist: [TESTING.md](TESTING.md).

## Troubleshooting

- **`redirect_uri_mismatch`:** the `redirect_uri` sent does not match the Callback URL. Run with `--debug` and look for `redirect_uri=` in the log. If it shows `127.0.0.1`, add `"--host", "localhost"` to `args`.
- **`401 Invalid token`, or `scope parameter not supported` in the `mcp-remote` log:** JWT-based access tokens are not enabled in the External Client App. Enable them, delete `%USERPROFILE%\.mcp-auth` and sign in again.
- **`404 Server definition not found`:** the URL is not the Server URL from Setup → MCP Servers, or the server is not active.
- **Sign-in page never appears when starting from Claude:** sign in from a terminal first (Client-side setup, step 2), then click Reconnect.
- **Browser opens and closes immediately:** expected when you are already signed in to the org. Sign-in succeeded.
- **`Invalid expires_in detected` in the log:** harmless. Salesforce does not return `expires_in`.
- **Port 8080 in use:** usually an old `mcp-remote` process. Find it with `netstat -ano | findstr :8080` and end that `node.exe`. If you change the port, update the Callback URL too.
- **Quotes in the `client_id` JSON break:** copy `config/oauth_client_info.example.json` to `config/oauth_client_info.json`, fill it in, and replace that argument with `"@C:\\path\\to\\config\\oauth_client_info.json"`.
- **Claude cannot find `npx`:** use `"command": "cmd"` and start `args` with `"/c", "npx"`.
- **Stuck sign-in or invalid token:** delete `%USERPROFILE%\.mcp-auth` and restart Claude.
- **Logs:** add `"--debug"` to `args`. The log is written to `%USERPROFILE%\.mcp-auth\<hash>_debug.log`.

## Known limitations

- **Token renewal:** Salesforce does not return `expires_in`, and `mcp-remote` sends `scope` on refresh, which Salesforce rejects. When the token expires, delete `%USERPROFILE%\.mcp-auth` and sign in again.

## Roadmap

- **Installer:** an executable that configures Claude for the user. It checks Node.js, asks for the Server URL and Consumer Key, backs up and updates `%USERPROFILE%\.claude.json` and `claude_desktop_config.json`, runs the first sign-in and checks the connection.
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
