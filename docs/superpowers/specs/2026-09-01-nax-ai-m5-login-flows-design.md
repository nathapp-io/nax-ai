# M5 — login flows: design

**Status:** approved, not implemented. Plan: not yet written.

## The problem M5 actually solves

nax-ai can *hold* credentials and *use* them. It cannot *obtain* them.

M2 shipped auth wiring and M4 shipped the file-backed `CredentialStore`, but both
milestones assumed a credential already existed — M2's own record says the Codex check
"used a pre-existing pi credential, since M2 does not implement login." The consumer-side
gap is now concrete: nax's Phase A plan 2 is a `nax auth` CLI, and there is nothing in
this package for it to call.

The flows themselves exist one layer down, in pi-ai's `dist/auth/oauth/`
(`openai-codex`, `github-copilot`, `openrouter`, plus `device-code` and `pkce`
helpers). The consumer cannot reach them:

- pi-ai is nax-ai's dependency, not nax's. Reaching it from nax means a direct
  dependency on a transitive package.
- It would put the consumer one call from the prohibited Anthropic flow with no
  allowlist in front of it — the exact risk `src/auth/oauth-policy.ts` was written to
  prevent, and the reason that policy is a gate rather than a convention.

So the flow runner belongs here, behind the gate that already exists.

## Scope

**In:** one `login()` covering both api-key entry and OAuth, gated per method, writing
through the existing `CredentialStore`.

**Out, and recorded so it is not "fixed" later:**

- **No logout.** pi's own auth types define logout *as* deletion — `auth/types.d.ts:77`,
  "Remove a credential (logout). Implementations serialize this against `modify`" — and
  no `revoke` exists anywhere in its auth types or per-provider flows. `CredentialStore.delete`
  is already public and already serializes against `modify`. A `logout()` here would be an
  alias for an existing public method.
- **No credential listing.** `CredentialStore` is `read`/`modify`/`delete` by design.
  A consumer that wants to enumerate reads its own store file; widening this interface to
  serve one CLI subcommand is the wrong direction of dependency.
- **No new provider flows.** The three permitted flows are pi's. nax-ai registers, it does
  not implement.

## The trap: dispatch must not read `ResolvedProvider.auth`

`toProviderAuth` (`src/providers/pi-catalog.ts:29`) projects pi's two auth fields onto one
variant, and **api-key wins when a provider declares both**. That is deliberate and correct
for its purpose: mapping Anthropic to `oauth` would make the allowlist in `normaliseCatalog`
throw and render Anthropic unloadable, when the prohibition is on its subscription OAuth and
never on its API.

It is therefore a lossy projection, and unusable as a login dispatcher:

| provider | pi `apiKey` | pi `oauth` | `ResolvedProvider.auth.kind` |
|:---|:---|:---|:---|
| `openai-codex` | — | yes | `oauth` |
| `github-copilot` | yes | yes | **`api-key`** |
| `openrouter` | yes | yes | **`api-key`** |
| `anthropic` | yes | yes | `api-key` |
| `deepseek` | yes | — | `api-key` |

Two of the three permitted OAuth flows report `api-key`. A `login()` switching on
`ResolvedProvider.auth.kind` would silently never run OAuth for them.

**Dispatch reads pi's own `provider.auth.{apiKey,oauth}`**, inside `src/auth/pi-auth.ts` —
already on the `scripts/check-pi-ai-imports.ts:23` allowlist. The normalised catalog is not
touched; it keeps serving model resolution, which is what it is for.

```
available = {
  api-key: provider.auth.apiKey?.login !== undefined,
  oauth:   provider.auth.oauth !== undefined && isOAuthFlowPermitted(providerId),
}

0 available -> AuthMethodUnavailableError
1 available -> run it
2 available -> prompt `select`, labelled from pi's oauth.loginLabel ?? oauth.name, and apiKey.name
```

`options.method` skips the prompt when the caller already knows which it wants.

## The gate applies per method, not per provider

`anthropic` offers both. Its API-key login stays available; its OAuth option is simply
never offered. That falls out of using the two policy functions for their two different
jobs:

