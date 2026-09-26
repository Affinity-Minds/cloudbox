// Owner: WT-3.
import { createFileRoute } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/_app/enrollment")({
  component: () => (
    <NotBuilt title="Enrollment" owner="WT-3" scope="Single-use enrollment tokens per tenant." />
  ),
});
