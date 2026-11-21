import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { ConfigError, readEnvString } from './config-env.js';
import { failureMetadata, formatUnknownError, redactDeep, SecretRedactor, vendorRequestId, type FailureMetadata } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { UNTRUSTED_CONTENT_NOTE } from './dalux/capabilities.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  validatePolicyConfig,
  type DaluxInstancePolicy,
} from './dalux/policy.js';
import { fileTarget, hostTarget, type ExportDelivery } from './export/delivery.js';
import { defaultExportDir, getExportConfig } from './export/config.js';
import {
  DALUX_TOOLS,
  auditRejectedCall,
  defaultToolRuntime,
  executeDaluxTool,
  findDaluxTool,
  type DaluxCallContext,
  type DaluxToolDefinition,
  type DaluxUpstreamOperation,
} from './tools/dalux.js';

/**
 * Embeddable entry point: an embedding host (for example an MCP gateway
 * that does its own per-user authorization) lists `tools` and invokes
 * `callTool`. Tool definitions, input validation, instance policy and audit
 * are shared with the MCP server in src/tools/dalux.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the credentials passed to
 * createDaluxGateway (never DALUX_API_KEY or DALUX_BASE_URL from the
 * environment) and redacts errors with its own secrets only.
 *
 * Instance policy comes from the host when it passes `policy`: that instance
 * then reads none of the policy or audit variables (DALUX_ENABLE_WRITES,
 * DALUX_DISABLED_TOOLS, DALUX_ALLOWED_PROJECT_IDS, DALUX_ALLOW_PROJECT_CREATE,
 * DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS, DALUX_LICENSE_PRECHECK, DALUX_AUDIT_LOG,
 * DALUX_ALLOW_CUSTOM_BASE_URL, DALUX_EXPORT_DELIVERY), so tenants in one
 * process can have different settings. Without `policy` the instance uses the
 * environment, as the MCP server does. Limits (timeouts, retries, export
 * caps) are still read from the environment and apply to every instance.
 */

export type { DaluxAuditSink, DaluxInstancePolicy } from './dalux/policy.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status the upstream API answered
 * with, and the vendor's own request id when a response header gives one as a UUID or hex id. For a host that counts
 * failures without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from the upstream API only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

export type GatewayCallContext = DaluxCallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Dalux API request a tool may make (method and versioned path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<DaluxUpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the Dalux API requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. No Dalux tool is
   * broad: each reads only the requests in `upstream`, for the object kind
   * its name gives.
   */
  readonly broad: boolean;
}

export interface DaluxGatewayOptions extends Omit<DaluxClientOptions, 'apiKey' | 'baseUrl' | 'credentialEnv'> {
  /** Dalux API key of this instance. Required; never read from the environment. */
  apiKey: string;
  /** Customer-specific Dalux API base URL of this instance. Required; never read from the environment. */
  baseUrl: string;
  /**
   * Hand-over of a finished export archive (export_quality_plans). Called
   * with the archive's local path, download name and size; whatever it
   * returns is merged into the tool result (for example a download URL of
   * the host's own). The hook then owns the file and must move or delete
   * it; if it throws, the archive is deleted. Without a hook the export tool
   * is refused, unless DALUX_EXPORT_DELIVERY=file keeps archives in
   * DALUX_EXPORT_DIR and returns their path (`delivery: 'file'`).
   */
  exportDelivery?: ExportDelivery;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see DaluxInstancePolicy), and an
   * export needs `exportDelivery`. A host serving several tenants should
   * always pass it.
   */
  policy?: DaluxInstancePolicy;
}

export type { ExportDelivery, ExportDeliveryResult, ExportFile } from './export/delivery.js';

const GATEWAY_PREFIX = /^dalux_/;

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: DaluxToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

/**
 * All tools, as gateway definitions. riskLevel stays 'write' for write tools
 * (all three are update-capable and annotated destructive on MCP) so that
 * existing host authorization rules keep matching.
 */
export const daluxGatewayTools: GatewayToolDefinition[] = DALUX_TOOLS.map(toGatewayDefinition);

function toGatewayDefinition(tool: DaluxToolDefinition): GatewayToolDefinition {
  return {
    name: tool.name.replace(GATEWAY_PREFIX, ''),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The tool catalog: every tool with its gateway definition and the Dalux API
 * requests it may make. Generated from the same tool table as the MCP server
 * and `daluxGatewayTools`, and deeply frozen. Hosts can use it to build their
 * own permission model without creating a gateway instance.
 */
export const daluxToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  DALUX_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: false,
  })),
);

