/**
 * Whose data the browser is showing right now.
 *
 * Sign-in, sign-out and account switches all happen while requests are in
 * flight. Anything that awaits (a profile pull, a history load, a debounced
 * save) captured nothing about who asked, so a response for account A could
 * land after B signed in: A's voice preference was saved into B's profile, and
 * a chat kept in A's local history was uploaded under B's token.
 *
 * `claim()` records the owner at the moment work is scheduled; `stillOwns()`
 * says whether that owner is still the current one. Every account switch bumps
 * the epoch, so even A -> guest -> A invalidates work started in the first A.
 */

export const GUEST_OWNER = 'guest';

export interface OwnerClaim {
  owner: string;
  epoch: number;
}

let current: OwnerClaim = { owner: GUEST_OWNER, epoch: 0 };
const listeners = new Set<(claim: OwnerClaim) => void>();

/** The browser now belongs to `uid` (or the guest when null). Returns the new claim. */
export function setOwner(uid: string | null): OwnerClaim {
  const owner = uid || GUEST_OWNER;
  if (owner === current.owner) return current;
  current = { owner, epoch: current.epoch + 1 };
  for (const listener of listeners) listener(current);
  return current;
}

export function claim(): OwnerClaim {
  return current;
}

export function stillOwns(claimed: OwnerClaim): boolean {
  return claimed.epoch === current.epoch && claimed.owner === current.owner;
}

export function isGuestOwner(claimed: OwnerClaim = current): boolean {
  return claimed.owner === GUEST_OWNER;
}

/** Called after every owner change, with the new claim. */
export function onOwnerChange(listener: (claim: OwnerClaim) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetOwnerForTests(): void {
  current = { owner: GUEST_OWNER, epoch: 0 };
  listeners.clear();
}
