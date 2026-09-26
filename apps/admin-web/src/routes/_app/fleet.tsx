// Owner: WT-3.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/fleet")({
  component: () => (
    <>
      <NotBuilt
        title="Fleet"
        owner="WT-3"
        scope="Enrolled devices with online state, agent version and last heartbeat."
      />
      <Outlet />
    </>
  ),
});
