// Shared helpers for data/accounts.json (burn-log + cc-usage).

/** Parked logins set `active: false`. Missing/true = active. */
export const isActiveAccount = (acc) => acc && acc.active !== false;

export function findAccount(cfg, label) {
  const acc = cfg?.accounts?.find((a) => a.label === label);
  if (!acc) return null;
  return { ...acc, parked: acc.active === false };
}
