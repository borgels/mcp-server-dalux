# Changelog

## 0.5.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.5.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.4.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error (or a redirect, which is refused), the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`, the vendor's documented header first), kept only
  when it is a hex id of 8 to 64 characters (one run of hex digits,
  or groups of four or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the key is dropped. Never the body, the vendor's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`).
- An error of ours that wraps one of Dalux's as its cause (the export's
  "Could not read the quality plans") keeps that error's metadata. When
  reading an error body fails (a timeout or a dropped connection), the error
  is now the status Dalux answered with, not a transport error, so it keeps
  its status and request id.

## 0.3.1

- Gateway results: the data is now in the text block too. A successful
  `callTool` result has one text block with the summary, a blank line and
  then `structuredContent` as compact JSON (`summary\n\n{...}`), as the MCP
  specification recommends for tools that return structured content. Before,
  the text held only the summary, so a client that reads only the text (as
  Claude does) got no data. The JSON is built from the final, redacted copy,
  so it is exactly `structuredContent`, and the sink check covers it. Error
  results and `structuredContent` are unchanged.
- A download redirect is followed only after its complete target URL
  passes the key check (plain and decoded); one that carries the key is
  refused with a fixed error and never fetched. Links Dalux returns
  (`self`, `nextPage`) get the same check before they are followed.
- A `projectId` Dalux returns replaces the host's reference only in its
  fixed numeric shape; anything else is not taken as a project. The Box
  licence error no longer names the project.
- The whole finalisation of a result runs inside the error boundary: a
  throw there ends in the fixed withheld result. The README states the
  scope: the host is trusted; vendor values and anything persisted are in
  scope.
- The export archive is built in memory and written to disk only after
  the sink check on its complete bytes; no partial file exists. A gateway
  refuses a key that shares a piece with the paths it can create (the
  audit log without a host policy and the export directory). Project
  reference errors name the number of candidates and their numeric
  `projectId` values, never a project's number or name.
- Export: the finished archive's complete bytes (the zip format's own
  records included) are checked before the move or delivery, and the
  export directory and its subdirectory are checked before anything is
  created; either refuses the export with a fixed error.
- Delivery: the final destination of a file delivery is checked after a
  name collision, just before the move, and the whole archive object a
  host's hook receives (size included) is checked before the hook is
  called; either refuses the export with a fixed error. Errors about a
  link or the base URL no longer name the host, origin or base path.
- Errors leave in final form: every error a gateway throws is a fresh
  error with no `cause`, a `stack` of just `name: message` (no frames,
  paths or function names), and name, message and stack masked against the
  secret; the sink check runs on the finished object, its non-enumerable
  fields included.
- Every element of a failure list (`failures`, `failure`, `errors`,
  `error`, `warnings`), at any depth and whatever its fields, becomes
  `{ status?, message }` with our own text; a failure context such as
  `metadata` or `amount` holds through wrappers such as `data`.
- Network, timeout and redirect errors name the method only, not the
  configured address.
- An export whose local file path (`DALUX_EXPORT_DIR` and the archive's
  name) holds a piece of the key is refused with a fixed error before
  anything is written or handed to the host's hook.
- The sink check: every output of a gateway (the tool list, results, audit records and stderr lines, export entry paths, archive names and finished files, construction errors) is checked in its
  final form, and one that holds a piece of 6 characters of the key is
  replaced by a fixed fallback (`src/fallbacks.ts`): a withheld result, a
  fixed audit record or line, or the fixed refusal. A key that shares a
  piece with a fallback or with the tool list is refused at creation.
- Key admission: printable ASCII (0x21-0x7E) of at least 16 characters,
  checked before anything is built from the key; the corpus of our own
  string literals stays as a cheap first filter.
- A text in a failure list of a successful answer (`failures`, `errors`,
  `warnings` and the like) is replaced by our own text, like a failure
  object.
- The threat model's guarantees apply to the gateway (`./gateway`); the
  standalone MCP server keeps best-effort redaction. The MCP server now runs
  each call in a scope with its redactor, and every audit record (finish and
  policy refusals included) and every audit failure written to stderr is
  redacted with the same redactor, through the shared `redactDeep`.
- The redaction marker is `‹redacted›` (non-ASCII brackets).
- Key admission: a gateway refuses a key shorter than 16 characters, or one
  that shares a 6-character piece with any of this server's own texts
  (`src/fixed-corpus.generated.ts`, kept up to date by a test), with a fixed
  text that never repeats it.
