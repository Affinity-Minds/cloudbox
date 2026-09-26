// Retire/reactivate confirmation (agent-notes ux-patterns "Confirmations"): names the specific
// record and what else it affects — how many subscriptions are on this plan right now. Reversible
// (reactivate undoes it), so this stops short of a typed-name confirmation.
import type { Plan } from "@cloudbox/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { reactivatePlan, retirePlan } from "@/api/plans";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RetirePlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: Plan & { subscriptionCount: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const retiring = plan.status === "active";

  const mutation = useMutation({
    mutationFn: () => (retiring ? retirePlan(plan.code) : reactivatePlan(plan.code)),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["plans", "active"] });
      toast.success(
        retiring
          ? `${result.plan.name} retired — ${result.subscriptionCount} existing subscription${result.subscriptionCount === 1 ? "" : "s"} keep working`
          : `${result.plan.name} reactivated`,
      );
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error("Could not change the plan's status", {
        description: describeError(error),
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {retiring ? `Retire ${plan.name}?` : `Reactivate ${plan.name}?`}
          </DialogTitle>
          <DialogDescription>
            {retiring ? (
              <>
                <span className="font-mono">{plan.code}</span> will no longer be offered for new
                tenants or new subscriptions.{" "}
                {plan.subscriptionCount > 0 ? (
                  <>
                    <span className="font-medium text-foreground">
                      {plan.subscriptionCount} existing subscription
                      {plan.subscriptionCount === 1 ? "" : "s"}
                    </span>{" "}
                    on this plan will keep working unchanged.
                  </>
                ) : (
                  "No subscriptions are on this plan right now."
                )}
              </>
            ) : (
              <>
                <span className="font-mono">{plan.code}</span> becomes selectable again for new
                tenants and new subscriptions.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeError(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant={retiring ? "destructive" : "default"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Saving…" : retiring ? "Retire plan" : "Reactivate plan"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
