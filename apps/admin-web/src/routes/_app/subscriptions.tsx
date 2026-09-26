// Owner: WT-5.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/subscriptions")({
  component: () => (
    <>
      <NotBuilt
        title="Subscriptions"
        owner="WT-5"
        scope="Subscriptions per tenant with plan, validity and entitlement generation."
      />
      <Outlet />
    </>
  ),
});
