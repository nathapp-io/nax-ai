import { afterEach, describe, expect, it, vi } from "vitest";
import { _resolveTarget, login } from "../../src/auth/login.ts";
import { AuthMethodUnavailableError } from "../../src/auth/login-errors.ts";
import type { LoginInteraction } from "../../src/auth/login-types.ts";
import type { LoginTarget } from "../../src/auth/pi-auth.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";

const real = _resolveTarget.resolve;
afterEach(() => {
  _resolveTarget.resolve = real;
});

function withTarget(target: LoginTarget): void {
  _resolveTarget.resolve = async () => target;
}

/** Fails the test if the flow tries to interact; individual tests override it. */
const silent: LoginInteraction = {
  prompt: async () => {
    throw new Error("no prompt expected");
  },
  notify: () => {},
};

describe("login", () => {
  it("runs the only available method and stores the credential", async () => {
    withTarget({
      apiKey: { label: "Acme API key", run: async () => ({ kind: "api-key", key: "sk-live" }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result).toEqual({ providerId: "acme", method: "api-key", kind: "api-key" });
    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-live" });
  });

  it("runs the only available method when it is oauth", async () => {
    withTarget({
      oauth: { label: "Acme OAuth", run: async () => ({ kind: "oauth", access: "a", refresh: "r", expires: 9 }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result.method).toBe("oauth");
    expect(result.kind).toBe("oauth");
    expect(await credentials.read("acme")).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 9 });
  });

  it("writes through modify, so the store's lock covers the write", async () => {
    // A bare write would bypass the cross-process lock that makes concurrent
    // logins and OAuth refreshes safe.
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk" }) } });
    const credentials = createMemoryCredentialStore();
    const modify = vi.spyOn(credentials, "modify");

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(modify).toHaveBeenCalledWith("acme", expect.any(Function));
  });

  it("overwrites an existing credential for the provider", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-new" }) } });
    const credentials = createMemoryCredentialStore({ acme: { kind: "api-key", key: "sk-old" } });

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-new" });
  });

  it("does not return the credential", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-secret" }) } });

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent });

    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("rejects a provider with no usable method", async () => {
    withTarget({});
    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });
});
