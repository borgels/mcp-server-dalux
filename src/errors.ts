/**
 * Errors and redaction.
 *
 * The rule: no text Dalux controls ever reaches a host, a result or an audit
 * record through an error. A DaluxHttpError carries the status, an error code
 * only when it is one of Dalux's documented codes (ERROR_CODE_HINTS), our own
 * hint, and a parsed Retry-After; never the response body, Dalux's message,
 * field errors or developer hints, or a redirect's Location. Dalux text can
 * quote the request, names, or part of the key, and no redactor recognises
 * every fragment.
 *
 * Redaction is the second line: every instance redacts its key (the exact
 * value, its URL- and JSON-encoded forms, and any fragment of
 * FRAGMENT_LENGTH characters or more) from everything it returns, always on
 * structured values before they are serialised, and before anything is cut
 * short.
 */

/** Dalux error response (ErrorModel in the published API spec), read only to recognise documented codes. */
export interface DaluxErrorPayload {
  httpStatusCode?: number;
  message?: string;
  errorCode?: string;
  code?: string | number;
}

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Any piece of a secret this long or longer is redacted, wherever it appears. */
export const FRAGMENT_LENGTH = 6;
/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;
/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of a key issued as
 * ASCII; a gateway refuses a key that contains it or shares a FRAGMENT_LENGTH piece with it (overlapsMarker).
 */
export const REDACTION_MARKER = '‹redacted›';

/** Whether a secret could survive its own redaction: it contains the marker, or shares a piece with it. */
export function overlapsMarker(value: string): boolean {
  if (value.includes(REDACTION_MARKER)) {
    return true;
  }
  for (let i = 0; i + FRAGMENT_LENGTH <= REDACTION_MARKER.length; i += 1) {
    if (value.includes(REDACTION_MARKER.slice(i, i + FRAGMENT_LENGTH))) {
      return true;
    }
  }
  return false;
}

/** Matches `<name>: <value>`, `<name>=<value>` and `"<name>": "<value>"` for one header (case-insensitive). */
function headerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`["']?${escaped}["']?\s*[:=]\s*["']?[^"',\s}]+`, 'gi');
}

