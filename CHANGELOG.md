# Changelog

## Unreleased

- New read tool `dalux_export_quality_plans`: exports the inspection and
  test plans of a project (optionally filtered by kind, plan and change
  date) as one ZIP archive with `index.json` (plans, control points,
  registrations with every answered field, status, author, location,
  coverage counts and a list of partial failures), `index.csv`,
  `registrations.csv` and the registration photos and attachments under
  `photos/<planCode>/<registrationId>-<n>.<ext>` (extensions from an
  allowlist, otherwise `.bin`). Downloads run through the client's
  concurrency limit and are capped per file, in bytes in flight, in
  number, in total archive size (index included) and in time, listing
  included (`DALUX_EXPORT_*`). Archives held on disk are capped by
  `DALUX_EXPORT_MAX_STORED_BYTES` and `DALUX_EXPORT_MAX_STORED_ENTRIES`,
  and an export is refused when they or the free disk space run out. With
  `DALUX_PUBLIC_BASE_URL` (an origin) set, the HTTP transport serves the
  archive at `GET /downloads/<token>/<file>.zip` (random 32-byte capability
  token, no bearer token, `DALUX_EXPORT_TTL_MINUTES` lifetime, optional
  one-time links, deleted on expiry) and the tool returns that link. stdio
  returns a local path; HTTP without a public URL and gateways without an
  `exportDelivery` hook refuse the tool unless `DALUX_EXPORT_DELIVERY=file`
  is set. Each process works in its own subdirectory of
  `DALUX_EXPORT_DIR`, which must not be a symlink, must belong to the
  server user and must not be group- or world-writable. Audit finish
  records of the export carry counts and the archive size; download tokens
  are never logged.
- Internal project ids made of one uppercase letter and at least 15
  digits are recognised like numeric ids and used without a project list
  lookup. Project numbers such as `S2024` or `S-1234` are still resolved.
- Audit records may carry a `details` object with tool-supplied figures.

- MCP tool calls return every error as a tool error redacted with the
  instance's own redactor, including errors a handler throws without going
  through the Dalux client.
- Read tools that take `projectId` also accept the project number or the
  exact project name and resolve it to the internal project id through the
  project list (cached for 60 seconds per client instance); results then
  carry `resolvedProject`. Ids of 12 or more digits and ids in
  `DALUX_ALLOWED_PROJECT_IDS` are used unchanged without an extra request.
  Ids, numbers and names are matched together; an unknown or ambiguous
  reference returns an error listing up to five candidate projects (none
  while `dalux_list_projects` is disabled; similar-project hints need three
  characters). With `DALUX_ALLOWED_PROJECT_IDS` set, only allowed projects
  are considered. Write tools accept only an exact id and refuse a number
  or name with the `projectId` it matches. When the project list is longer
  than one lookup reads, numbers and names are not resolved (reads pass the
  value through, writes are refused). Audit records carry the resolved id;
  a `projectId` that is not an exact id is logged as `projectIdSha256`, and
  failed resolutions are logged with a fixed message. The tool catalog
  lists `GET /5.1/projects` for these tools.
- Behaviour change for embedders: `createDaluxGateway` in `./gateway`
  requires `apiKey` and `baseUrl` and no longer falls back to
  `DALUX_API_KEY`, `DALUX_BASE_URL` or the default base URL; a missing
  value throws when the gateway is created. The stdio and HTTP transports
  still read the environment.
- Secret redaction is per client instance instead of a process-wide
  registry, so gateways for different API identities in one process never
  share or retain each other's keys. Error text, tool results and audit
  records of an instance are redacted with its own key.
- `./gateway` exports `daluxToolCatalog`, a frozen, typed catalog of every
  tool with its schema, risk level and the Dalux API requests it may make,
  generated from the shared tool table, and the `DaluxGateway` type.
- Published to npm and the MCP Registry from tagged releases.
- HTTP transport: `DALUX_TRUST_FORWARDED_USER=true` records the `X-MCP-User`
  header from an identity-aware gateway as `caller` in the audit log, as
  `./gateway` `callTool(..., { caller })` does. The header is only honoured
  on requests with a valid `MCP_HTTP_TOKEN`, and the server refuses to
  start with the flag set and no token. A repeated header or an invalid
  value (comma, control or non-ASCII characters, over 320 characters) is
  rejected with `400`. Without the flag the header is ignored.

## 0.3.0

- New read-only tool `dalux_list_property_mappings`: file property mappings
  and allowed values for a folder or file (Box), and project and company
  catalog metadata mappings and values. Enabled by default, also in the
  `./gateway` export.
- `includeProperties` on `dalux_list_files` and on version set file lists.
- `dalux_get_project` adds a `license` summary of the project modules
  (`{ box, field, restrictions }`), unless Dalux returns a `license` field.
