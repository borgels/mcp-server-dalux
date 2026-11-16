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
const MIN_SECRET_LENGTH = 8;

const SECRET_PATTERNS = [
  /x-api-key:\s*[^,\s}]+/gi,
  /(apiKey|DALUX_API_KEY|api_key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
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
  }) {
    super(formatDaluxHttpError(input));
    this.name = 'DaluxHttpError';
    this.status = input.status;
    this.url = redactSecrets(describeUrl(input.url));
    this.payload =
      typeof input.payload === 'string' ? truncate(redactSecrets(input.payload)) : redactDeep(input.payload);
    this.retryAfter = input.retryAfter;
    const payload = asErrorPayload(input.payload);
    const code = payload?.errorCode ?? payload?.code;
    this.errorCode =
      typeof code === 'string' || typeof code === 'number' ? truncate(redactSecrets(String(code)), 64) : undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    result,
  );
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
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value !== 'object' || value === null || depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
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
}): string {
  const payload = asErrorPayload(input.payload);
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
    formatFieldErrors(payload?.errors),
  ].filter(Boolean);
  if (details.length === 0) {
    // Redact before truncating so a secret cut at the boundary cannot leak a prefix.
    if (payload !== undefined) {
      details.push(truncate(redactSecrets(JSON.stringify(payload))));
    } else if (fallback) {
      details.push(truncate(redactSecrets(fallback.trim())));
    }
  }

  const parts = [
    `Dalux API request failed with HTTP ${input.status}`,
    ...details,
    errorCode && Object.hasOwn(ERROR_CODE_HINTS, errorCode) ? ERROR_CODE_HINTS[errorCode] : undefined,
    formatRetryAfter(input.retryAfter),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function formatFieldErrors(errors: unknown): string | undefined {
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

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redactSecrets(value.trim()));
}

function asErrorPayload(value: unknown): DaluxErrorPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as DaluxErrorPayload)
    : undefined;
}
