// Owner: WT-5.
import { createFileRoute } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/subscriptions/$id")({
  component: () => (
    <NotBuilt
      title="Subscription"
      owner="WT-5"
      scope="Subscription detail with issued entitlements."
    />
  ),
});
