# mcp-server-dalux

MCP server for the [Dalux Build API](https://app.swaggerhub.com/apis-docs/Dalux/DaluxBuild-api/4.15) — the official API covering Dalux **Field** (tasks, safety issues, forms/checklists, inspection & test plans) and Dalux **Box** (document file areas, folders, files, version sets).

## What it can do

**Read (always on):** projects, project users, tasks/approvals/safety issues + incremental change feed + attachments, forms + attachments, inspection/test plans (items, zones, registrations), work packages, file areas/folders/files, version sets, file download (size-capped), companies (project + account catalog), and `dalux_search_capabilities` for tool discovery.

**Write (opt-in via `DALUX_ENABLE_WRITES=true`):** file upload (3-step chunked flow), create/update companies, create/update projects.

**Not possible through the Dalux API at all** (as of Build API 4.15): creating or updating tasks and forms (Field data is read-only), user management, webhooks (poll the incremental change feeds instead), and BIM/model/geometry queries.

## Auth

One `X-API-KEY` header. Keys are issued per [API identity](https://support.dalux.com/hc/en-us/articles/20892369915292) under Company profile → Settings → API identities, expire after a chosen validity period, and are scoped by the user groups the identity is assigned per project. API access itself is activated by Dalux support / your Customer Success Manager (requires a company license).

## Configuration

See `.env.example`. Required: `DALUX_API_KEY`. Optional: `DALUX_BASE_URL` (defaults to `https://field.dalux.com/service/api`), `DALUX_TIMEOUT_MS`, `DALUX_ENABLE_WRITES`, `DALUX_AUDIT_LOG` (JSONL audit trail; identifiers are hashed).

## Run

```bash
npm install
npm run dev          # stdio transport
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images are published to `ghcr.io/borgels/mcp-server-dalux` on every push to `main`.

## Pagination

Dalux lists use opaque links only. Tools return `{ items, pagesFetched, nextPage, endOfIncrementalStream }`; pass `nextPage` back as `pageLink` to continue. For incremental lists (tasks changes, forms, files), `endOfIncrementalStream=true` means you have caught up — keep the link and poll it later for deltas. Links are validated to stay on the API origin.
