# mssql-mcp

A read-only MCP server for Microsoft SQL Server. It lets an MCP client run
`SELECT` queries against a database and inspect how those queries perform.

It provides two main capabilities:

1. Run `SELECT` queries and return the rows as JSON.
2. Analyze a `SELECT` under `SET STATISTICS XML/IO/TIME` and return performance
   data as JSON: estimated vs. actual rows, logical and physical reads,
   statement timing, missing-index suggestions, and plan warnings.

> For a local Docker/Colima setup, see `local-readme.md`. This document covers a
> Windows machine connecting to a remote SQL Server.

## Tools

| Tool | Description |
|------|-------------|
| `query` | Run a single `SELECT` and return the rows as JSON. |
| `analyze_query` | Run a `SELECT` with statistics collection enabled and return performance metrics. |
| `list_tables` | List tables and views in the current database. |
| `describe_table` | Column names, types, nullability, and defaults for a table. |

By default only `SELECT` and `WITH` statements are permitted. See
[Security](#security).

## Requirements

- Node.js 18 or later. Install the LTS build from <https://nodejs.org> and
  confirm with `node -v`.
- Network access from this machine to the SQL Server. The default port is TCP
  1433; make sure any firewall between the two allows it.
- A SQL Server Authentication login (username and password) with read access to
  the target database.

## Setup

Open PowerShell in the project folder and run:

```powershell
cd C:\Tools\mssql-mcp
copy .env.example .env
npm install
npm run build
```

Then edit `.env` with the details for your server (see the next section).

## Connecting to a remote server

`.env` holds the connection settings. It is git-ignored and is the only place
credentials are stored.

```
MSSQL_SERVER=sqlserver.corp.example.com
MSSQL_PORT=1433
MSSQL_USER=reporting_user
MSSQL_PASSWORD=your-password
MSSQL_DATABASE=Sales
MSSQL_ENCRYPT=true
MSSQL_TRUST_SERVER_CERT=false
```

- `MSSQL_SERVER` can be a hostname, fully qualified domain name, or IP address.
  For a named instance, use `HOST\INSTANCE` and set `MSSQL_PORT` to that
  instance's port.
- `MSSQL_ENCRYPT=true` encrypts the connection. Keep it on for a remote server.
- `MSSQL_TRUST_SERVER_CERT=false` requires the server to present a certificate
  your machine already trusts. Set it to `true` only when the server uses a
  self-signed certificate.
- To point at a different server or database later, edit `.env` and restart the
  client.

Verify the connection before wiring up a client:

```powershell
node dist\index.js
```

It prints a readiness line to standard error and then waits for input. Press
Ctrl+C to stop. If the connection fails, the error message states the reason.

## Registering with a client

The client starts the server as a subprocess and communicates over standard
input/output. Credentials stay in `.env`; the client configuration holds no
secrets.

opencode (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mssql": {
      "type": "local",
      "command": ["node", "C:\\Tools\\mssql-mcp\\dist\\index.js"],
      "enabled": true
    }
  }
}
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["C:\\Tools\\mssql-mcp\\dist\\index.js"]
    }
  }
}
```

Use the full path to `dist\index.js`, and double the backslashes in JSON. Start
the client from the folder that contains its configuration file. Any `env`
values set in the client configuration take precedence over `.env`.

## analyze_query output

```jsonc
{
  "row_count": 100,
  "truncated": false,
  "rows": [ /* result rows, capped at maxRows */ ],
  "timing": { "cpu_ms": 53, "elapsed_ms": 53 },
  "io_by_table": [
    { "table": "Orders", "scan_count": 1, "logical_reads": 283,
      "physical_reads": 0, "read_ahead_reads": 0 }
  ],
  "statement": { "est_rows": 100, "subtree_cost": 0.30 },
  "operators": [
    { "node_id": 0, "parent_node_id": null, "depth": 0,
      "physical_op": "Sort", "cost_pct": 100 },
    { "node_id": 1, "parent_node_id": 0, "depth": 1,
      "physical_op": "Clustered Index Scan",
      "est_rows": 100, "actual_rows": 100, "rows_read": 50000,
      "actual_logical_reads": 283, "cost_pct": 88 }
  ],
  "missing_indexes": [
    { "impact_pct": 94.6, "table": "dbo.Orders",
      "create": "CREATE INDEX IX_Orders_CustomerId ON [dbo].[Orders] ([CustomerId]) INCLUDE ([Amount]);" }
  ],
  "warnings": []
}
```

Reads and timing come from the plan's runtime counters (`ActualLogicalReads`,
`QueryTimeStats`). `io_by_table` is parsed from the `STATISTICS IO` messages, so
it matches the Messages tab in SQL Server Management Studio.

Operators are returned in tree order. Each carries `node_id`, `parent_node_id`,
and `depth`. The root (`node_id` 0) is the final step and runs last; the deepest
leaf runs first and feeds its parent up toward the root.

## Logging

Set `MSSQL_LOG=true` in `.env` to append a record of every tool call, including
the arguments received and the result returned, to `mssql-mcp\mcp.log`. The file
is git-ignored.

```
[2026-07-05T15:06:26Z]  CALL #2  query
INPUT (from client):
  { "sql": "SELECT TOP 2 name FROM sys.tables ORDER BY name" }
[2026-07-05T15:06:27Z]  DONE #2  query  ·  1002 ms
OUTPUT (to client):
  { "row_count": 2, "rows": [ { "name": "Orders" } ] }
```

Each call is numbered so a request and its response can be matched even when
calls overlap. Set `MSSQL_LOG_FILE` for a custom path and `MSSQL_LOG_MAX` for the
maximum characters per entry before truncation (default 20000).

To follow the log live in PowerShell:

```powershell
Get-Content .\mcp.log -Wait
```

## Rate limiting

Two limits guard against overloading the server, both configured in `.env`:

- `MSSQL_RATE_MAX` requests per `MSSQL_RATE_WINDOW_MS` milliseconds.
- `MSSQL_MAX_CONCURRENT` queries in flight at once.

Set any of them to `0` to disable that limit. When a limit is reached, the tool
returns an error with a retry hint and does not contact the database.

## Security

`MSSQL_READONLY=true` (the default) rejects anything that is not a single
`SELECT` or `WITH` statement and blocks write and DDL keywords. This is a
convenience check, not a replacement for database permissions.

Enforce read-only access at the server by connecting with a login that has read
rights only:

```sql
CREATE LOGIN reporting_user WITH PASSWORD = 'your-password';
CREATE USER reporting_user FOR LOGIN reporting_user;
ALTER ROLE db_datareader ADD MEMBER reporting_user;
```

Point `MSSQL_USER` and `MSSQL_PASSWORD` at that login. Set `MSSQL_READONLY=false`
only when you intend to allow writes.
