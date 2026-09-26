// Owner: WT-1. Email OTP sign-in (email step → six-digit code step).
import { createFileRoute } from "@tanstack/react-router";
import { NotBuilt } from "@/components/page";

export const Route = createFileRoute("/login")({
  component: () => (
    <div className="mx-auto max-w-md pt-24">
      <NotBuilt
        title="Sign in"
        owner="WT-1"
        scope="Email one-time-code sign-in for CloudBox staff."
      />
    </div>
  ),
});