- **`isOAuthFlowPermitted`** (non-throwing) decides what to *offer*.
- **`assertOAuthFlowPermitted`** guards actually *running* a flow, and fires **before any
  loader is touched**, so the allowlist sits in front of pi's lazy bundle rather than
  behind it.

A provider whose only method is a prohibited OAuth flow raises `OAuthFlowProhibitedError`,
not `AuthMethodUnavailableError` — a policy refusal must not read as an absence.

## Public surface

```ts
// src/auth/login-types.ts
export type LoginMethod = "api-key" | "oauth";

export interface LoginOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type LoginPrompt = { readonly signal?: AbortSignal } & (
  | { readonly type: "text";        readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret";      readonly message: string; readonly placeholder?: string }
  | { readonly type: "select";      readonly message: string; readonly options: readonly LoginOption[] }
  | { readonly type: "manual-code"; readonly message: string; readonly placeholder?: string }
);

export interface LoginLink {
  readonly url: string;
  readonly label?: string;
}

export type LoginEvent =
  | { readonly type: "info";        readonly message: string; readonly links?: readonly LoginLink[] }
  | { readonly type: "auth-url";    readonly url: string; readonly instructions?: string }
  | { readonly type: "device-code"; readonly userCode: string; readonly verificationUri: string;
      readonly intervalSeconds?: number; readonly expiresInSeconds?: number }
  | { readonly type: "progress";    readonly message: string };

/**
 * Login interaction, serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered text or, for `select`, the chosen option id.
 * It rejects on cancellation. `LoginPrompt.signal` cancels one pending prompt;
 * `LoginOptions.signal` aborts the whole login.
 */
export interface LoginInteraction {
  prompt(prompt: LoginPrompt): Promise<string>;
  notify(event: LoginEvent): void;
}

export interface LoginOptions {
  readonly providerId: ProviderId;
  readonly credentials: CredentialStore;
  readonly interaction: LoginInteraction;
  /** Skips the method prompt. Throws if the named method is unavailable. */
  readonly method?: LoginMethod;
  readonly signal?: AbortSignal;
}

export interface LoginResult {
  readonly providerId: ProviderId;
  readonly method: LoginMethod;
  readonly kind: StoredCredential["kind"];
}

// src/auth/login.ts
export function login(options: LoginOptions): Promise<LoginResult>;
```

### Why the result carries no credential

`LoginResult` is metadata. It is enough for a CLI to report *"Logged in to openrouter
(OAuth)"*, and the store already holds the secret; returning it would create a second copy
with no consumer. `StoredCredential.key` is documented as opaque and never to be inspected,
compared or logged — a caller that cannot obtain the secret cannot leak it.

### Why the names change at the boundary

pi's `auth_url` / `device_code` / `manual_code` / `api_key` become `auth-url` /
`device-code` / `manual-code` / `api-key`, matching `ProtocolError.kind`'s existing
`rate-limit` and `bad-request`. The translation *is* the boundary: it is what keeps a
rename in pi from becoming a breaking change here, and it is the same discipline
`src/protocols/` already applies.

## Storage

The credential is written through `credentials.modify(providerId, async () => next)` —
never a bare write — so login inherits the cross-process lock that `createFileCredentialStore`
holds. Two nax invocations logging in to the same provider serialize, as OAuth refresh
already does.

`fromPi()` (`src/auth/pi-auth.ts:29`) already maps both pi credential shapes onto
`StoredCredential` and is tested. M5 reuses it rather than adding a second mapping that
could drift from the first.

**One correction on that path.** `fromPi` maps `key: credential.key ?? ""` (line 34). For a
*read* that is right — an absent key means "not configured". On the login path an empty key
means the flow returned nothing usable, and storing `""` yields a credential that looks
present and fails at call time, in a place with no connection to the login that caused it.
M5 rejects an empty api-key credential rather than storing it.

## Errors

