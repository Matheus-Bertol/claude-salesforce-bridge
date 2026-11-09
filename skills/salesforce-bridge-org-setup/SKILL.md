---
name: salesforce-bridge-org-setup
description: Guide a Salesforce admin through the org-side setup that lets Claude connect to a Salesforce Hosted MCP server with per-user sign-in - enable the MCP service, activate the MCP server and copy its Server URL, create the External Client App with Callback URL, OAuth scopes, PKCE, JWT-based access tokens and no secret, and get the Consumer Key. Use when the user asks how to set up Salesforce for Claude, how to create the External Client App for MCP, what Callback URL or scopes to use, or where to find the Server URL or Consumer Key.
---
# Salesforce Bridge: org setup (admin guide)

A guide you walk the Salesforce admin through. The admin does every step in Salesforce Setup; you do not change anything in the org and you run no commands. This skill needs nothing besides this text.

What it prepares: users connect Claude (Claude Desktop or Claude Code) to a Salesforce Hosted MCP server through a local `mcp-remote` bridge. Each user signs in with their own Salesforce user (OAuth with PKCE), so Claude only sees what that user is allowed to see. The setup is done once per org. The example server is `sobject-reads` (read-only); for another Hosted MCP server the steps are the same and only the Server URL changes.

## Rules
- Go one step at a time and wait for the admin to confirm each one.
- Only use the steps below. Salesforce screens change; if the admin sees something different or asks about a setting not listed here, say you are not sure and point them to the Salesforce documentation for Hosted MCP Servers. Do not invent settings.
- The app is a **public client with PKCE**: there is no secret to share. Never ask for the Consumer Secret, a password or a token, and tell the admin not to send a secret to users.
- The Consumer Key is not a secret, but do not repeat it back in full (first 4 and last 4 characters).
- Suggest doing it in a sandbox first when the admin has one.

## Before starting
Ask which callback port users will use. The default is `8080`. The Callback URL in Salesforce and the port in each user's Claude config must be the same number, so decide it now and use it everywhere.

## Steps
1. **Setup > User Interface**: enable **Enable MCP Service**.
2. **Setup > MCP Servers**: activate the server, for example `sobject-reads` (servers are inactive by default). Copy its **Server URL** exactly as shown. The URL depends on the org; do not build or edit it by hand.
3. **Setup > External Client App Manager**: create (or edit) the External Client App and set:
   - **Enable OAuth Settings**: on.
   - **Callback URL**: `http://localhost:8080/oauth/callback` (replace `8080` if another port was chosen). Salesforce accepts `http://` only with `localhost` and compares the value exactly, so no `https`, no `127.0.0.1`, no trailing slash.
   - **OAuth scopes**: `Access MCP servers (mcp_api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - **Require Proof Key for Code Exchange (PKCE)**: enabled.
   - **Issue JSON Web Token (JWT)-based access tokens for named users**: enabled. This is required: without it Salesforce issues opaque tokens and the MCP server answers `401 Invalid token`.
   - **Require secret for Web Server Flow**: disabled.
   - **Require secret for Refresh Token Flow**: disabled.
   - **Policies > Permitted Users**: either "Admin approved users are pre-authorized" (then give access through a profile or permission set) or "All users may self-authorize".
4. **Manage Consumer Details**: copy the **Consumer Key**.
5. Wait: changes to the app can take up to 30 minutes to apply.

## Checklist to read back to the admin
- MCP Service enabled; the MCP server is **active**.
- Callback URL is exactly `http://localhost:<port>/oauth/callback`.
- Scopes `mcp_api` and `refresh_token, offline_access`.
- PKCE required; JWT-based access tokens enabled; both "Require secret" options disabled.
- Permitted Users set, and the users who will connect have access (profile or permission set) when pre-authorization is used.

## What to hand to the users
Three values, none of them secret:
- the **Server URL** (step 2);
- the **Consumer Key** (step 4);
- the **callback port** (the number in the Callback URL).

Each user then adds the connector on their own Windows computer (an `mcp-remote` entry in Claude's config with these three values) and signs in with their own Salesforce user in the browser. What Claude can read is that user's access: review profiles, permission sets and sharing as for any other integration that acts as the user.

## If users report errors
- **`401 Invalid token`** or **`scope parameter not supported`** on the first sign-in: "Issue JWT-based access tokens for named users" is not enabled (step 3). Enable it; the user then signs in again from scratch.
- **`redirect_uri_mismatch`**: the Callback URL does not match exactly what the user's computer sends. Check the port, `http://` and `localhost`.
- **`ERR_SSL_PROTOCOL_ERROR` on `https://localhost:...`** after the login: the Callback URL must start with `http://`. If it already does, the user's browser forced HTTPS; changing `https://` to `http://` in the address bar completes the sign-in.
- **`404 Server definition not found`**: the user's URL is not the Server URL from Setup > MCP Servers, or the server is not active.
- **A user cannot sign in or is not authorized**: check Policies > Permitted Users and the user's profile or permission set.
- **It worked and stopped after some time**: known limitation on the user side. The saved login is not renewed automatically; the user signs in again. Nothing to change in the org.
- **Just changed the app and it still fails**: wait up to 30 minutes.
