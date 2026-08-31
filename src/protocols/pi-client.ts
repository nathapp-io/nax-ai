/**
 * The pi-ai-backed protocol.
 *
 * This file and the two other files on the ALLOWED list in
 * scripts/check-pi-ai-imports.ts are the only places pi-ai may be imported.
 * Nothing exported here may expose a pi-ai type in a shape a consumer sees.
 *
 * One implementation serves all four protocols. They differ only in where a
 * system prompt sits in the wire request, and pi-ai's Context carries it in a
 * dedicated field, so on this path the difference does not exist. The protocol
 * name is still a parameter because a per-api quirk would branch on it.
 */

import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Message as PiMessage,
  Tool as PiTool,
  Usage as PiUsage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversationMessage, Protocol, ProtocolEvent, ProtocolRequest } from "./types.ts";

export type PiStreamFn = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiDeps {
  readonly resolveModel: (modelId: string) => Promise<Model<Api>>;
  readonly stream: PiStreamFn;
}

/**
 * pi-ai's Message requires a timestamp, but no wire module under its api/
 * directory reads one. A constant keeps translation deterministic; Date.now()
 * would make tests flap over a field that is never sent.
 */
const NO_TIMESTAMP = 0;

/** Placeholder accounting for a replayed assistant turn. Never sent upstream. */
const NO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toPiTool(tool: ProtocolRequest["tools"] extends readonly (infer T)[] | undefined ? T : never): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // pi-ai types this as a TypeBox TSchema, which is a JSON Schema object at
    // runtime. nax-ai does not validate schemas; it forwards what it was given.
    parameters: tool.inputSchema as PiTool["parameters"],
  };
}

function toPiMessages(messages: readonly ConversationMessage[], model: Model<Api>): PiMessage[] {
  const toolNames = new Map<string, string>();
  const out: PiMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content, timestamp: NO_TIMESTAMP });
      continue;
    }

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      out.push({
        role: "assistant",
        content: [
          ...(message.content === "" ? [] : [{ type: "text" as const, text: message.content }]),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: (call.input ?? {}) as Record<string, unknown>,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: NO_USAGE,
        stopReason: "stop",
        timestamp: NO_TIMESTAMP,
      });
      continue;
    }

    // toolName is not on our ConversationMessage but is read on the wire by
    // several providers, so it is recovered from the call that produced this
    // result. No match means the caller assembled an impossible conversation.
    const toolName = toolNames.get(message.toolCallId);
    if (toolName === undefined) {
      throw new Error(
        `Tool result references tool call "${message.toolCallId}", which no earlier assistant message made.`,
      );
    }

    out.push({
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName,
      content: [{ type: "text", text: message.content }],
      isError: message.isError ?? false,
      timestamp: NO_TIMESTAMP,
    });
  }

  return out;
}

export function toPiContext(req: ProtocolRequest, model: Model<Api>): Context {
  return {
    ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
    messages: toPiMessages(req.messages, model),
    ...(req.tools !== undefined ? { tools: req.tools.map(toPiTool) } : {}),
  };
}

export function toPiOptions(req: ProtocolRequest): SimpleStreamOptions {
  return {
    ...(req.toolChoice !== undefined ? { toolChoice: req.toolChoice } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.cacheRetention !== undefined ? { cacheRetention: req.cacheRetention } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
    // pi-ai's scale has no "off": the absence of the field is how thinking is
    // disabled, so mapping "off" to a value would silently enable it.
    ...(req.thinking !== undefined && req.thinking !== "off" ? { reasoning: req.thinking } : {}),
  };
}

export function createPiProtocol(name: string, deps: PiDeps): Protocol {
  return {
    name,

    // biome-ignore lint/correctness/useYield: event mapping arrives in Task 4; until then the stream consumes without yielding.
    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      const model = await deps.resolveModel(req.model);
      const events = deps.stream(model, toPiContext(req, model), toPiOptions(req));

      for await (const _event of events) {
        // Event mapping arrives in Task 4.
      }
    },
  };
}

/**
 * Temporary legacy stub. The four protocol index.ts files still import
 * createPiClient; without it they fail typecheck. Task 6 deletes those four
 * directories and this export in the same commit. Behaviour is unchanged from
 * the stub it sat beside: resolving a pi backend throws.
 */
export async function createPiClient(_protocolName: string): Promise<never> {
  throw new Error(
    "createPiClient is not implemented yet — see Task 6 notes. Backends are testable via injection in the meantime.",
  );
}
