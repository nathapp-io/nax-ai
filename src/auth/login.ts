/**
 * Obtaining a credential, as opposed to holding or using one.
 *
 * This module never imports pi-ai: every provider-specific step is behind a
 * LoginRunner that pi-auth.ts resolved. The credential is written to the
 * caller's store before this returns, and never handed back.
 */

import type { StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError } from "./login-errors.ts";
import type { LoginMethod, LoginOptions, LoginResult } from "./login-types.ts";
import { type LoginRunner, resolveLoginTarget } from "./pi-auth.ts";

/** Test seam. */
export const _resolveTarget = { resolve: resolveLoginTarget };

export async function login(options: LoginOptions): Promise<LoginResult> {
  const { providerId, credentials, interaction, signal } = options;
  const target = await _resolveTarget.resolve(providerId);

  const available: { method: LoginMethod; runner: LoginRunner }[] = [];
  if (target.apiKey !== undefined) available.push({ method: "api-key", runner: target.apiKey });
  if (target.oauth !== undefined) available.push({ method: "oauth", runner: target.oauth });

  const chosen = available[0];
  if (chosen === undefined) throw new AuthMethodUnavailableError(providerId);

  const credential: StoredCredential = await chosen.runner.run(interaction, signal ?? new AbortController().signal);

  // modify, never a bare write: it is what holds the store's lock across the
  // whole read-modify-write.
  await credentials.modify(providerId, async () => credential);

  return { providerId, method: chosen.method, kind: credential.kind };
}
