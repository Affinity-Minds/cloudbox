// Owner: WT-5. Read-time subscription lifecycle. The stored `status` is the commercial state; the
// calendar is applied here on every read so nothing derived is ever persisted (brief WT-5 §1).
import type { SubscriptionExpiry, SubscriptionStatus } from "@cloudbox/contracts";

const DAY_MS = 86_400_000;

type Lifecycle = {
  status: SubscriptionStatus;
  validFrom: string;
  validUntil: string;
  renewalWarningDays: number;
};

export function subscriptionLifecycle(
  sub: Lifecycle,
  now: Date,
): { expiry: SubscriptionExpiry; daysRemaining: number; issuable: boolean } {
  const from = Date.parse(sub.validFrom);
  const until = Date.parse(sub.validUntil);
  const at = now.getTime();
  const daysRemaining = Math.floor((until - at) / DAY_MS);
  const live = sub.status === "active" || sub.status === "trial";
  const inWindow = from <= at && at < until;

  let expiry: SubscriptionExpiry;
  if (!live) expiry = "inactive";
  else if (at < from) expiry = "scheduled";
  else if (at >= until) expiry = "expired";
  else if (daysRemaining <= sub.renewalWarningDays) expiry = "expiring";
  else expiry = "active";

  return { expiry, daysRemaining, issuable: live && inWindow };
}
