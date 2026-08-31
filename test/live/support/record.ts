import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PiDeps, PiResponse } from "../../../src/protocols/pi-client.ts";
import type { ProtocolEvent } from "../../../src/protocols/types.ts";
import { HEADER_ALLOWLIST, type RecordedMeta } from "../../support/fixture-types.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "recorded");

function filterHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = new Set<string>(HEADER_ALLOWLIST);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => allowed.has(k.toLowerCase())));
}

/**
 * Wraps PiDeps to capture what pi actually sent, at the seam the mapper reads
 * from. Recording the mapper's OUTPUT instead — which is what M2 did — cannot
 * catch a mapping regression: a wrong mapping would simply be re-recorded as
 * the new expectation.
 */
export function recordingDeps(
  inner: PiDeps,
  meta: Omit<RecordedMeta, "recordedAt">,
): { deps: PiDeps; write: (name: string) => void } {
  const events: AssistantMessageEvent[] = [];
  let response: PiResponse = { status: 0, headers: {} };

  const deps: PiDeps = {
    resolveModel: inner.resolveModel,
    stream: (model, context, options, onResponse) =>
      (async function* () {
        for await (const event of inner.stream(model, context, options, (r) => {
          response = { status: r.status, headers: filterHeaders(r.headers) };
          onResponse(r);
        })) {
          events.push(event);
          yield event;
        }
      })(),
  };

  const write = (name: string): void => {
    const file = join(DIR, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    const body = {
      meta: { ...meta, recordedAt: new Date().toISOString().slice(0, 10) },
      response,
      events,
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  };

  return { deps, write };
}

/**
 * Writes a live run's event sequence to disk so M3 can build its fixture suite
 * from real provider output rather than from scripted guesses.
 * Retained for compatibility with live tests that record at the protocol level.
 */
export function record(name: string, events: readonly ProtocolEvent[]): void {
  const file = join(DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}