- Every string leaving the gateway passes the instance's redactor as the
  last step: results, construction errors, whole stderr lines, and whole
  archive entry paths and archive names after concatenation (a photo whose
  path matches is left out; the archive name falls back to a fixed name).
- A failure reported inside a successful body (a `status` of 400 or more,
  an `error` field, or a message in `failures`, `errors`, `metadata` and the
  like) keeps only its status and our own text.
- Exports: the CSV files are built from data redacted as data (before CSV
  escaping); a plan, registration or project id that holds a piece of the key
  is replaced by a number of our own in file and folder names.
- An error body that cannot be read is dropped (the error is the status); a
  network error names a system error code only from a fixed list.

- Threat model in the README: what is guaranteed about the key (never
  persisted or shared; no vendor text in errors; results only to the key's
  tenant) and the residual risk (Dalux echoing the key back in data,
  transformed).
- Numbers and booleans whose string form matches the key, or a piece of it,
  become the string `"‹redacted›"`, so JSON stays valid. The gateway redacts
  a result first and copies it as JSON afterwards, so a deep result cannot
  exhaust the stack.
- `download_file` refuses, with a fixed text, a file whose bytes contain the
  key or a piece of it, checked before base64 encoding.
- `export_quality_plans` redacts the archive's index and CSV files before
  they are written, leaves out photos whose bytes contain the key, and builds
  the archive's file names from ids only (never a project's number or name,
  never a shortened id).
- An error thrown while reading a successful body becomes a fixed text.

- `./gateway`: every result is redacted, best-effort, with the instance's key,
  the text and the structured data, object keys included. Strings nested deeper than 64
  levels are left out instead of passed on unredacted.
- A failure kept inside a result that is otherwise returned (`get_project`
  metadata, the failures of a quality-plan export) is the HTTP status or this
  server's own message, never Dalux's own error text, which can quote part of
  the key.
- No Dalux text in errors. `DaluxHttpError` keeps the status, an error code
  only when it is one of Dalux's documented codes (with our hint), and a
  parsed Retry-After; Dalux's message, developer hint, field errors and body
  are no longer quoted, and `payload` is gone (`condition` tells "no task
  changes"). An error body over 64 KB is discarded whole. Redirect errors no
  longer quote the `Location`, link and upload errors no longer quote Dalux's
  answer, and network errors name only a system error code. Audit records
  carry only documented codes. Configuration errors no longer quote the
  rejected value.
- The redactor also removes the JSON-escaped form of a key and any piece of
  it of 6 characters or more. Values at any depth beyond the limit are
  replaced, strings included.
- Project references that match several projects still name the candidates
  from the project list (Dalux data, redacted like any result).

- `./gateway`: `createDaluxGateway` takes `policy` (`enableWrites`,
  `disabledTools`, `allowedProjectIds`, `allowProjectCreate`,
  `allowedAdminEmailDomains`, `licensePrecheck`, `audit` sink). An instance
  with a host policy reads no policy or audit variable from the environment,
  so tenants in one process can have different settings. An unknown disabled
  tool, an empty allowlist or a malformed value throws when the instance is
  created. Without `policy` nothing changes. Under a host policy the
  refusals name the host's setting, not an environment variable.
- `./gateway`: every gateway call runs in a call scope of its own (policy or
  environment, sink, redactor), so a call made from inside another
  instance's call (from its audit sink, its fetch or its export hook) never
  inherits that instance's policy, sink or redactor.
- Audit records are redacted as a whole with the instance's redactor before
  they reach the sink or the log file: tool name, input field names, caller,
  request id and reason, refusals included. Text is redacted before it is
  cut short, so no part of a key survives a cut.
- `createDaluxGateway` refuses an `apiKey` shorter than 8 characters, the
  shortest secret the redactor protects.
- `export_quality_plans` reads only the export limits and work directory
  (`getExportLimits`), never the delivery settings (`DALUX_EXPORT_DELIVERY`,
  `DALUX_PUBLIC_BASE_URL`, `DALUX_EXPORT_TTL_MINUTES`,
  `DALUX_EXPORT_ONE_TIME`): delivery is the target's (the host's hook or the
  transport's). Under a host policy without `exportDelivery` the refusal
  names the host.
- `daluxToolCatalog` entries carry `broad`, the mark the server family's
  gateway catalogs use for a tool that can read more than its name says.
  It is false for every Dalux tool: each reads only the requests listed in
  its `upstream`. Hosts that grant tools per role read the mark from the
  catalog instead of setting it by hand.
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
