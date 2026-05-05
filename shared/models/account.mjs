export const ACCOUNT_PLAN_CODES = Object.freeze({
  local: "local",
  spailaOne: "spaila_one",
});

export const SUBSCRIPTION_STATES = Object.freeze({
  localOnly: "local_only",
  trial: "trial",
  active: "active",
  pastDue: "past_due",
  canceled: "canceled",
  trialExpired: "trial_expired",
});

export const DEFAULT_ACCOUNT_PROFILE = Object.freeze({
  accountId: "local-single-shop",
  shopId: "local-shop",
  shopName: "",
  accountEmail: "",
  ownerName: "",
  planCode: ACCOUNT_PLAN_CODES.local,
  subscriptionState: SUBSCRIPTION_STATES.localOnly,
  authMode: "local_first",
  multiShopReady: false,
  trialStartedAt: "",
  trialEndsAt: "",
  billingStatus: "not_configured",
  stripeCustomerId: "",
  stripeSubscriptionId: "",
});

export function normalizeAccountProfile(profile = {}) {
  return {
    ...DEFAULT_ACCOUNT_PROFILE,
    ...profile,
    shopName: String(profile.shopName || "").trim(),
    accountEmail: String(profile.accountEmail || "").trim(),
    ownerName: String(profile.ownerName || "").trim(),
  };
}
