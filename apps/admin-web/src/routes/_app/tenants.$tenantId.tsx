// Owner: WT-2.
import { createFileRoute } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/tenants/$tenantId")({
  component: () => (
    <NotBuilt title="Tenant" owner="WT-2" scope="Tenant detail with memberships and contacts." />
  ),
});
