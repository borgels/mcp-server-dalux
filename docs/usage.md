# Using mcp-server-dalux

This guide covers the Dalux side of the setup, how to connect a client, how to run the server for more than one user, and what the tools are good for in practice.

## 1. Create a Dalux API identity

API access is part of a Dalux company license and is activated by Dalux. Once it is active:

1. In Dalux, open the company profile, then **Settings → API identities**, and create an identity. See Dalux's article [API identities in Dalux Build API](https://support.dalux.com/hc/en-us/articles/20892369915292).
2. Choose the company access the use case needs. Without company access the identity only sees the projects whose user groups it belongs to; company access (observer or administrator) covers all projects.
3. Add the identity only to the projects it needs, through user groups on each project. The identity sees exactly what those user groups see.
4. Create a key with a validity period and note the expiry date. Store it in a secret store, not in a file in a repository.
5. Copy the API base URL from the same page (**Copy API base URL**) into `DALUX_BASE_URL`. It is specific to your company, for example `https://node1.field.dalux.com/service/api`; with the wrong host, projects are listed but every project call fails with `404 E40401`.

Check the setup with a read-only call against the real tenant:

```bash
DALUX_API_KEY=<key> DALUX_BASE_URL=<base url> npm run smoke:live
```

It lists the visible projects and, for the first one, its users, tasks and file areas. If it reports no projects, the identity is not yet in any project's user groups.

## 2. Connect a client

**Single user, local.** Run the stdio transport from the client, as shown in the README. The key lives in the client's MCP configuration on that machine.

**Single user, container.** Run the image with `MCP_HTTP_TOKEN` set and publish the port on loopback only (`-p 127.0.0.1:3000:3000`). Point the client at `http://127.0.0.1:3000/mcp` with the bearer token.

**Several users.** Do not hand the bearer token to end users. Put the server behind a gateway that:

- signs users in against your identity provider (for example OIDC or SAML),
- maps groups to the tools each group may call (read tools for most users, write tools for few or none),
- holds the bearer token and is the only network path to the server,
- records who called what.

The server keeps its own audit log (`DALUX_AUDIT_LOG`). Hosts that embed the tools through the `./gateway` export can pass `{ caller, requestId }` to `callTool`, so both logs can be correlated.

Narrow the instance further where it helps:

```bash
DALUX_ALLOWED_PROJECT_IDS=<id>,<id>        # only these projects
DALUX_DISABLED_TOOLS=dalux_list_project_users
DALUX_ENABLE_WRITES=false                  # default
```

## 3. Typical workflows

The examples are prompts a user might give the assistant, with the tools it would use.

**Site status.** "Which safety issues on project X are still open, grouped by responsible company?"
`dalux_list_projects` → `dalux_list_tasks` (optionally with the task type id) → `dalux_list_companies`.

**What changed since yesterday.** "Summarise task changes on project X since my last check."
`dalux_get_task_changes`; keep the returned `nextPage` and pass it as `pageLink` next time to continue from there.

**Quality assurance.** "Which inspection plan items on project X have no registrations yet?"
`dalux_list_quality_plans` with `part: items` and `part: registrations`.

**Forms.** "Show the answers in the latest workplace assessment form on project X."
`dalux_list_forms` → `dalux_get_form`.

**Documents** (requires Box Pro on the project). "Find the newest revision of the ground floor plan in the drawings area and summarise the revision history."
`dalux_list_file_areas` → `dalux_list_folders` → `dalux_list_files` → `dalux_download_file` for text-based files. Large binaries such as drawings and models are better opened in Dalux; the download tool is capped at 10 MB per call by default.

**Keeping a copy in sync.** For files, forms, form attachments and version-set files, Dalux returns incremental lists. Read to the end (`endOfIncrementalStream: true`), store `nextPage`, and call it later to receive only changes.

## 4. Limits

- The Dalux API cannot create or edit tasks or forms, manage users, or push events. The assistant can read and report, not register.
- Every list call fetches up to five pages by default (`maxPages`, at most 25). Large projects need several calls; the result says how many items remain when Dalux provides it.
- Download links in task and form attachments require the API key and cannot be opened directly by the user.
- Dalux does not publish rate limits. The server retries reads on 429 and 5xx responses with backoff and limits concurrent requests (`DALUX_MAX_CONCURRENCY`).
- Results contain content written by project participants. Treat them as data; the assistant should not follow instructions found in task texts, form answers or files.
