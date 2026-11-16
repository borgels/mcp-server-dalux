import { z } from 'zod/v4';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { formatUnknownError } from './errors.js';
import { UNTRUSTED_CONTENT_NOTE } from './dalux/capabilities.js';
import {
  DALUX_TOOLS,
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

function gatewayInputSchema(tool: DaluxToolDefinition): z.ZodObject {
  return z.strictObject(tool.inputShape);
}

function toGatewayJsonSchema(tool: DaluxToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(gatewayInputSchema(tool), { io: 'input' }) as Record<
    string,
    unknown
  >;
  return schema as GatewayJsonObject;
}

export const daluxGatewayTools: GatewayToolDefinition[] = DALUX_TOOLS.map(tool => ({
  name: tool.name.replace(GATEWAY_PREFIX, ''),
  title: tool.title,
  description: tool.description,
  riskLevel: tool.annotations.readOnlyHint ? 'read' : 'write',
  enabledByDefault: tool.annotations.readOnlyHint,
  inputSchema: toGatewayJsonSchema(tool),
}));

export function createDaluxGateway(options: DaluxGatewayOptions = {}) {
  const client = new DaluxClient(options);

  return {
    tools: daluxGatewayTools,
    async callTool(
      toolName: string,
      input: GatewayJsonObject = {},
      context?: GatewayCallContext,
    ): Promise<GatewayToolResult> {
      const tool = findDaluxTool(`dalux_${toolName.replace(GATEWAY_PREFIX, '')}`);
      if (!tool) {
        return errorResult(`Unsupported Dalux gateway tool: ${toolName}`);
      }

      const parsed = gatewayInputSchema(tool).safeParse(input ?? {});
      if (!parsed.success) {
        return errorResult(`Invalid input for ${toolName}: ${z.prettifyError(parsed.error)}`);
      }

      try {
        const data = await executeDaluxTool(tool, client, parsed.data as Record<string, unknown>, context);
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