| Condition | Error |
|:---|:---|
| Prohibited flow reached | `OAuthFlowProhibitedError` (exists) |
| No usable login method | `AuthMethodUnavailableError` (new) |
| `options.method` names an unavailable method | `AuthMethodUnavailableError` |
| User cancelled a prompt, or `signal` aborted | `LoginCancelledError` (new) |
| Flow returned an empty api-key | `LoginFailedError` (new) |

Cancellation is its own error so a consumer can exit quietly on Ctrl-C rather than
reporting a failure the user caused deliberately.

## Module layout and gates

| File | Contents | Imports pi? |
|:---|:---|:---|
| `src/auth/login-types.ts` | the vocabulary above | no |
| `src/auth/login.ts` | `login()`, dispatch, gating, storage | no |
| `src/auth/pi-auth.ts` | flow lookup, interaction adaptation, `fromPi` | **yes** (already allowlisted) |

`scripts/check-pi-ai-imports.ts` needs **no change** — `src/auth/pi-auth.ts` is already on
its allowlist (line 23), and `login.ts` reaching pi directly would fail the gate, which is
the intended outcome.

`scripts/check-no-bun-apis.ts` applies as everywhere: no `Bun.*` in `src/`.

New exports from `src/index.ts`: `login`, the `Login*` types, and the two new error classes.

## Testing

The real flows spawn a loopback HTTP server and open a browser, so they are not
fixture-recordable the way `test/protocols/` is. Coverage is unit-level against injected
doubles through a `_loginDeps` seam in `pi-auth.ts`, following the `PiDeps` precedent M1
set and M3 used rather than inventing a second injection style.

What the tests must pin, because each is a way the design fails silently:

- `github-copilot` and `openrouter` offer OAuth **despite** `ResolvedProvider.auth.kind`
  reporting `api-key` — the trap this design exists to avoid, asserted directly.
- `anthropic` offers api-key and **not** OAuth, and no loader is touched while deciding.
- A provider whose only flow is prohibited raises `OAuthFlowProhibitedError`, not
  `AuthMethodUnavailableError`.
- The stored credential is written through `modify`, not a bare write.
- An empty api-key credential is rejected rather than stored.
- Cancellation surfaces as `LoginCancelledError`.

One manual live verification against `openrouter`, recorded in the plan the way M2 recorded
its `DEEPSEEK_API_KEY` probe. `openrouter` because it is the one permitted flow that is not
a consumer subscription.

## Consumer sketch

What nax's plan 2 becomes, once this exists:

```ts
await login({
  providerId,
  credentials: createFileCredentialStore({ path: `${homedir()}/.nax/credentials` }),
  interaction: terminalInteraction(),   // prompts + spinner, nax's own
});
```

`nax auth rm` calls `credentials.delete(providerId)` directly and needs nothing from M5.

**A wording constraint that belongs to the consumer, recorded here because this design is
why it holds:** since nothing is revoked, removing a credential leaves a live token at the
provider until it expires — for `openai-codex` and `github-copilot`, a subscription token.
`nax auth rm` must therefore not report "logged out". It removed a local credential, and
for OAuth it should point the user at the provider's own revocation page.

## Open questions

1. **`github-copilot` carries `isSubscription: true`.** The allowlist admits providers
   "whose terms permit third-party OAuth use, or whose flow is a first-party developer
   credential rather than a consumer subscription" — and that flag sits in tension with the
   second clause. The entry predates this design and is being kept; it is recorded here
   because M5 is what makes it one command away, and it deserves a terms check before the
   consumer CLI ships rather than after.
2. **Does `login()` belong on `Client`?** It is currently a free function, because logging
   in needs a credential store and a provider table but not a configured client, and
   requiring one would make `nax auth login` construct a catalog it never uses. Revisit
   only if a second consumer wants it on the client.
3. **Bundle verification.** pi loads flows through a deliberately bundler-opaque dynamic
   import (`auth/helpers.d.ts`, `lazyOAuth`), so they resolve from `node_modules` at
   runtime rather than being bundled. nax builds with `bun build --target bun` and keeps
   nax-ai as a runtime dependency, so this should hold — but the consumer's plan should
   verify a login from built output, not only from source.
