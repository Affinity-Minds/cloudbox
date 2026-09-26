// Owner: WT-3.
import { createFileRoute } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/fleet/$deviceId")({
  component: () => (
    <NotBuilt title="Device" owner="WT-3" scope="Device detail with health document and revoke." />
  ),
});
