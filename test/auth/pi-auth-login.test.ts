import type { Provider as PiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthMethodUnavailableError } from "../../src/auth/login-errors.ts";
import { _loginDeps, resolveLoginTarget } from "../../src/auth/pi-auth.ts";

/**
 * A pi provider is a large structural type and this suite reads four fields of
 * it, so the doubles are built narrow and cast. Widening them would test the
 * cast, not the dispatch.
 */
function piProvider(input: {
  id: string;
  apiKey?: { name: string; withLogin: boolean };
  oauth?: { name: string; loginLabel?: string };
}): PiProvider {
  return {
    id: input.id,
    name: input.id,
    auth: {
      ...(input.apiKey !== undefined
        ? {
            apiKey: {
              name: input.apiKey.name,
              ...(input.apiKey.withLogin ? { login: async () => ({ type: "api_key", key: "k" }) } : {}),
            },
          }
        : {}),
      ...(input.oauth !== undefined
        ? {
            oauth: {
              name: input.oauth.name,
              ...(input.oauth.loginLabel !== undefined ? { loginLabel: input.oauth.loginLabel } : {}),
              login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
            },
          }
        : {}),
    },
  } as unknown as PiProvider;
}

const real = _loginDeps.providers;
afterEach(() => {
  _loginDeps.providers = real;
});

function withProviders(providers: readonly PiProvider[]): void {
  _loginDeps.providers = async () => providers;
}

describe("resolveLoginTarget", () => {
  it("offers oauth for a provider the catalog projection reports as api-key", async () => {
    // openrouter declares both, so toProviderAuth maps it to "api-key". This is
    // the trap: dispatching on the projection would never run its OAuth flow.
    withProviders([
      piProvider({
        id: "openrouter",
        apiKey: { name: "OpenRouter API key", withLogin: true },
        oauth: { name: "OpenRouter OAuth" },
      }),
    ]);

    const target = await resolveLoginTarget("openrouter");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for a provider outside the allowlist", async () => {
    withProviders([
      piProvider({
        id: "anthropic",
        apiKey: { name: "Anthropic API key", withLogin: true },
        oauth: { name: "Anthropic (Claude Pro/Max)" },
      }),
    ]);

    const target = await resolveLoginTarget("anthropic");

    expect(target.oauth).toBeUndefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for github-copilot, whose entry is not cleared", async () => {
    withProviders([
      piProvider({
        id: "github-copilot",
        apiKey: { name: "GitHub token", withLogin: true },
        oauth: { name: "GitHub Copilot" },
      }),
    ]);

    expect((await resolveLoginTarget("github-copilot")).oauth).toBeUndefined();
  });

  it("offers oauth only, for a provider with no api-key auth", async () => {
    withProviders([piProvider({ id: "openai-codex", oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } })]);

    const target = await resolveLoginTarget("openai-codex");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeUndefined();
  });

  it("does not offer an api-key method the provider cannot run interactively", async () => {
    // Ambient-only providers omit `login`; offering one would prompt for a key
    // the provider has no way to accept.
    withProviders([piProvider({ id: "bedrock", apiKey: { name: "AWS profile", withLogin: false } })]);

    expect((await resolveLoginTarget("bedrock")).apiKey).toBeUndefined();
  });

  it("prefers the oauth loginLabel over its name when both exist", async () => {
    withProviders([
      piProvider({ id: "openrouter", oauth: { name: "OpenRouter OAuth", loginLabel: "Sign in with OpenRouter" } }),
    ]);

    expect((await resolveLoginTarget("openrouter")).oauth?.label).toBe("Sign in with OpenRouter");
  });

  it("rejects an unknown provider", async () => {
    withProviders([]);
    await expect(resolveLoginTarget("nope")).rejects.toThrow(AuthMethodUnavailableError);
  });
});
