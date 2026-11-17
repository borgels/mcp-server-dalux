import { z } from 'zod/v4';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { ConfigError } from './config-env.js';
import { formatUnknownError, redactDeep, SecretRedactor } from './errors.js';
import { admitsKey, keyRefusedText } from './key-admission.js';
import { UNTRUSTED_CONTENT_NOTE } from './dalux/capabilities.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  validatePolicyConfig,
  type DaluxInstancePolicy,
} from './dalux/policy.js';
import { fileTarget, hostTarget, type ExportDelivery } from './export/delivery.js';
import { getExportConfig } from './export/config.js';
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

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
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
  const apiKey = requiredCredential(options, 'apiKey');
  // Every error from here on leaves through the instance's redactor, as the very last step: a fixed text of ours
  // or a configuration value can hold the key.
  const guard = new SecretRedactor().addSecret(apiKey);
  try {
    return buildDaluxGateway(options, apiKey);
  } catch (error) {
    const message = guard.redact(error instanceof Error ? error.message : String(error));
    throw error instanceof ConfigError ? new ConfigError(message) : new Error(message);
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
          result => JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
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
      return errorResult(formatUnknownError(error, redactor));
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

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
