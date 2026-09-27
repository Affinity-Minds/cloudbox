// Owner: WT-17. Settings → "Alerts": the staff email distribution list for alert notifications
// (`settings` key `alerts.staff_recipients`), editable by `settings.manage`. One additive section,
// same pattern as WT-12's Email providers section.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { alertsSettingsQuery, updateAlertsSettings } from "@/api/alerts";
import { describeError } from "@/api/client";
import { ErrorState, Section } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function AlertsSettingsSection() {
  const query = useQuery(alertsSettingsQuery);
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    if (query.data) setDraft(query.data.staffRecipients.join(", "));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (emails: string[]) => updateAlertsSettings(emails),
    onSuccess: (data) => {
      queryClient.setQueryData(alertsSettingsQuery.queryKey, data);
      toast.success("Alert recipients saved");
    },
    onError: (error) => toast.error(`Could not save: ${describeError(error)}`),
  });

  const emails = draft
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  return (
    <Section title="Alerts" meta="Staff email recipients for alert notifications">
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="space-y-2 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Comma-separated staff email addresses. A warning or critical alert emails these
            addresses (and the affected tenant's support contact) when it opens, with a 6-hour
            cooldown per alert.
          </p>
          {query.data === undefined ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="ops@example.com, oncall@example.com"
                className="font-mono text-xs"
              />
              <Button size="sm" onClick={() => save.mutate(emails)} disabled={save.isPending}>
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
