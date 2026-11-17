import { z } from 'zod/v4';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { ConfigError } from './config-env.js';
import { formatUnknownError } from './errors.js';
import { UNTRUSTED_CONTENT_NOTE } from './dalux/capabilities.js';
import { isToolDisabled, validatePolicyConfig } from './dalux/policy.js';
import {
  DALUX_TOOLS,
  auditRejectedCall,
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
 * environment) and redacts errors with its own secrets only. Instance policy
 * (DALUX_ENABLE_WRITES, DALUX_DISABLED_TOOLS, DALUX_ALLOWED_PROJECT_IDS,
 * DALUX_AUDIT_LOG, ...) and limits are still read from the environment and
 * apply to every instance in the process.
 */

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
}

export interface DaluxGatewayOptions extends Omit<DaluxClientOptions, 'apiKey' | 'baseUrl' | 'credentialEnv'> {
  /** Dalux API key of this instance. Required; never read from the environment. */
  apiKey: string;
  /** Customer-specific Dalux API base URL of this instance. Required; never read from the environment. */
  baseUrl: string;
}

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
  })),
);

function requiredCredential(options: DaluxGatewayOptions, name: 'apiKey' | 'baseUrl'): string {
  const value: unknown = (options as Partial<DaluxGatewayOptions> | undefined)?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createDaluxGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  return value.trim();
}

/**
 * Create one gateway instance. `apiKey` and `baseUrl` are required and are
 * the only credentials the instance uses; a missing value fails here.
 */
export function createDaluxGateway(options: DaluxGatewayOptions) {
  validatePolicyConfig();
  const apiKey = requiredCredential(options, 'apiKey');
  const baseUrl = requiredCredential(options, 'baseUrl');
  const client = new DaluxClient({ ...options, apiKey, baseUrl, credentialEnv: {} });
  const { redactor } = client;

  return {
    /** Tools enabled on this instance (DALUX_DISABLED_TOOLS removes them). */
    tools: daluxGatewayTools.filter(tool => !isToolDisabled(tool.name)),
    async callTool(
      toolName: string,
      input: GatewayJsonObject = {},
      context?: GatewayCallContext,
    ): Promise<GatewayToolResult> {
      try {
        const name = typeof toolName === 'string' ? toolName.trim() : '';
        const tool = name ? findDaluxTool(`dalux_${name.replace(GATEWAY_PREFIX, '')}`) : undefined;
        if (!tool) {
          const reason = `Unsupported Dalux gateway tool: ${String(toolName).slice(0, 100)}`;
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
        );
        const text = tool.returnsDaluxContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
        return jsonResult(text, data);
      } catch (error) {
        return errorResult(formatUnknownError(error, redactor));
      }
    },
  };
}

/** One gateway instance, as returned by createDaluxGateway. */
export type DaluxGateway = ReturnType<typeof createDaluxGateway>;

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
