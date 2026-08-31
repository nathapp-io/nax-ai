/**
 * Contract every Protocol backend must satisfy.
 *
 * Run against each registered backend. A hand-written backend inherits these
 * the day it is created, which is what keeps "replace a protocol" a bounded
 * task rather than an open-ended one.
 *
 * Assertions here are sequence invariants, never provider content: model output
 * varies between runs and is not assertable.
 */

import { describe, expect, it } from "vitest";
import type { Protocol, ProtocolEvent } from "../../src/protocols/types.ts";

export interface ConformanceCase {
  readonly name: string;
  readonly request: Parameters<Protocol["stream"]>[0];
}

async function drain(protocol: Protocol, req: ConformanceCase["request"]): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const event of protocol.stream(req)) events.push(event);
  return events;
}

export function runProtocolConformance(
  suiteName: string,
  makeProtocol: () => Promise<Protocol>,
  cases: { readonly text: ConformanceCase; readonly tool?: ConformanceCase },
): void {
  describe(`${suiteName} conformance`, () => {
    it("exposes a non-empty name", async () => {
      const protocol = await makeProtocol();
      expect(protocol.name).toBeTruthy();
    });

    it("ends with exactly one done event, and it is last", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const doneIndexes = events.flatMap((e, i) => (e.type === "done" ? [i] : []));
      expect(doneIndexes).toHaveLength(1);
      expect(doneIndexes[0]).toBe(events.length - 1);
    });

    it("emits usage before done", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const usageIndex = events.findIndex((e) => e.type === "usage");
      const doneIndex = events.findIndex((e) => e.type === "done");
      expect(usageIndex).toBeGreaterThanOrEqual(0);
      expect(usageIndex).toBeLessThan(doneIndex);
    });

    it("emits at least one text delta for a text request", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(events.some((e) => e.type === "text-delta")).toBe(true);
    });

    it("reports non-negative token counts", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      if (usage?.type !== "usage") throw new Error("unreachable");
      expect(usage.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(usage.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it("emits no events after an error", async () => {
      // An error is terminal for the stream even though it is an event.
      const events = await drain(await makeProtocol(), cases.text.request);
      const errorIndex = events.findIndex((e) => e.type === "error");
      if (errorIndex >= 0) expect(errorIndex).toBe(events.length - 1);
    });

    if (cases.tool !== undefined) {
      const toolCase = cases.tool;

      it("emits parsed tool calls, never raw strings", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const calls = events.filter((e) => e.type === "tool-call");
        expect(calls.length).toBeGreaterThan(0);
        for (const event of calls) {
          if (event.type !== "tool-call") throw new Error("unreachable");
          expect(typeof event.call.input).not.toBe("string");
          expect(event.call.id).toBeTruthy();
          expect(event.call.name).toBeTruthy();
        }
      });

      it("emits any tool-call-partial before the matching tool-call", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const firstFinal = events.findIndex((e) => e.type === "tool-call");
        const lastPartial = events.map((e) => e.type).lastIndexOf("tool-call-partial");
        if (lastPartial >= 0) expect(lastPartial).toBeLessThan(firstFinal);
      });

      it("reports stopReason tool_use when tool calls were emitted", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const done = events.at(-1);
        if (done?.type !== "done") throw new Error("stream did not end with done");
        expect(done.stopReason).toBe("tool_use");
      });
    }
  });
}
