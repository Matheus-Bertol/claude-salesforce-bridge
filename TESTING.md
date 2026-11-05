# Test checklist

Run the steps in order. If a step fails, stop and check Troubleshooting in the [README](README.md).

## 1. Prerequisites (terminal)
```bash
node -v
npx -v
```
- [ ] Node.js 18 or later is installed.

## 2. Sign in from the terminal
Run `mcp-remote` on its own to check the sign-in before involving Claude.

Get the Server URL from Salesforce: **Setup → MCP Servers → `sobject-reads`**, field **Server URL**. Copy it exactly as shown.

Replace `YOUR_SERVER_URL` with that URL and `YOUR_CONSUMER_KEY` with the External Client App's Consumer Key:
```bash
npx -y mcp-remote "YOUR_SERVER_URL" 8080 --static-oauth-client-info "{\"client_id\":\"YOUR_CONSUMER_KEY\"}" --host localhost --debug
```
- [ ] The browser opens the Salesforce sign-in page for the org.
- [ ] After signing in, the terminal shows the connection with no 401 or 403 errors.
- [ ] The `%USERPROFILE%\.mcp-auth` folder was created.
- Stop it with `Ctrl+C`.

Common errors:
- `redirect_uri_mismatch`: the Callback URL in the External Client App does not match the `redirect_uri` sent. Look for `redirect_uri=` in the `--debug` log. It must be `http://localhost:<port>/oauth/callback`; if it shows `127.0.0.1`, `--host localhost` is missing.
- `invalid_client`, or a secret is requested: the app requires a Consumer Secret. Disable **Require secret for Web Server Flow** and **Require secret for Refresh Token Flow**.
- `OAUTH_APPROVAL_ERROR`, or user not approved: the user has no access under the app's Policies.
- `404` or `Server definition not found`: the URL is not the Server URL from Setup → MCP Servers, the MCP Service is disabled, or `sobject-reads` is not active.

## 3. Connector in Claude
- [ ] The config is added and Claude was fully restarted.
- [ ] **Claude Desktop (chat):** Settings → Developer shows `conector-salesforce` as **running**, and it appears in the chat's tools menu.
- [ ] **Claude Code:** the MCP servers list shows `conector-salesforce` with no warning. If there is one, click **Reconnect**.

## 4. Quick connector test
Paste this into Claude (chat or Claude Code):

```text
Test the conector-salesforce connector. Use only its tools and do not make up data:
1. Who am I in Salesforce? (name, username, profile)
2. List the org's custom objects (API name and label).
3. How many accounts (Account) are in the org?
At the end, list the tools you used and whether any of them failed.
```

- [ ] Claude asks permission to use the `conector-salesforce` tools. Allow it.
- [ ] It returns **your** user (`getUserInfo`).
- [ ] It lists the custom objects (`soqlQuery` or `getObjectSchema`). The list can be empty if the org has none.
- [ ] It returns the account count (`soqlQuery`).
- [ ] If it answers without calling a tool, or says the connector is unavailable, go back to step 3.

## 5. Individual questions
- [ ] "Who am I in Salesforce?" returns your org user (`getUserInfo`).
- [ ] "Which fields does the Account object have?" uses `getObjectSchema`.
- [ ] "How many accounts were created in the last 30 days?" uses `soqlQuery`.
- [ ] "Find accounts named X" uses `find`.

## 6. Read-only
- [ ] Ask: "Create an account named MCP Test". Claude should say it has no tool for that. Confirm in the org that nothing was created.

## 7. Per-user permissions
- [ ] Repeat steps 2 to 5 with a user that has a more restricted profile. Delete `%USERPROFILE%\.mcp-auth` first to switch users.
- [ ] That user should see fewer objects or records than yours.

## 8. Revocation
- [ ] Remove the test user from the app's Policies, or revoke access in Setup → Connected Apps OAuth Usage.
- [ ] A new question in Claude should fail with an authorization error.
