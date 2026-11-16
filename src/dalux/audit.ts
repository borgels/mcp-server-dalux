import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';
import { emailDomain } from './policy.js';

export interface DaluxAuditEvent {
  /** Shared by all events of one tool call (start/finish/error). */
  requestId: string;
  tool: string;
  /** Caller identity supplied by an embedding host, when available. */
  caller?: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: Record<string, unknown>;
  status?: string;
  reason?: string;
  error?: unknown;
  durationMs?: number;
  httpStatus?: number;
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Append one JSON line to DALUX_AUDIT_LOG (no-op when unset). Never throws:
 * a failing audit sink is reported on stderr and must not change the tool
 * result, otherwise a successful write would surface as an error and invite
 * a retry (and a duplicate).
 */
export async function writeAuditEvent(event: DaluxAuditEvent): Promise<void> {
  const auditPath = process.env.DALUX_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  try {
    const record = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      tool: event.tool,
      caller: event.caller,
      action: event.action,
      target: event.target,
      status: event.status,
      httpStatus: event.httpStatus,
      durationMs: event.durationMs,
      reason: event.reason,
      error: event.error === undefined ? undefined : formatUnknownError(event.error),
    };

    await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`[dalux-mcp] audit log write failed: ${formatUnknownError(error)}\n`);
  }
}

/** Identifier fields logged in clear text: they are opaque ids, not secrets. */
const ID_FIELDS = [
  'projectId',
  'taskId',
  'formId',
  'fileAreaId',
  'folderId',
  'fileId',
  'fileRevisionId',
  'versionSetId',
  'userId',
  'companyId',
  'typeId',
  'kind',
  'part',
  'scope',
  'action',
  'fileType',
  'includeTemplates',
  'includeFiles',
] as const;

/** Free-text fields are hashed so user-written text does not land in the log. */
const FREE_TEXT_FIELDS = ['query', 'fileName'] as const;

/** Write payload objects: only their field names are logged. */
const PAYLOAD_FIELDS = ['body', 'patch'] as const;

/** Build the audit `target` for a tool input. */
export function auditTarget(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = input as Record<string, unknown>;
  const target: Record<string, unknown> = {};

  for (const field of ID_FIELDS) {
    if (value[field] !== undefined) {
      target[field] = value[field];
    }
  }

  for (const field of FREE_TEXT_FIELDS) {
    if (typeof value[field] === 'string' && value[field] !== '') {
      target[`${field}Sha256`] = hashValue(value[field] as string);
    }
  }

  for (const field of PAYLOAD_FIELDS) {
    const payload = value[field];
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      target[`${field}Fields`] = Object.keys(payload).sort();
    }
  }

  if (typeof value.adminEmail === 'string') {
    target.adminEmailDomain = emailDomain(value.adminEmail);
    target.adminEmailSha256 = hashValue(value.adminEmail.trim().toLowerCase());
  }

  if (typeof value.pageLink === 'string') {
    target.continued = true;
  }

  return target;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
