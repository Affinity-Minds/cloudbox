// Retire/reactivate confirmation (agent-notes ux-patterns "Confirmations"): names the specific
// record and what else it affects — how many subscriptions are on this plan right now. Reversible
// (reactivate undoes it), so this stops short of a typed-name confirmation.
import { PLAN_RETIRE_REASON_CODES, type Plan } from "@cloudbox/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { reactivatePlan, retirePlan } from "@/api/plans";
import {
  isReasonValid,
  ReasonSelect,
  type ReasonValue,
  reasonRequestBody,
} from "@/components/reason-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PLAN_RETIRE_REASON_LABELS: Record<(typeof PLAN_RETIRE_REASON_CODES)[number], string> = {
  superseded: "Superseded by another plan",
  pricing_change: "Pricing change",
  discontinued: "Discontinued",
  other: "Other",
};

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
  const [reason, setReason] = useState<ReasonValue>({ code: "" });

  const mutation = useMutation({
    mutationFn: () =>
      retiring ? retirePlan(plan.code, reasonRequestBody(reason)) : reactivatePlan(plan.code),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["plans", "active"] });
      toast.success(
        retiring
          ? `${result.plan.name} retired — ${result.subscriptionCount} existing subscription${result.subscriptionCount === 1 ? "" : "s"} keep working`
          : `${result.plan.name} reactivated`,
      );
      setReason({ code: "" });
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
        {retiring ? (
          <ReasonSelect
            options={PLAN_RETIRE_REASON_CODES.map((code) => ({
              code,
              label: PLAN_RETIRE_REASON_LABELS[code],
            }))}
            value={reason}
            onChange={setReason}
          />
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeError(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant={retiring ? "destructive" : "default"}
            disabled={mutation.isPending || (retiring && !isReasonValid(reason))}
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
