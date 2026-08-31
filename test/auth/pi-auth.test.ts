import { describe, expect, it } from "vitest";
import { createPiAuthResolver, toPiCredentialStore } from "../../src/auth/pi-auth.ts";
import type { CredentialStore, StoredCredential } from "../../src/types.ts";

function memoryStore(initial: Record<string, StoredCredential> = {}): CredentialStore {
  const data = new Map(Object.entries(initial));
  return {
    read: async (id) => data.get(id),
    modify: async (id, fn) => {
      const next = await fn(data.get(id));
      if (next === undefined) data.delete(id);
      else data.set(id, next);
      return next;
    },
    delete: async (id) => {
      data.delete(id);
    },
  };
}

describe("toPiCredentialStore", () => {
  it("presents an api-key credential in pi's shape", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } }));
    expect(await pi.read("deepseek")).toEqual({ type: "api_key", key: "sk-1" });
  });

  it("presents an oauth credential in pi's shape", async () => {
    const pi = toPiCredentialStore(
      memoryStore({ "openai-codex": { kind: "oauth", access: "a", refresh: "r", expires: 42 } }),
    );
    expect(await pi.read("openai-codex")).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 42 });
  });

  it("round-trips env through modify without dropping it", async () => {
    const store = memoryStore({
      cloudflare: { kind: "api-key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } },
    });
    const pi = toPiCredentialStore(store);

    await pi.modify("cloudflare", async (current) => {
      expect(current).toEqual({ type: "api_key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } });
      return current;
    });

    expect(await store.read("cloudflare")).toEqual({
      kind: "api-key",
      key: "$CF_KEY",
      env: { CF_ACCOUNT: "acct-1" },
    });
  });

  it("treats key as opaque and never rewrites a template", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "!op read op://x/y" } }));
    expect((await pi.read("deepseek"))?.key).toBe("!op read op://x/y");
  });

  it("resolves undefined for a provider with no credential", async () => {
    expect(await toPiCredentialStore(memoryStore()).read("nope")).toBeUndefined();
  });

  it("deletes through to the underlying store", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).delete("deepseek");
    expect(await store.read("deepseek")).toBeUndefined();
  });

  it("supports removing a credential by returning undefined from modify", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).modify("deepseek", async () => undefined);
    expect(await store.read("deepseek")).toBeUndefined();
  });

  it("enumerates nothing, because nax-ai does not own account listing", async () => {
    expect(await toPiCredentialStore(memoryStore({ a: { kind: "api-key", key: "k" } })).list()).toEqual([]);
  });
});

describe("createPiAuthResolver", () => {
  /** Stands in for pi-ai's Models, which is the only part of it we call. */
  function fakeModels(result: unknown) {
    return { getAuth: async () => result } as unknown as Parameters<typeof createPiAuthResolver>[0];
  }

  it("returns the resolved api key for a provider", async () => {
    const resolver = createPiAuthResolver(fakeModels({ auth: { apiKey: "sk-live" } }));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({ apiKey: "sk-live" });
  });

  it("forwards resolved headers and drops the nulls pi uses to suppress defaults", async () => {
    const resolver = createPiAuthResolver(
      fakeModels({ auth: { headers: { authorization: "Bearer t", "x-drop": null } } }),
    );
    expect(await resolver.resolve({ provider: "openai-codex", model: "gpt-5.4" })).toEqual({
      headers: { authorization: "Bearer t" },
    });
  });

  it("resolves empty for an unconfigured provider rather than throwing", async () => {
    const resolver = createPiAuthResolver(fakeModels(undefined));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({});
  });
});
