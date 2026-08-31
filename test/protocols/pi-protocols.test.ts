import { describe, expect, it } from "vitest";
import { PI_PROTOCOL_NAMES, piProtocols } from "../../src/protocols/pi-protocols.ts";
import { createRegistry } from "../../src/protocols/registry.ts";

describe("piProtocols", () => {
  it("registers exactly the four pi-backed protocols", () => {
    expect(Object.keys(piProtocols()).sort()).toEqual([...PI_PROTOCOL_NAMES].sort());
  });

  it("registers each protocol under the pi backend only", () => {
    for (const backends of Object.values(piProtocols())) {
      expect(Object.keys(backends)).toEqual(["pi"]);
    }
  });

  it("passes registry validation with the default selection", () => {
    expect(() => createRegistry(piProtocols(), {}).validate()).not.toThrow();
  });

  it("still rejects a native selection, because no native backend exists yet", () => {
    expect(() => createRegistry(piProtocols(), { default: "native" }).validate()).toThrow();
  });

  it("names each resolved protocol after its registry key", async () => {
    const registry = createRegistry(piProtocols(), {});
    for (const name of PI_PROTOCOL_NAMES) {
      expect((await registry.resolve(name)).name).toBe(name);
    }
  });
});
