---
name: salesforce-bridge-usage
description: Use the Salesforce connector tools (salesforce-conector-* MCP server, Salesforce Hosted MCP sobject-reads) correctly and safely - pick the right tool for a question, check the schema before querying, write SOQL with LIMIT, respect sandbox versus production and personal data. Use when the user asks about Salesforce data such as accounts, contacts, opportunities, cases, leads, records, fields, reports of counts or totals, who am I in Salesforce, or asks to search or query Salesforce.
---
# Salesforce Bridge: using the connector

How to answer questions about Salesforce data through a `salesforce-conector-<name>` MCP server. That server is the Salesforce Hosted MCP server `sobject-reads`: **read-only**, and it runs as the signed-in user, so it only returns what that user is allowed to see. This skill needs nothing besides this text.

## Which tool
| The user wants | Tool |
|---|---|
| "Who am I?", which user is connected (name, role, profile, manager, time zone, preferences set by the admin), check the connection | `getUserInfo` |
| Which objects exist (call it with no object first to get the index), then which fields an object has, API names, field types, relationships | `getObjectSchema` |
| Records by known criteria, lists, counts, sums, sorted or filtered data | `soqlQuery` (SOQL) |
| A name or text that may be in several objects ("find everything about Acme") | `find` (SOSL, for example `FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name)`) |
| "My accounts", "that case I was looking at": records of one object the user recently viewed or changed | `listRecentSobjectRecords` |
| Child or related records when you already have the parent record Id (contacts of an account, cases of a contact); needs the parent object, the Id and the relationship name | `getRelatedRecords` |

The exact parameters are in each tool's own description in the session: follow them, do not guess parameter names. If a tool listed here is not available, the org exposes a different set; use what is there and say so.

## Routine for a data question
1. **Know where you are.** If several `salesforce-conector-*` servers are connected, ask which one (or use the one the user named). On the first Salesforce question of a conversation, call `getUserInfo` and tell the user which Salesforce user answered.
2. **Check the schema first.** Before the first query on an object, call `getObjectSchema` for it. Orgs have custom objects and fields (`__c`), renamed labels and their own picklist values; a field the user calls "region" may have any API name. Never invent an object or field name. If two fields could match, ask the user which one.
3. **Query narrowly.** Select only the fields needed, always filter in `WHERE` (on large objects prefer Id, Name or lookup fields), sort with `ORDER BY`, and always end with `LIMIT`.
4. **Answer from the results only.** Say how many rows came back and whether the `LIMIT` may have cut the list. Do not fill gaps with assumptions; an empty result may also mean the user has no access to those records.

## Safety rules
- **Sandbox versus production.** `getUserInfo` does not say which org this is. Use the connection name or what the user told you; if it is not clear, ask. Treat it as production unless you know otherwise, and tell the user when an answer comes from a sandbox (the data may be old or fake).
- **Always `LIMIT`.** Default to 50 rows or fewer; go higher only when the user asks, and prefer a count or a sum over listing rows. For "how many", use `COUNT()`, not a list.
- **No bulk dumps of personal data.** Do not export whole tables of people (contacts, leads, users, person accounts) with emails, phones, addresses or documents. Ask what the user needs it for and return the smallest set of fields and rows that answers it. Do not copy personal data into files or other tools unless the user asks for that.
- **Read-only by default.** `sobject-reads` cannot change data. If another connected server can create, update or delete records, run Flows or call agents, do nothing that writes before you show the user exactly what will change (object, record, field, old value, new value) and get a clear yes for that change. One confirmation covers one change, not later ones. In production, say that it is production when you ask.
- **Stay in the user's access.** Do not try to get around a permission error; report it. Access is decided by the Salesforce admin.
- **Secrets.** Never ask for passwords, tokens or a Consumer Secret, and never read or print the files in `%USERPROFILE%\.mcp-auth`.

