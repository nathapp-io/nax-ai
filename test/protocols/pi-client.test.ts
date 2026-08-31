import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiProtocol, toPiContext, toPiOptions } from "../../src/protocols/pi-client.ts";
import type { ProtocolRequest } from "../../src/protocols/types.ts";

// biome-ignore lint/suspicious/noExportsInTest: Task 6's conformance suite imports these helpers from this file.
export const MODEL: Model<Api> = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 8000,
};

/** Records what the protocol handed pi-ai, and replays scripted events. */
// biome-ignore lint/suspicious/noExportsInTest: Task 6's conformance suite imports this helper from this file.
export function fakePi(events: AssistantMessageEvent[]) {
  const calls: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
  return {
    calls,
    deps: {
      resolveModel: async () => MODEL,
      stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
}

const BASE: ProtocolRequest = { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] };

describe("toPiContext", () => {
  it("puts system in systemPrompt, never in messages", () => {
    const context = toPiContext({ ...BASE, system: "be terse" }, MODEL);
    expect(context.systemPrompt).toBe("be terse");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
  });

  it("omits systemPrompt when absent rather than sending an empty string", () => {
    expect(toPiContext(BASE, MODEL).systemPrompt).toBeUndefined();
  });

  it("maps an assistant turn with tool calls onto pi content blocks", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "user", content: "read a.ts" },
          { role: "assistant", content: "on it", toolCalls: [{ id: "t1", name: "read", input: { path: "a.ts" } }] },
          { role: "tool-result", toolCallId: "t1", content: "contents" },
        ],
      },
      MODEL,
    );

    const assistant = context.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant).toMatchObject({
      content: [
        { type: "text", text: "on it" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
      ],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("recovers toolName for a tool result from the call that produced it", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] },
          { role: "tool-result", toolCallId: "t1", content: "ok", isError: true },
        ],
      },
      MODEL,
    );

    expect(context.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("throws on a tool result with no matching call, rather than sending an empty name", () => {
    expect(() =>
      toPiContext({ ...BASE, messages: [{ role: "tool-result", toolCallId: "ghost", content: "ok" }] }, MODEL),
    ).toThrow(/ghost/);
  });

  it("omits an empty assistant text block", () => {
    const context = toPiContext(
      { ...BASE, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] }] },
      MODEL,
    );
    expect(context.messages[0]).toMatchObject({ content: [{ type: "toolCall", id: "t1" }] });
  });
});

describe("toPiOptions", () => {
  it("forwards the neutral options under pi's names", () => {
    const options = toPiOptions({
      ...BASE,
      toolChoice: "none",
      maxTokens: 100,
      temperature: 0.5,
      cacheRetention: "long",
    });
    expect(options).toMatchObject({ toolChoice: "none", maxTokens: 100, temperature: 0.5, cacheRetention: "long" });
  });

  it("maps thinking onto reasoning", () => {
    expect(toPiOptions({ ...BASE, thinking: "high" }).reasoning).toBe("high");
  });

  it("omits reasoning entirely when thinking is off, since pi has no off level", () => {
    expect("reasoning" in toPiOptions({ ...BASE, thinking: "off" })).toBe(false);
  });

  it("omits every optional field that was not supplied", () => {
    expect(toPiOptions(BASE)).toEqual({});
  });
});

describe("createPiProtocol", () => {
  it("exposes the protocol name it was registered under", () => {
    expect(createPiProtocol("openai-completions", fakePi([]).deps).name).toBe("openai-completions");
  });

  it("resolves the model and calls pi-ai once with the translated request", async () => {
    const pi = fakePi([]);
    const protocol = createPiProtocol("openai-completions", pi.deps);
    for await (const _ of protocol.stream({ ...BASE, system: "be terse" })) {
      // drain
    }
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0]?.model.id).toBe("deepseek-chat");
    expect(pi.calls[0]?.context.systemPrompt).toBe("be terse");
  });
});
