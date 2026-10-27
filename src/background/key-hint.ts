/** What pages may know about the saved key: whether there is one, and its last 4 characters only when the key is long enough that they reveal little. */
export function keyHint(key: string | null): { saved: boolean; last4: string | null } {
  if (!key) return { saved: false, last4: null };
  return { saved: true, last4: key.length >= 12 ? key.slice(-4) : null };
}
