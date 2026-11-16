import { z } from 'zod/v4';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
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
} from './tools/dalux.js';

/**
 * Embeddable entry point: an embedding host (for example an MCP gateway
 * that does its own per-user authorization) lists `tools` and invokes
 * `callTool`. Tool definitions, input validation, instance policy and audit
 * are shared with the MCP server in src/tools/dalux.ts.
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

export interface DaluxGatewayOptions extends DaluxClientOptions {}

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
export const daluxGatewayTools: GatewayToolDefinition[] = DALUX_TOOLS.map(tool => ({
  name: tool.name.replace(GATEWAY_PREFIX, ''),
  title: tool.title,
  description: tool.description,
  riskLevel: tool.annotations.readOnlyHint ? 'read' : 'write',
  enabledByDefault: tool.annotations.readOnlyHint,
  inputSchema: toGatewayJsonSchema(tool),
}));

export function createDaluxGateway(options: DaluxGatewayOptions = {}) {
  validatePolicyConfig();
  const client = new DaluxClient(options);

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
          return errorResult(reason);
        }

        const parsed = tool.inputSchema.safeParse(input ?? {});
        if (!parsed.success) {
          const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
          await auditRejectedCall(tool.name, input, 'invalid input', context);
          return errorResult(reason);
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
        return errorResult(formatUnknownError(error));
      }
    },
  };
}

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
