# Changelog

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