## SOQL quick reference
- No `SELECT *`: list the fields. Text values use single quotes; dates and numbers do not.
- Date literals: `TODAY`, `YESTERDAY`, `THIS_MONTH`, `LAST_MONTH`, `THIS_QUARTER`, `THIS_YEAR`, `LAST_N_DAYS:30`.
- Parent fields with a dot (`Account.Name`); child records with a subquery.
- `LIKE` with `%` for partial text. `find` is better when you do not know which object or field holds the text.

Examples with standard objects (check the schema first: an org may have changed or hidden these fields):
```sql
-- Accounts by name
SELECT Id, Name, Industry, Type FROM Account WHERE Name LIKE 'Acme%' ORDER BY Name LIMIT 20

-- Open opportunities closing this quarter, biggest first
SELECT Id, Name, StageName, Amount, CloseDate, Account.Name
FROM Opportunity
WHERE IsClosed = false AND CloseDate = THIS_QUARTER
ORDER BY Amount DESC NULLS LAST LIMIT 25

-- How many open cases per priority
SELECT Priority, COUNT(Id) total FROM Case WHERE IsClosed = false GROUP BY Priority

-- Won amount this year
SELECT SUM(Amount) total FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_YEAR

-- An account with its contacts (few fields, limited)
SELECT Id, Name, (SELECT Id, Name, Title FROM Contacts LIMIT 20) FROM Account WHERE Id = '001XXXXXXXXXXXXXXX'

-- Records created in the last 7 days
SELECT Id, Name, Company, Status, CreatedDate FROM Lead WHERE CreatedDate = LAST_N_DAYS:7 ORDER BY CreatedDate DESC LIMIT 50
```
On a query error (`No such column`, `sObject type ... is not supported`, malformed query): read the message, check the schema again, fix the query once or twice. If it still fails, show the user the error instead of trying variations.

## When the connector fails
- **Tools missing**: the connector is not loaded in this session. Ask the user to check that `salesforce-conector-<name>` is listed under MCP servers (Claude Code) or Settings > Developer (Claude Desktop), click Reconnect, or restart Claude.
- **401, `invalid token`, `scope parameter not supported`, or it worked earlier and now every call fails**: the Salesforce login expired. It is not renewed automatically, so the user signs in again:
  1. Click Reconnect on the connector (or restart Claude). If the Salesforce login opens in the browser and completes, try again.
  2. If that is not enough, the saved login of this connection must be cleared. Its files are in `%USERPROFILE%\.mcp-auth\mcp-remote-*` and their names start with the MD5 hash of the Server URL (used only as a file name, not for security). With the user's OK and Claude closed, move only those files to a `backup-<date>` folder inside `.mcp-auth`; nothing is deleted. If the `salesforce-bridge-check` skill is available, use its "clear the login of one connection" steps. Last resort only, after telling the user it signs out every `mcp-remote` connection on the computer: rename the whole `.mcp-auth` folder to `.mcp-auth.bak-<date>`.
  3. They sign in from a normal Command Prompt, because Claude does not wait long enough for a browser login. The values are the ones in the connector's entry in Claude's config (Server URL, port, Consumer Key; there is no secret):
     `npx -y mcp-remote <SERVER_URL> <PORT> --static-oauth-client-info "{\"client_id\":\"<CONSUMER_KEY>\"}" --host localhost`
     After the browser sign-in and the terminal connecting, Ctrl+C, then open Claude and Reconnect.
  4. Confirm with `getUserInfo`.
- **404 / `Server definition not found`, `redirect_uri_mismatch`, port in use**: a configuration problem, not a data problem. Tell the user the exact error. If the `salesforce-bridge-check` skill is available it covers these in detail; otherwise the user checks with their Salesforce admin that the Server URL is the active server's URL and that the app's Callback URL is exactly `http://localhost:<port>/oauth/callback`.
- **Permission or "insufficient access" errors on one object**: the connection is fine; the user lacks access to that data. Report it; do not retry with other objects to work around it.
