// Owner: WT-0. Settings: build stamp and API contract; editable settings arrive with their owners.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { versionQuery } from "@/api/system";
import { ErrorState, PageHeader, Section } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const version = useQuery(versionQuery);
  const rows: [string, string | undefined][] = [
    ["Service", version.data?.service],
    ["Environment", version.data?.environment],
    ["Git SHA", version.data?.gitSha],
    ["Built at", version.data?.builtAt],
    ["API base", `${window.location.origin}/api/v1`],
    ["API version header", "X-API-Version: v1"],
  ];

  return (
    <>
      <PageHeader title="Settings" description="Build stamp reported by the running Worker." />
      <Section title="Build">
        {version.isError ? (
          <ErrorState error={version.error} onRetry={() => version.refetch()} />
        ) : (
          <table className="w-full border-t text-sm">
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label} className="border-b">
                  <th
                    scope="row"
                    className="h-8 w-48 px-4 text-left font-normal text-muted-foreground"
                  >
                    {label}
                  </th>
                  <td className="px-4 font-mono text-xs">
                    {value ?? <Skeleton className="h-4 w-40" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
