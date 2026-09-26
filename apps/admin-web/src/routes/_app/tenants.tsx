// Owner: WT-2.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/tenants")({
  component: () => (
    <>
      <NotBuilt
        title="Tenants"
        owner="WT-2"
        scope="Tenant list with status, plan, devices and members; create, edit and archive."
      />
      <Outlet />
    </>
  ),
});