function requiredCredential(options: DaluxGatewayOptions, name: 'apiKey' | 'baseUrl'): string {
  const value: unknown = (options as Partial<DaluxGatewayOptions> | undefined)?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createDaluxGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  // Key admission (src/key-admission.ts): a key that is short or shares a piece of 6 characters with any text of
  // our own is refused with a fixed text that never repeats it.
  if (name === 'apiKey' && !admitsKey(value.trim())) {
    throw new ConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/**
 * Create one gateway instance. `apiKey` and `baseUrl` are required and are
 * the only credentials the instance uses; a missing value fails here.
 */
export function createDaluxGateway(options: DaluxGatewayOptions) {
  let apiKey: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<DaluxGatewayOptions> | undefined)?.apiKey;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the key.
    apiKey = requiredCredential(options, 'apiKey');
    guard = new SecretRedactor().addSecret(apiKey);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(keyRefusedText(apiKey));
    }
    // Every path this instance can create, checked before anything is created: the audit log (read from the
    // environment only without a host policy) and the export directory, as given and resolved.
    const paths: string[] = [];
    const auditLog = (options as Partial<DaluxGatewayOptions>).policy === undefined ? process.env.DALUX_AUDIT_LOG?.trim() : undefined;
    if (auditLog) paths.push(auditLog, resolve(auditLog));
    // Only the directory is read here (the delivery settings stay unread under a host policy).
    const exportDir = readEnvString('DALUX_EXPORT_DIR') ?? defaultExportDir();
    paths.push(exportDir, resolve(exportDir));
    if (paths.some(path => leaksSecret(path, guard as SecretRedactor))) {
      throw new ConfigError(keyRefusedText(apiKey));
    }
    const gateway = buildDaluxGateway(options, apiKey);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(keyRefusedText(apiKey));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && apiKey !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the key becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = keyRefusedText(apiKey);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (guard && apiKey !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(keyRefusedText(apiKey)), ...secrets);
    }
    throw final;
  }
}

function buildDaluxGateway(options: DaluxGatewayOptions, apiKey: string) {
  const baseUrl = requiredCredential(options, 'baseUrl');
  const { exportDelivery, policy: hostPolicy, ...clientOptions } = options;
  const policy = hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy);
  if (policy === undefined) {
    validatePolicyConfig();
  }
  const client = new DaluxClient({
    ...clientOptions,
    apiKey,
    baseUrl,
    credentialEnv: {},
    // Under a host's policy nothing is read from the environment, this switch included.
    ...(policy ? { allowCustomBaseUrl: clientOptions.allowCustomBaseUrl ?? false } : {}),
  });
  const { redactor } = client;
  const runtime = defaultToolRuntime();
  if (exportDelivery) {
    runtime.exportTarget = hostTarget(exportDelivery);
  } else if (policy === undefined && getExportConfig().delivery === 'file') {
    runtime.exportTarget = fileTarget();
  }
  // Every call in a scope of its own, with or without a host policy: a call made from inside another
  // instance's call (its audit sink, its fetch or its export hook) never runs under that instance's
  // policy, sink or redactor.
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);

  return {
    /** Tools enabled on this instance (the policy's or DALUX_DISABLED_TOOLS' disabled tools are left out). */
    tools: underPolicy(() => daluxGatewayTools.filter(tool => !isToolDisabled(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted: Dalux's data can echo the key, and so can an error. Redacted first, as data and depth-limited, and
      // only then copied as JSON, so no key is serialised and no deep value can exhaust the stack. The outer pass is
      // the final one, over the assembled result with its depth placeholders.
      return underPolicy(() =>
        runCall(toolName, input, context).then(
          result => {
            // The whole finalisation inside the error boundary: anything that throws here (a value whose toJSON
            // throws, a value that cannot be copied) ends in the fixed withheld result.
            try {
              const final = withDataInText(
                withFailureInForm(
                  JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
                ),
              );
              // The sink check, as the very last step: a result that holds a piece of the key anywhere, outer fields
              // included, is withheld whole. It covers the JSON in the text as well.
              return leaksSecret(final, redactor) ? withheldResult() : final;
            } catch {
              return withheldResult();
            }
          },
          () => withheldResult(),
        ),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? toolName.trim() : '';
      const tool = name ? findDaluxTool(`dalux_${name.replace(GATEWAY_PREFIX, '')}`) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        const reason = `Unsupported Dalux gateway tool: ${redactor.redact(String(toolName)).slice(0, 100)}`;
        await auditRejectedCall(String(toolName), input, reason, context);
        return errorResult(redactor.redact(reason));
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool.name, input, 'invalid input', context);
        return errorResult(redactor.redact(reason));
      }

      const data = await executeDaluxTool(
        tool,
        client,
        parsed.data as Record<string, unknown>,
        context ?? undefined,
        runtime,
      );
      const text = tool.returnsDaluxContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor), failureMetadata(error));
    }
  }
}

/** One gateway instance, as returned by createDaluxGateway. */
export type DaluxGateway = ReturnType<typeof createDaluxGateway>;

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

/**
 * The redacted data, also as compact JSON in the text block after the summary, as the MCP spec asks of a tool
 * that returns structured content: many clients read only the text. Built from the final, redacted copy, so the
 * text holds exactly `structuredContent` and nothing more. Error results have no data and are left as they are.
 */
function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  const summary = first?.text ?? '';
  return {
    ...result,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}
