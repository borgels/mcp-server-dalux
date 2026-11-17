import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { DaluxHttpError, formatUnknownError, type SecretRedactor } from '../errors.js';
import { emailDomain } from './policy.js';
import { isExactProjectId } from './project-ref.js';

export interface DaluxAuditEvent {
  /** Shared by all events of one tool call (start/finish/error). */
  requestId: string;
  tool: string;
  /** Caller identity supplied by an embedding host, when available. */
  caller?: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: Record<string, unknown>;
  status?: string;
  reason?: string;
  error?: unknown;
  durationMs?: number;
  /** Non-sensitive result figures (counts, sizes) supplied by the tool. */
  details?: Record<string, string | number | boolean>;
}

const MAX_AUDIT_MESSAGE_LENGTH = 200;

/**
 * Error summary for the audit log: HTTP status, Dalux error code and a short
 * redacted message. Response bodies are never logged in full, since Dalux
 * echoes input (names, e-mail addresses) in error text.
 */
export function auditErrorSummary(
  error: unknown,
  redactor?: SecretRedactor,
): { httpStatus?: number; errorCode?: string; message: string } {
  if (error instanceof DaluxHttpError) {
    const payload = (error.payload && typeof error.payload === 'object' ? error.payload : {}) as Record<string, unknown>;
    const code = payload.errorCode ?? payload.code;
    return {
      httpStatus: error.status,
      errorCode: typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 50) : undefined,
      message: `Dalux API request failed with HTTP ${error.status}`,
    };
  }
  const message = formatUnknownError(error, redactor);
  return {
    message:
      message.length > MAX_AUDIT_MESSAGE_LENGTH ? `${message.slice(0, MAX_AUDIT_MESSAGE_LENGTH)}…` : message,
  };
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Append one JSON line to DALUX_AUDIT_LOG (no-op when unset).
 *
 * By default a failing audit sink is reported on stderr and does not change
 * the tool result: after a call has run, surfacing an error would invite a
 * retry and a duplicate write. With `required: true` (used for the event
 * written before a write tool runs) the failure is thrown instead, so no
 * write happens without an audit record. `redactor` is the redactor of the
 * instance that ran the call.
 */
export async function writeAuditEvent(
  event: DaluxAuditEvent,
  options: { required?: boolean; redactor?: SecretRedactor } = {},
): Promise<void> {
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
      durationMs: event.durationMs,
      reason: event.reason,
      ...(event.details === undefined ? {} : { details: event.details }),
      ...(event.error === undefined ? {} : errorFields(auditErrorSummary(event.error, options.redactor))),
    };

    await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    if (options.required) {
      // Details (path, OS error) go to stderr only, not to the caller.
      process.stderr.write(`[dalux-mcp] audit log write failed, refusing ${event.tool}: ${formatUnknownError(error, options.redactor)}\n`);
      throw new Error(`Audit log is not writable on this instance; ${event.tool} was not run.`);
    }
    process.stderr.write(`[dalux-mcp] audit log write failed: ${formatUnknownError(error, options.redactor)}\n`);
  }
}

function errorFields(summary: ReturnType<typeof auditErrorSummary>) {
  return { httpStatus: summary.httpStatus, errorCode: summary.errorCode, error: summary.message };
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
  'includeProperties',
  'includePhotos',
  'since',
] as const;

/** Free-text fields are hashed so user-written text does not land in the log. */
const FREE_TEXT_FIELDS = ['query', 'fileName', 'key'] as const;

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

  // A projectId that is not an exact id may be a project number or name
  // typed by the user: log its hash instead.
  if (typeof value.projectId === 'string' && !isExactProjectId(value.projectId)) {
    delete target.projectId;
    target.projectIdSha256 = hashValue(value.projectId);
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
  }

  // Plan filters may be names typed by the user: only their number is logged.
  if (Array.isArray(value.plans)) {
    target.planFilters = value.plans.length;
  }

  if (typeof value.pageLink === 'string') {
    target.continued = true;
  }

  return target;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
