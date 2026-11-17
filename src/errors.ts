/** Field-level validation error in a Dalux error response. */
export interface DaluxErrorField {
  propertyName?: string;
  inputValue?: string | null;
  errorMessage?: string | null;
  developerHint?: string | null;
  arrayIndex?: number | null;
}

/**
 * Dalux error response (ErrorModel in the published API spec). The legacy
 * `error`/`code` fields are still read for tolerance.
 */
export interface DaluxErrorPayload {
  httpStatusCode?: number;
  message?: string;
  developerHint?: string;
  logTime?: string;
  errorCode?: string;
  errorCodeMessage?: string;
  errors?: DaluxErrorField[];
  error?: string;
  code?: string | number;
}

/** Maximum length of any single piece of text taken from a response body. */
export const MAX_ERROR_TEXT = 500;
const MAX_FIELD_ERRORS = 10;
/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;

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
 * instance: exact secret values, and the values of named credential headers.
 * Each instance owns its redactor, so a host that runs several tenants in
 * one process never mixes their keys, and a tenant's key is released with
 * its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /** Redact this exact value (and its URL-encoded form). Values shorter than 8 characters are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    this.secrets.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      this.secrets.add(encoded);
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

  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]');
    }
    return applyPatterns(result, this.patterns);
  }
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} [REDACTED]`;
      }),
    value,
  );
}

/** Actionable guidance for the documented Dalux error codes. */
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

export class DaluxHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: DaluxErrorPayload | unknown;
  readonly retryAfter?: string;
  readonly errorCode?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: DaluxErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
    /** Redactor of the client that made the request. */
    redactor?: SecretRedactor;
  }) {
    const redact = (value: string) => redactSecrets(value, input.redactor);
    super(formatDaluxHttpError(input, redact));
    this.name = 'DaluxHttpError';
    this.status = input.status;
    this.url = redact(describeUrl(input.url));
    this.payload =
      typeof input.payload === 'string' ? truncate(redact(input.payload)) : redactDeep(input.payload, input.redactor);
    this.retryAfter = input.retryAfter;
    const payload = asErrorPayload(input.payload);
    const code = payload?.errorCode ?? payload?.code;
    this.errorCode =
      typeof code === 'string' || typeof code === 'number' ? truncate(redact(String(code)), 64) : undefined;
  }
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

/** Copy of a JSON-like value with every string passed through redactSecrets. */
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth > 64) {
    // Deeper than any Dalux answer: left out rather than passed on unredacted.
    return '[nested too deep]';
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

/**
 * Text for a failure kept inside a result that is otherwise returned (a part
 * that could not be read, an export file that failed). For an HTTP error only
 * the status, never Dalux's own words: those can quote the request, names, or
 * part of the key, which no redactor recognises. Other errors are this
 * server's own messages, redacted and then shortened.
 */
export function nestedFailureText(error: unknown, redactor?: SecretRedactor, max = 300): string {
  if (error instanceof DaluxHttpError) {
    return `Dalux API request failed with HTTP ${error.status}`;
  }
  return truncate(formatUnknownError(error, redactor), max);
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

export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length} chars]` : value;
}

function formatDaluxHttpError(input: {
  status: number;
  url: string;
  payload?: DaluxErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}, redact: (value: string) => string): string {
  const payload = asErrorPayload(input.payload);
  const text = (value: unknown) => detailText(value, redact);
  const errorCode = text(payload?.errorCode) ?? text(payload?.code);
  const codeLabel = errorCode
    ? [errorCode, text(payload?.errorCodeMessage)].filter(Boolean).join(' ')
    : text(payload?.errorCodeMessage);
  const fallback =
    input.fallbackMessage ?? (typeof input.payload === 'string' && input.payload.trim() ? input.payload : undefined);

  const details = [
    codeLabel,
    text(payload?.error),
    text(payload?.message),
    text(payload?.developerHint) ? `hint: ${text(payload?.developerHint)}` : undefined,
    formatFieldErrors(payload?.errors, text),
  ].filter(Boolean);
  if (details.length === 0) {
    // Redact before truncating so a secret cut at the boundary cannot leak a prefix.
    if (payload !== undefined) {
      details.push(truncate(redact(JSON.stringify(payload))));
    } else if (fallback) {
      details.push(truncate(redact(fallback.trim())));
    }
  }

  const parts = [
    `Dalux API request failed with HTTP ${input.status}`,
    ...details,
    errorCode && Object.hasOwn(ERROR_CODE_HINTS, errorCode) ? ERROR_CODE_HINTS[errorCode] : undefined,
    formatRetryAfter(input.retryAfter),
  ].filter(Boolean);

  return redact(parts.join(' | '));
}

function formatFieldErrors(errors: unknown, text: (value: unknown) => string | undefined): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  const rendered = errors.slice(0, MAX_FIELD_ERRORS).map(entry => {
    if (typeof entry !== 'object' || entry === null) {
      return text(entry) ?? '?';
    }
    const field = entry as DaluxErrorField;
    const name = text(field.propertyName) ?? '?';
    const index = typeof field.arrayIndex === 'number' ? `[${field.arrayIndex}]` : '';
    const detail = [text(field.errorMessage), text(field.developerHint)].filter(Boolean).join(' - ');
    return `${name}${index}${detail ? `: ${detail}` : ''}`;
  });
  const more = errors.length > MAX_FIELD_ERRORS ? ` (+${errors.length - MAX_FIELD_ERRORS} more)` : '';
  return `errors: ${rendered.join('; ')}${more}`;
}

function formatRetryAfter(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const ms = parseRetryAfterMs(value);
  return ms === undefined ? undefined : `retry-after=${Math.ceil(ms / 1000)}s`;
}

function detailText(value: unknown, redact: (value: string) => string): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redact(value.trim()));
}

function asErrorPayload(value: unknown): DaluxErrorPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as DaluxErrorPayload)
    : undefined;
}
