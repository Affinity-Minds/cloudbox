// Owner: WT-1. Shared bits of the forced first-sign-in pages (ADR 0009).
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { logout } from "@/api/auth";

export function SetupSteps({ current }: { current: 1 | 2 }) {
  const steps = ["Choose your password", "Set up your authenticator"];
  return (
    <ol className="mb-5 flex gap-4 text-xs" aria-label="First sign-in">
      {steps.map((label, index) => (
        <li
          key={label}
          aria-current={index + 1 === current ? "step" : undefined}
          className={
            index + 1 === current ? "font-medium text-foreground" : "text-muted-foreground"
          }
        >
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

export function SignOutLink() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      onClick={async () => {
        await logout().catch(() => undefined);
        queryClient.clear();
        await navigate({ to: "/login" });
      }}
    >
      Sign out
    </button>
  );
}
