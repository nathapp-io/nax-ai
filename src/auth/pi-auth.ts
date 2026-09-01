/**
 * pi-ai's side of auth: a credential-store adapter and an AuthResolver.
 *
 * On the ALLOWED list in scripts/check-pi-ai-imports.ts. Nothing here leaks a
 * pi-ai type through an export a consumer sees.
 */

import type {
  Credential,
  MutableModels,
  AuthEvent as PiAuthEvent,
  AuthPrompt as PiAuthPrompt,
  CredentialStore as PiCredentialStore,
  Provider as PiProvider,
} from "@earendil-works/pi-ai";
import type { CredentialStore, ModelRef, ProviderId, StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError, LoginFailedError } from "./login-errors.ts";
import type { LoginInteraction } from "./login-types.ts";
import { assertOAuthFlowPermitted, isOAuthFlowPermitted } from "./oauth-policy.ts";
import type { AuthResolver, ResolvedAuth } from "./resolver.ts";

function toPi(credential: StoredCredential | undefined): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "api-key") {
    return {
      type: "api_key",
      key: credential.key,
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

function fromPi(credential: Credential | undefined): StoredCredential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "api_key") {
    return {
      kind: "api-key",
      key: credential.key ?? "",
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    kind: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

export function toPiCredentialStore(store: CredentialStore): PiCredentialStore {
  return {
    read: async (providerId) => toPi(await store.read(providerId)),

    // modify stays a single read-modify-write so the underlying store can hold
    // a lock across the whole operation. pi-ai runs OAuth refresh inside it.
    modify: async (providerId, fn) =>
      toPi(
        await store.modify(providerId, async (current) => {
          const next = await fn(toPi(current));
          // pi's modify contract treats an undefined return as "leave the
          // entry unchanged" — its OAuth refresh returns that when a
          // concurrent caller already rotated the token. nax-ai's undefined
          // means "remove", so the no-op is translated to the current
          // credential, never propagated; removal goes through delete().
          return next === undefined ? current : fromPi(next);
        }),
      ),

    delete: async (providerId) => {
      await store.delete(providerId);
    },

    // pi-ai requires `list` for account and status enumeration. nax-ai's
    // CredentialStore has no equivalent and nax-ai never enumerates accounts:
    // that belongs to login and logout, which are out of scope for M2. An
    // empty list is what "this store does not enumerate" looks like, and it is
    // only ever read by UI that nax-ai does not have.
    list: async () => [],
  };
}

export function createPiAuthResolver(models: MutableModels): AuthResolver {
  return {
    async resolve(ref: ModelRef): Promise<ResolvedAuth> {
      const result = await models.getAuth(ref.provider);
      const auth = result?.auth;
      if (auth === undefined) return {};
      return {
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined
          ? {
              headers: Object.fromEntries(
                Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
              ),
            }
          : {}),
      };
    },
  };
}

export interface LoginRunner {
  /** Shown in the method prompt when a provider offers both. */
  readonly label: string;
  run(interaction: LoginInteraction, signal: AbortSignal): Promise<StoredCredential>;
}

export interface LoginTarget {
  readonly apiKey?: LoginRunner;
  readonly oauth?: LoginRunner;
}

/**
 * Test seam. The real read is a dynamic import because pi-ai's provider table
 * is large and only login needs it, matching pi-catalog.ts's own pattern.
 */
export const _loginDeps = {
  providers: async (): Promise<readonly PiProvider[]> => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    return builtinProviders();
  },
};

function required(credential: Credential, providerId: ProviderId): StoredCredential {
  const stored = fromPi(credential);
  if (stored === undefined) throw new LoginFailedError(providerId, "the flow returned no credential");
  return stored;
}

/**
 * Resolves which logins a provider can actually run.
 *
 * Reads pi's own two auth fields, NOT ResolvedProvider.auth: toProviderAuth
 * resolves api-key over oauth when a provider declares both, which hides
 * openrouter's OAuth flow (wrong) and anthropic's (right) indistinguishably.
 *
 * The allowlist is applied per method, not per provider, so a provider with a
 * disallowed OAuth flow keeps its api-key login.
 */
export async function resolveLoginTarget(providerId: ProviderId): Promise<LoginTarget> {
  const provider = (await _loginDeps.providers()).find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new AuthMethodUnavailableError(providerId);

  const target: { apiKey?: LoginRunner; oauth?: LoginRunner } = {};

  const apiKeyAuth = provider.auth.apiKey;
  if (apiKeyAuth?.login !== undefined) {
    // bind rather than call detached: pi's flows are object methods and may
    // read `this`.
    const run = apiKeyAuth.login.bind(apiKeyAuth);
    target.apiKey = {
      label: apiKeyAuth.name,
      run: async (interaction, signal) => required(await run({ ...toPiInteraction(interaction), signal }), providerId),
    };
  }

  const oauthAuth = provider.auth.oauth;
  if (oauthAuth !== undefined && isOAuthFlowPermitted(providerId)) {
    const run = oauthAuth.login.bind(oauthAuth);
    target.oauth = {
      label: oauthAuth.loginLabel ?? oauthAuth.name,
      run: async (interaction, signal) => {
        // Before the loader is touched, not after: pi bundles every flow behind
        // one lazy loader, so the gate must sit in front of it.
        assertOAuthFlowPermitted(providerId);
        return required(await run({ ...toPiInteraction(interaction), signal }), providerId);
      },
    };
  }

  return target;
}

function toPiInteraction(_interaction: LoginInteraction): {
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
} {
  throw new Error("toPiInteraction is implemented in Task 4");
}
