# mcp-server-dalux

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Dalux Build API](https://app.swaggerhub.com/apis-docs/Dalux/DaluxBuild-api/4.15). It lets an MCP client (Claude or any other MCP-capable assistant) read Dalux **Field** data (tasks, safety issues, forms, inspection and test plans) and Dalux **Box** documents (file areas, folders, files, version sets), and optionally perform the few write operations the API offers.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Dalux.

- Read-only by default; writes are opt-in per instance.
- One Dalux API identity per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.

[docs/usage.md](docs/usage.md) covers setting up the Dalux API identity, connecting clients, and typical workflows.

## Tools

| Tool | Purpose |
|---|---|
| `dalux_search_capabilities` | Find the right tool for a question; does not call Dalux. |
| `dalux_list_projects`, `dalux_get_project` | Projects and project templates, project metadata. |
| `dalux_list_project_users` | Users on a project. |
| `dalux_list_tasks`, `dalux_get_task`, `dalux_get_task_changes`, `dalux_list_task_attachments` | Tasks, approvals, safety issues and observations; change feed; attachments. |
| `dalux_list_forms`, `dalux_get_form`, `dalux_list_form_attachments` | Forms and checklists with their answers. |
| `dalux_list_quality_plans` | Inspection and test plans, items, zones, registrations. |
| `dalux_list_work_packages` | Work packages. |
| `dalux_list_file_areas`, `dalux_list_folders`, `dalux_list_files`, `dalux_list_version_sets` | Box structure and file metadata. |
| `dalux_download_file` | Content of one file revision (size-capped). |
| `dalux_list_companies` | Companies on a project or in the company catalog. |
| `dalux_upload_file` *(write)* | Upload a new file or a new revision. |
| `dalux_change_company` *(write)* | Create or update a project or catalog company. |
| `dalux_change_project` *(write)* | Create or update a project. |

Observed, not documented by Dalux: the Box endpoints (file areas, folders, files, version sets, download, upload) require Box Pro on the project; on other tiers Dalux answers `403 E40301` ("requires the project to have Box Pro enabled").

Not offered by the Dalux Build API (4.15, the latest published version): creating or editing tasks, forms and inspection or test plans, user management, webhooks, and model or geometry queries (model files can be listed and downloaded as files). Dalux FM has a separate API that this server does not cover.

## Quick start

Requires Node.js 22 or later and a Dalux API key ([docs/usage.md](docs/usage.md#1-create-a-dalux-api-identity)).

```bash
git clone https://github.com/borgels/mcp-server-dalux.git
cd mcp-server-dalux
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add dalux \
  --env DALUX_API_KEY=<key> --env DALUX_BASE_URL=<base url> \
  -- node /path/to/mcp-server-dalux/dist/transports/stdio.js
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "dalux": {
      "command": "node",
      "args": ["/path/to/mcp-server-dalux/dist/transports/stdio.js"],
      "env": {
        "DALUX_API_KEY": "<key>",
        "DALUX_BASE_URL": "<base url>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-dalux`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run --rm -p 127.0.0.1:3000:3000 \
  -e DALUX_API_KEY=<key> \
  -e DALUX_BASE_URL=<base url> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-dalux:latest

claude mcp add --transport http dalux http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, URLs, `MCP_*` booleans and unknown tool names stop the server at startup. `DALUX_*` switches are enabled only by the exact value `true`.

### Dalux API

| Variable | Default | Description |
|---|---|---|
| `DALUX_API_KEY` | – | **Required.** Key of the Dalux API identity. |
| `DALUX_BASE_URL` | `https://field.dalux.com/service/api` | Customer-specific base URL (Dalux: company settings → API identities → copy API base URL), e.g. `https://node1.field.dalux.com/service/api`. Must be `https` on a `*.dalux.com` host. |
| `DALUX_ALLOW_CUSTOM_BASE_URL` | `false` | Allow an `https` base URL outside `*.dalux.com`. |
| `DALUX_TIMEOUT_MS` | `30000` | Timeout per request. |
| `DALUX_MAX_CONCURRENCY` | `4` | Maximum concurrent requests to Dalux. |
| `DALUX_MAX_DOWNLOAD_BYTES` | `26214400` (25 MB) | Upper bound for `dalux_download_file` (at most 100 MB); the per-call default is 10 MB. |

### Access control

| Variable | Default | Description |
|---|---|---|
| `DALUX_ENABLE_WRITES` | `false` | Enable the three write tools. |
| `DALUX_DISABLED_TOOLS` | – | Comma-separated tool names to disable, e.g. `dalux_list_project_users`. |
| `DALUX_ALLOWED_PROJECT_IDS` | – | Comma-separated project ids; tools taking a `projectId` reject any other and `dalux_list_projects` is filtered. The company catalog and project templates are not restricted. |
| `DALUX_ALLOW_PROJECT_CREATE` | `false` | Allow project creation while `DALUX_ALLOWED_PROJECT_IDS` is set. |
| `DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS` | – | Comma-separated domains allowed as `adminEmail` when creating projects. |
| `DALUX_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Security model

- **One shared identity.** Every caller acts with the rights of the configured Dalux API identity. Give it the least rights that work: no company access unless needed, and membership only in the user groups of the projects it needs. Rotate the key before it expires.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway (for example OIDC against your identity provider) that decides which users and groups may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees every project the API identity can see. To separate data, run several instances with different API identities or `DALUX_ALLOWED_PROJECT_IDS`, and route each group to its own instance.
- **Writes are off by default.** When enabled they can be narrowed with the allowlists above, and write tools are annotated as destructive so clients can ask for confirmation.
- **Dalux content is untrusted input.** Task texts, form answers, file names and file contents are written by project participants. Tool results label them as data; clients that combine this server with other tools should treat them accordingly.
- **The API key stays on the API origin.** The key is never sent to another origin (redirects are handled manually), pagination links are only followed on the configured base URL and resource, and error messages are redacted.
- **Personal data.** Project users, assignees and attachments contain personal data, which reaches the language model your client uses. Disable `dalux_list_project_users` with `DALUX_DISABLED_TOOLS` if you do not need it.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Pagination

Dalux lists use opaque continuation links. List tools return `items`, `pagesFetched`, `nextPage`, `endOfIncrementalStream`, and `totalItems`/`totalRemainingItems` when Dalux provides them. Pass `nextPage` back as `pageLink` to continue. For incremental lists (files, forms, form attachments, version-set files), `endOfIncrementalStream: true` means you have caught up; keep the link and call it later to receive only changes.

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
DALUX_API_KEY=<key> DALUX_BASE_URL=<base url> npm run smoke:live   # read-only check against a real tenant
```

## License

Apache-2.0
