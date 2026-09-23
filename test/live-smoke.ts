/**
 * Live smoke test against the real Dalux Build API.
 * Requires DALUX_API_KEY (and optionally DALUX_BASE_URL) in the environment.
 * Read-only: lists projects, then users + tasks + file areas on the first project.
 *
 *   DALUX_API_KEY=... npm run smoke:live
 */
import { DaluxClient } from '../src/dalux/client.js';
import { listProjects, listProjectUsers } from '../src/dalux/projects.js';
import { listTasks } from '../src/dalux/tasks.js';
import { listFileAreas } from '../src/dalux/box.js';

const client = new DaluxClient();

const projects = await listProjects(client, { maxPages: 1 });
console.log(`projects: ${projects.items.length} (nextPage=${Boolean(projects.nextPage)})`);

// Items come wrapped: { data: { projectId, projectName } } (seen live 2026-09-23); a flat item is read too.
const raw = projects.items[0] as { data?: { projectId?: string; projectName?: string }; projectId?: string; projectName?: string } | undefined;
const first = raw ? { projectId: raw.data?.projectId ?? raw.projectId, projectName: raw.data?.projectName ?? raw.projectName } : undefined;
if (!first?.projectId) {
  console.log('No projects visible for this API identity — check its project/user-group assignments.');
  process.exit(0);
}
console.log(`first project: ${first.projectId} ${first.projectName ?? ''}`);

const users = (await listProjectUsers(client, { projectId: first.projectId, maxPages: 1 })) as { items: unknown[] };
console.log(`users on first project: ${users.items.length}`);

const tasks = await listTasks(client, { projectId: first.projectId, maxPages: 1 });
console.log(`tasks on first project (page 1): ${tasks.items.length}`);

const areas = (await listFileAreas(client, { projectId: first.projectId, maxPages: 1 })) as { items: unknown[] };
console.log(`file areas on first project: ${areas.items.length}`);

console.log('Live smoke OK.');
