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
| `dalux_list_projects`, `dalux_get_project` | Projects and project templates, project metadata; `dalux_get_project` adds a `license` summary of the enabled modules (Box/Field tier, restrictions). |
| `dalux_list_project_users` | Users on a project. |
| `dalux_list_tasks`, `dalux_get_task`, `dalux_get_task_changes`, `dalux_list_task_attachments` | Tasks, approvals, safety issues and observations; change feed; attachments. |
| `dalux_list_forms`, `dalux_get_form`, `dalux_list_form_attachments` | Forms and checklists with their answers. |
| `dalux_list_quality_plans` | Inspection and test plans, items, zones, registrations. |
| `dalux_export_quality_plans` | All inspection and test plans of a project with control points, registrations (answered fields, status, author, location) and their photos, as one ZIP archive. Returns a short-lived download link or a local path, not the content. See [Exports](#exports). |
| `dalux_list_work_packages` | Work packages. |
| `dalux_list_file_areas`, `dalux_list_folders`, `dalux_list_files`, `dalux_list_version_sets` | Box structure and file metadata (`includeProperties` adds file properties to file lists). |
| `dalux_download_file` | Content of one file revision (size-capped). |
| `dalux_list_companies` | Companies on a project or in the company catalog. |
| `dalux_list_property_mappings` | Property and metadata fields with their allowed values: file properties for a folder or file (Box), project metadata (for new projects or one project), company catalog metadata. |
| `dalux_upload_file` *(write)* | Upload a new file or a new revision. |
| `dalux_change_company` *(write)* | Create or update a project or catalog company. |
| `dalux_change_project` *(write)* | Create or update a project. |

**Project references.** Dalux addresses projects by an internal `projectId` (a long numeric id from `dalux_list_projects`), not by the project number or name people use. Read tools that take `projectId` also accept the project number or the exact project name (trimmed, case-insensitive) and resolve it to the internal id through the project list, read with one extra request and cached for 60 seconds per client; the result then carries a `resolvedProject` field (id, number, name) showing what matched. A value of 12 or more digits, or one listed in `DALUX_ALLOWED_PROJECT_IDS`, is used unchanged without that request. Ids, numbers and names are matched together: a reference that matches no project, or more than one (for example one project's number and another project's name), returns an error listing up to five candidates (number, name and `projectId`). Similar-project hints need at least three characters, and while `dalux_list_projects` is disabled errors name no projects. With `DALUX_ALLOWED_PROJECT_IDS` set, only allowed projects are considered. Write tools (`dalux_upload_file`, `dalux_change_company`, `dalux_change_project`) accept only an exact id; a number or name is refused with the `projectId` it matches, to retry with. If the project list has more pages than one lookup reads (25), a number or name is not resolved: reads pass the value to Dalux unchanged and writes are refused. If the project list cannot be read, the value is passed to Dalux unchanged. The audit log records the resolved id; a `projectId` that is not an exact id is logged as `projectIdSha256`, and a failed resolution is logged with a fixed message that names no projects.

Observed, not documented by Dalux: the Box endpoints (file areas, folders, files, version sets, download, upload, file property mappings) require Box Pro on the project; on other tiers Dalux answers `403 E40301` ("requires the project to have Box Pro enabled"). Before a Box call the server reads the project modules (one extra request per project, cached for 5 minutes per client) and fails fast when they show a Box tier other than Pro, or a module list without Box. If the modules cannot be read or interpreted, the call goes ahead. `DALUX_LICENSE_PRECHECK=false` turns this check off. Hosts that create a gateway per request start with an empty cache each time.

Not offered by the Dalux Build API (4.15, the latest published version): creating or editing tasks, forms and inspection or test plans, user management, webhooks, and model or geometry queries (model files can be listed and downloaded as files). Dalux FM has a separate API that this server does not cover.

## Quick start

Requires Node.js 22 or later and a Dalux API key ([docs/usage.md](docs/usage.md#1-create-a-dalux-api-identity)).

Install from npm and run the stdio server:

```bash
npx mcp-server-dalux
```

Or build from source:

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
docker run -d --name dalux-mcp -p 127.0.0.1:3000:3000 \
  -e DALUX_API_KEY=<key> \
  -e DALUX_BASE_URL=<base url> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-dalux:latest

claude mcp add --transport http dalux http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, URLs, `MCP_*` booleans, `DALUX_TRUST_FORWARDED_USER` and unknown tool names stop the server at startup. Other `DALUX_*` switches are enabled only by the exact value `true`.

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
| `DALUX_ALLOWED_PROJECT_IDS` | – | Comma-separated project ids; tools taking a `projectId` reject any other and `dalux_list_projects` is filtered. Project numbers and names resolve only to allowed projects. The company catalog, project templates and the account-wide metadata mappings (`dalux_list_property_mappings` with `scope=companyCatalog`, or `scope=project` without `projectId`) are not restricted. |
| `DALUX_ALLOW_PROJECT_CREATE` | `false` | Allow project creation while `DALUX_ALLOWED_PROJECT_IDS` is set. |
| `DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS` | – | Comma-separated domains allowed as `adminEmail` when creating projects. |
| `DALUX_LICENSE_PRECHECK` | `true` | `false` turns off the Box Pro check made before Box calls; Dalux then answers `403 E40301` itself. |
| `DALUX_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, duration, status and the caller passed by an embedding host or forwarded by a trusted gateway (`DALUX_TRUST_FORWARDED_USER`); export finish records add counts and the archive size under `details`. Write tools refuse to run if the log cannot be written. |

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
| `DALUX_TRUST_FORWARDED_USER` | `false` | Record the `X-MCP-User` request header as the caller in the audit log. Only honoured on requests with a valid `MCP_HTTP_TOKEN`; the server refuses to start with this set and no token. Accepts `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). |

### Exports

`dalux_export_quality_plans` writes a ZIP archive and returns where to get it; the archive itself never passes through the conversation.

| Variable | Default | Description |
|---|---|---|
| `DALUX_PUBLIC_BASE_URL` | – | URL clients reach the HTTP server at, e.g. `https://mcp.example.com`. When set, the HTTP transport serves archives at `GET /downloads/<token>/<file>.zip` and the tool returns that link. `https`, or `http` on loopback. |
| `DALUX_EXPORT_DIR` | `<os temp>/mcp-server-dalux-exports` | Where archives are written. Without `DALUX_PUBLIC_BASE_URL` (and in stdio mode) archives stay here and the tool returns the path; they are not deleted automatically. |
| `DALUX_EXPORT_TTL_MINUTES` | `30` | Lifetime of a download link (1 to 1440); the archive is deleted when it expires. |
| `DALUX_EXPORT_ONE_TIME` | `false` | Delete an archive after its first complete download. |
| `DALUX_EXPORT_MAX_TOTAL_BYTES` | `2147483648` (2 GB) | Archive size cap; once reached, the remaining photos are skipped and listed as failures. |
| `DALUX_EXPORT_MAX_FILE_BYTES` | `104857600` (100 MB) | Cap per downloaded file (at most 1 GB). |
| `DALUX_EXPORT_MAX_FILES` | `20000` | Cap on the number of photos and attachments. |
| `DALUX_EXPORT_TIMEOUT_MS` | `900000` (15 min) | Time budget per export; files not downloaded by then are skipped and listed. |
| `DALUX_EXPORT_MAX_CONCURRENT` | `2` | Exports running at the same time per process. |

The archive holds `index.json` (plans → control points → registrations, each with every answered field, status, created/modified time and user, work package, location with building, level, room, drawing name and xyz/gps coordinates, plus coverage counts and a `failures` list), `index.csv` (one row per control point), `registrations.csv` (one row per registration) and `photos/<planCode>/<registrationId>-<n>.<ext>`, where `registrationId` is the Dalux form id and the paths are listed under each registration in `index.json`. Drawing snapshots from the form location are stored as `<registrationId>-location-<n>.<ext>`. Plans are ordered by kind, name and id, control points by number, registrations by creation time. A file or list that cannot be read is recorded in `failures` instead of failing the export.

Download links are capability URLs: the 32-byte random token in the path is the only credential, the MCP bearer token is not required, and anyone holding the link can download the archive until it expires. Only a hash of the token is kept in memory (links do not survive a restart; leftover archives are deleted at startup), unknown or expired tokens and any other path under `/downloads/` get `404`, responses are `Content-Disposition: attachment` and `Cache-Control: no-store`, and logs show a short hash instead of the token. A gateway in front must let `GET /downloads/*` through to the server without its own sign-in, or the link will not work for the user.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured Dalux API identity. Give it the least rights that work: no company access unless needed, and membership only in the user groups of the projects it needs. Rotate the key before it expires.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway (for example OIDC against your identity provider) that decides which users and groups may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Forwarded user identity is opt-in.** With `DALUX_TRUST_FORWARDED_USER=true`, the HTTP transport records the `X-MCP-User` header sent by the gateway as the caller in the audit log, the same field the `./gateway` export fills from `callTool(..., { caller })`. The header is only read on requests that present a valid `MCP_HTTP_TOKEN`, so only a client holding the token (the gateway) can assert an identity; the server refuses to start with the flag set and no token. A repeated header, or a value with a comma, control or non-ASCII characters, or more than 320 characters, is rejected with `400`. Without the flag the header is ignored and not logged. The gateway must strip any `X-MCP-User` header sent by the client and set its own. The identity is used for audit only: every call still runs with the rights of the shared Dalux API identity.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees every project the API identity can see. To separate data, run several instances with different API identities or `DALUX_ALLOWED_PROJECT_IDS`, and route each group to its own instance.
- **Writes are off by default.** When enabled they can be narrowed with the allowlists above, and write tools are annotated as destructive so clients can ask for confirmation.
- **Dalux content is untrusted input.** Task texts, form answers, file names and file contents are written by project participants. Tool results label them as data; clients that combine this server with other tools should treat them accordingly.
- **The API key stays on the API origin.** The key is never sent to another origin (redirects are handled manually), pagination links are only followed on the configured base URL and resource, and error messages are redacted.
- **Export links are bearer capabilities.** `dalux_export_quality_plans` returns a link that works without authentication until it expires (`DALUX_EXPORT_TTL_MINUTES`, optionally one-time). It reaches the language model and the conversation like any tool result. Disable the tool with `DALUX_DISABLED_TOOLS` where that is not acceptable.
- **Personal data.** Project users, assignees and attachments contain personal data, which reaches the language model your client uses. Disable `dalux_list_project_users` with `DALUX_DISABLED_TOOLS` if you do not need it.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Pagination

Dalux lists use opaque continuation links. List tools return `items`, `pagesFetched`, `nextPage`, `endOfIncrementalStream`, and `totalItems`/`totalRemainingItems` when Dalux provides them. Pass `nextPage` back as `pageLink` to continue. For incremental lists (files, forms, form attachments, version-set files), `endOfIncrementalStream: true` means you have caught up; keep the link and call it later to receive only changes.

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createDaluxGateway, daluxToolCatalog } from 'mcp-server-dalux/gateway';

const gateway = createDaluxGateway({ apiKey: tenant.apiKey, baseUrl: tenant.baseUrl });
const result = await gateway.callTool('list_projects', {}, { caller: 'user@example.com' });
```

- **Explicit credentials.** `apiKey` and `baseUrl` (the customer-specific API base URL) are required; a missing value throws when the gateway is created. A gateway never reads `DALUX_API_KEY` or `DALUX_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per API identity. Each instance redacts error text, tool results and audit records with its own key only; no key is kept in a process-wide registry, and a dropped instance releases its key.
- **Shared instance policy.** `DALUX_ENABLE_WRITES`, `DALUX_DISABLED_TOOLS`, `DALUX_ALLOWED_PROJECT_IDS`, `DALUX_AUDIT_LOG` and the limits are read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Exports.** `export_quality_plans` writes its archive to `DALUX_EXPORT_DIR` and, by default, returns the local `path` (`delivery: 'file'`). Pass `exportDelivery` to `createDaluxGateway` to hand the archive over yourself: the hook receives `{ path, fileName, sizeBytes, contentType }`, owns the file from then on (move, upload or delete it), and whatever it returns (for example `{ delivery: 'host', url }`) is merged into the tool result.
- **Tool catalog.** `daluxToolCatalog` is a frozen list of every tool: `name` (without the `dalux_` prefix), `title`, `description`, `riskLevel` (`read` or `write`), `enabledByDefault`, `inputSchema` (JSON Schema) and `upstream`, the Dalux API requests the tool may make (`access`, `method` and versioned path template, including the Box Pro pre-check). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `daluxGatewayTools` holds the same definitions without `upstream`; `gateway.tools` lists those enabled on the instance.

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
