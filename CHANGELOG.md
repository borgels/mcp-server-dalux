# Changelog

## 0.2.0

### Upgrade notes

- The HTTP transport refuses to start on a non-loopback address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set to at least 32
  printable ASCII characters. `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an
  explicit escape hatch for isolated networks.
- Invalid configuration (`PORT`, `MCP_*`, `DALUX_*` numbers, booleans, tool
  names in `DALUX_DISABLED_TOOLS`) stops the server at startup.
- `DALUX_BASE_URL` must be `https` on a `*.dalux.com` host unless
  `DALUX_ALLOW_CUSTOM_BASE_URL=true`. Use the customer-specific URL shown in
  Dalux.
- Download limits are lower: 10 MB per call by default, server ceiling
  `DALUX_MAX_DOWNLOAD_BYTES` (default 25 MB, maximum 100 MB).
- Tool inputs are strict: unknown arguments are rejected.
- Audit log records changed: `targetHash` is replaced by `target` with ids in
  clear text; new fields `caller`, `durationMs`, `httpStatus`, `errorCode`.
  Write tools fail closed if the audit log cannot be written.
- The Docker image now binds `0.0.0.0` by default and has a health check.

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