/** Patterns that are always applied: credential-shaped key/value pairs. They hold no secret values. */
const BASE_PATTERNS: readonly RegExp[] = [
  /x-api-key:\s*[^,\s}]+/gi,
  /(apiKey|DALUX_API_KEY|api_key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * Redacts the secrets of one client, and so of one gateway or server
 * instance: the exact values (raw, URL-encoded and JSON-escaped), every
 * fragment of FRAGMENT_LENGTH characters or more of them, and the values of
 * named credential headers. Each instance owns its redactor, so a host that
 * runs several tenants in one process never mixes their keys, and a tenant's
 * key is released with its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly fragments = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /** Redact this value and every piece of it. Values shorter than MIN_SECRET_LENGTH are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
      this.secrets.add(form);
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) {
        this.fragments.add(form.slice(i, i + FRAGMENT_LENGTH));
      }
    }
    return this;
  }

  /** Redact the value of this header wherever it appears as `<name>: <value>` or `<name>=<value>`. */
  addHeader(name: string): this {
    const pattern = headerPattern(name);
    if (!this.patterns.some(existing => existing.source === pattern.source)) {
      this.patterns.push(pattern);
    }
    return this;
  }

  /** Whether this exact value is one of this instance's secrets. */
  hasSecret(value: string): boolean {
    return this.secrets.has(value);
  }

  /** Whether the text contains one of the secrets in any form, or any FRAGMENT_LENGTH-character piece of one. */
  matches(text: string): boolean {
    for (const secret of this.secrets) {
      if (text.includes(secret)) return true;
    }
    if (this.fragments.size === 0) return false;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
    }
    return false;
  }

  /** Whether raw bytes contain a secret or a piece of one, read as Latin-1 (byte for byte) and as UTF-8. */
  matchesBytes(bytes: Uint8Array): boolean {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.matches(buffer.toString('latin1')) || this.matches(buffer.toString('utf8'));
  }

  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('‹redacted›');
    }
    return applyPatterns(this.redactFragments(result), this.patterns);
  }

  /** Every run of text covered by a FRAGMENT_LENGTH-character piece of a secret becomes one ‹redacted›. */
  private redactFragments(text: string): string {
    if (this.fragments.size === 0 || text.length < FRAGMENT_LENGTH) {
      return text;
    }
    let covered: Uint8Array | undefined;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered ??= new Uint8Array(text.length);
        covered.fill(1, i, i + FRAGMENT_LENGTH);
      }
    }
    if (!covered) {
      return text;
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (covered[i]) {
        out += '‹redacted›';
        while (i < text.length && covered[i]) i += 1;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} ‹redacted›`;
      }),
    value,
  );
}

/** Actionable guidance for the documented Dalux error codes. Only these codes are ever shown or logged. */
const ERROR_CODE_HINTS: Record<string, string> = {
  E40001: 'The request body was rejected; check the values sent.',
  E40002: 'A query parameter was rejected; check the values sent. For list links, restart from the first page.',
  E40003: 'A user-defined field value was rejected; check the field ids and values.',
  E40004: 'A required request header was missing or invalid.',
  E40005:
    'The object is still being processed or uploaded by Dalux. Wait a little and retry the same call later. When finalizing an upload this means not all parts were received; retrying the finalize call will not help.',
  E40101: 'The API key was rejected (invalid or expired). The server operator must renew DALUX_API_KEY.',
  E40301:
    'The feature is not available for this project or API identity: the project license or module does not include it (the Box endpoints of the Dalux Build API require Box Pro). dalux_get_project shows the project modules. Retrying will not help.',
  E40401:
    'The object was not found, or the API identity has no access to it. Check the ids. If every call on a listed project fails this way, check that DALUX_BASE_URL is the customer-specific base URL shown in Dalux (company settings, API identities) and that the API identity has access to the project.',
  E40402:
    'No items are available: the list is empty, or the user groups of the API identity do not grant access to these items on this project.',
  E50001: 'Internal error at Dalux. Retry later.',
};

/** Conditions recognised in a Dalux error body by a fixed match, so callers never read the body themselves. */
export type DaluxErrorCondition = 'no_task_changes';

/**
 * An HTTP error from Dalux. The body is read once, at construction, to
 * recognise a documented error code and the known conditions; nothing of it
 * is kept. The message is our own.
 */
export class DaluxHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or malformed. */
  readonly retryAfter?: string;
  /** One of Dalux's documented error codes, or undefined. Never any other text from the response. */
  readonly errorCode?: string;
  readonly condition?: DaluxErrorCondition;

  constructor(input: { status: number; url: string; payload?: DaluxErrorPayload | unknown; retryAfter?: string }) {
    const payload = asErrorPayload(input.payload);
    const code = payload?.errorCode ?? payload?.code;
    const errorCode = typeof code === 'string' && Object.hasOwn(ERROR_CODE_HINTS, code) ? code : undefined;
    super(httpErrorMessage(input.status, errorCode, input.retryAfter));
    this.name = 'DaluxHttpError';
    this.status = input.status;
    this.url = describeUrl(input.url);
    const retryMs = parseRetryAfterMs(input.retryAfter);
    this.retryAfter = retryMs === undefined ? undefined : String(Math.ceil(retryMs / 1000));
    this.errorCode = errorCode;
    if (
      input.status === 404 &&
      typeof payload?.message === 'string' &&
      /^no task changes on project\.?$/i.test(payload.message.trim())
    ) {
      this.condition = 'no_task_changes';
    }
  }
}

/** The whole text of an HTTP error: status, a documented code with our hint, and a parsed Retry-After. */
function httpErrorMessage(status: number, errorCode: string | undefined, retryAfter: string | undefined): string {
  const retryMs = parseRetryAfterMs(retryAfter);
  return [
    `Dalux API request failed with HTTP ${status}`,
    errorCode ? `${errorCode}: ${ERROR_CODE_HINTS[errorCode]}` : undefined,
    retryMs === undefined ? undefined : `retry-after=${Math.ceil(retryMs / 1000)}s`,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, redactor);
  }

  return redactSecrets(String(error), redactor);
}

/**
 * Redact with an instance's redactor. Without one, only the credential-shaped
 * patterns are applied: no secret values are known outside an instance.
 */
export function redactSecrets(value: string, redactor?: SecretRedactor): string {
  return redactor ? redactor.redact(value) : applyPatterns(value, BASE_PATTERNS);
}

/** Origin and path of a URL, without query string or fragment (which may carry signatures). */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets. Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on.
 */
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactSecrets(text, redactor) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    // A Date and the like: redact what JSON.stringify would write.
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, redactor),
      redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** Keys whose value is a failure context: anything inside that carries an error or a message is a failure. */
const FAILURE_CONTEXTS = new Set(['failures', 'failure', 'errors', 'error', 'metadata', 'warnings', 'amount']);
/** Fields that make an object in a failure context a failure. */
const FAILURE_FIELDS = ['error', 'errors', 'failures', 'warnings', 'message', 'detail', 'description'];
/** Failure contexts that are lists of failures: a text in one is the vendor's own and is replaced by ours. */
const FAILURE_LISTS = new Set(['failures', 'failure', 'errors', 'error', 'warnings']);

function failureContext(key: string): false | 'list' | 'object' {
  return FAILURE_LISTS.has(key) ? 'list' : FAILURE_CONTEXTS.has(key) ? 'object' : false;
}

/**
 * Copy of a successful body with every failure reported inside it reduced to
 * its HTTP status and our own text. A failure is an object with a numeric
 * `status` of 400 or more, an object with an `error` field, or an
 * object in a failure context (`failures[]`, `errors[]`, `metadata`, `amount`
 * and the like) with any of `error`, `errors`, `message`, `detail` or
 * `description`. Its message, code, detail and every other field are
 * dropped. A text in a failure list (`failures`, `errors`, `warnings` and
 * the like) is replaced by our own text too; a text elsewhere, an amount
 * among them, is kept. Depth-limited.
 */
export function nestedFailuresAsStatus(value: unknown, depth = 0, context: false | 'list' | 'object' = false): unknown {
  if (depth > 64) {
    return '[nested too deep]';
  }
  if (typeof value === 'string' && context === 'list') {
    return 'Dalux reported a failure.';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => nestedFailuresAsStatus(entry, depth + 1, context));
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const failedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  const present = (field: string) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined;
  if (failedStatus || present('error') || (context && FAILURE_FIELDS.some(present))) {
    return failedStatus
      ? { status, error: `Dalux reported a failure with HTTP ${status}.` }
      : { error: 'Dalux reported a failure.' };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, nestedFailuresAsStatus(entry, depth + 1, failureContext(key))]),
  );
}

/**
 * Text for a failure kept inside a result that is otherwise returned (a part
 * that could not be read, an export file that failed): the HTTP status, a
 * timeout, or this server's own message, redacted. This server's error
 * messages carry no Dalux text (see the top of this file).
 */
export function nestedFailureText(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof DaluxHttpError) {
    return `Dalux API request failed with HTTP ${error.status}`;
  }
  return formatUnknownError(error, redactor);
}

/** IMF-fixdate, the HTTP date format used by Retry-After. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Retry-After header (delay in seconds or an HTTP date) into
 * milliseconds from `now`. Returns undefined when absent, malformed, zero or
 * in the past, so callers fall back to their own backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return date - now;
}

function asErrorPayload(value: unknown): DaluxErrorPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as DaluxErrorPayload) : undefined;
}