- Box tools fail fast when the project modules show a Box tier other than
  Pro (or a module list without Box), which the Box endpoints require (observed: `403 E40301`). The module
  lookup costs one request per project, cached for 5 minutes; failed
  lookups never block a call. `DALUX_LICENSE_PRECHECK=false` turns it off.
- `DALUX_ALLOWED_PROJECT_IDS` does not restrict the account-wide scopes of
  `dalux_list_property_mappings` (`scope=companyCatalog`, or `scope=project`
  without `projectId`). An invalid `DALUX_LICENSE_PRECHECK` value stops the
  server at startup.
- `dalux_get_task_changes` returns an empty result instead of an error when
  Dalux answers `404 "No task changes on project"`.
- The `E40301` hint names the project license and Box Pro.
- Audit targets include `includeProperties` and a hash of `key`.

## 0.2.0

### Upgrade notes

- The HTTP transport refuses to start on a non-loopback address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set to at least 32
  printable ASCII characters. `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an
  explicit escape hatch for isolated networks.
- Invalid configuration (`PORT`, `MCP_*` and `DALUX_*` numbers, `MCP_*`
  booleans, the base URL, tool names in `DALUX_DISABLED_TOOLS`) stops the
  server at startup. `DALUX_*` switches still require the exact value `true`.
- Tokens shorter than 32 printable ASCII characters are rejected, also on
  loopback. The Docker image now needs `MCP_HTTP_TOKEN` to start.
- Node.js 22 or later is required (the image uses Node 24).
- `DALUX_BASE_URL` must be `https` on a `*.dalux.com` host unless
  `DALUX_ALLOW_CUSTOM_BASE_URL=true`. Use the customer-specific URL shown in
  Dalux.
- Download limits are lower: 10 MB per call by default, server ceiling
  `DALUX_MAX_DOWNLOAD_BYTES` (default 25 MB, maximum 100 MB).
- Tool inputs are strict: unknown arguments are rejected.
- Audit log records changed: `targetHash` is replaced by `target` with ids in
  clear text; new fields `caller`, `durationMs`, `httpStatus`, `errorCode`.
  Write tools fail closed if the audit log cannot be written.
- The Docker image binds `0.0.0.0` by default and has a health check on
  `/healthz`.

### Security

- HTTP: fail-closed authentication, failed-authentication limiting (valid
  tokens are never throttled), Host checks on loopback binds, 400/413 handling,
  `WWW-Authenticate`, `/healthz`, graceful shutdown.
- Dalux client: the API key is never sent across origins (no automatic
  redirects), error bodies are capped and redacted, query strings are kept
  out of error messages, downloads are capped while streaming.
- Write tools are annotated as destructive; optional allowlists for projects
  and admin e-mail domains; content returned from Dalux is marked as
  untrusted data.

### Changes

- Errors follow Dalux's documented error model with hints per error code.
- GET requests are retried on 429/502/503/504 and connection failures,
  honouring `Retry-After`; concurrency is limited per process
  (`DALUX_MAX_CONCURRENCY`).
- Upload parts send `Content-Range` and `Content-Disposition`.
- One tool table for the MCP server and the `./gateway` export; gateway
  input is validated with the same schemas; `callTool` accepts an optional
  caller context for the audit log.
- Write bodies follow the Build API 4.15 schemas; empty writes are refused.
- `DALUX_DISABLED_TOOLS` hides tools; list results include
  `totalItems`/`totalRemainingItems`; results are compact JSON.
- Caller-supplied ids and pagination links are validated before use.
- `User-Agent: mcp-server-dalux/<version>`.
- Dependencies updated; CI-gated image publishing with SBOM and provenance;
  SHA-pinned actions.

## 0.1.1

- Pagination follows the `links: [{ rel, href }]` array the Build API
  actually answers (seen live on `GET /5.1/projects`, 2026-09-23), not only
  the `link { self, nextPage }` object. Before, every list stopped after its
  first page and never reported a continuation link.
- `smoke:live` reads list items from `data`, as the API wraps them.

## 0.1.0

Initial release.

- 22 tools against the Dalux Build API (Field + Box modules): projects, users,
  tasks/safety issues (incl. incremental change feed), forms, inspection/test
  plans, work packages, file areas/folders/files, version sets, file download,
  companies, and capability discovery.
- Write tools (`dalux_upload_file`, `dalux_change_company`,
  `dalux_change_project`) gated behind `DALUX_ENABLE_WRITES=true`.
- Opaque-link pagination with incremental-stream detection (`nextPage == self`),
  resumable via `pageLink`.
- Stateless streamable HTTP transport + stdio transport; JSONL audit log;
  secret redaction in errors; same-origin guard on pagination links.
