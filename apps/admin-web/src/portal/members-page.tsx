// Owner: WT-15. Portal Members: Owner/Admin add by email, change standing within ranking, revoke
// with a reason; Users see the list read-only. The server (`memberships.ts`) re-enforces ranking
// and the last-active-owner guard on every write regardless of what this page offers — hiding a
// control here is convenience, not the actual gate (agent-notes: "hiding a control is not
// disabling it").
import type { MembershipStanding, PortalMember } from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { portalMembersQuery } from "@/api/portal";
import { removeMember, updateMemberStanding } from "@/api/tenants";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { InviteMemberDialog } from "@/components/tenants/invite-member-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAgo, formatTimestamp } from "@/lib/time";
import { RequireActiveTenant } from "./require-active-tenant";

const STANDING_RANK: Record<MembershipStanding, number> = { user: 1, admin: 2, owner: 3 };
const STANDINGS: MembershipStanding[] = ["user", "admin", "owner"];
const STANDING_LABEL: Record<MembershipStanding, string> = {
  owner: "Owner",
  admin: "Admin",
  user: "User",
};

function RevokeMemberDialog({
  tenantId,
  member,
  open,
  onOpenChange,
}: {
  tenantId: string;
  member: PortalMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => removeMember(tenantId, member.id, reason.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal", tenantId, "members"] });
      toast.success(`Removed ${member.email}`);
      onOpenChange(false);
      setReason("");
    },
    onError: (error) =>
      toast.error("Could not remove this member", { description: describeError(error) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove {member.email}?</DialogTitle>
          <DialogDescription>
            They lose access to this organisation immediately. You can invite them back later.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="member-revoke-reason">Reason (optional)</FieldLabel>
          <Input
            id="member-revoke-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. no longer with us"
          />
        </Field>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeError(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  tenantId,
  member,
  ownStanding,
}: {
  tenantId: string;
  member: PortalMember;
  ownStanding: MembershipStanding;
}) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState(false);
  const ownRank = STANDING_RANK[ownStanding];
  // Mirrors the server's ranking rule (memberships.ts assertStandingRank): only rows strictly below
  // the caller's own standing can be acted on at all.
  const canAct = ownRank > 1 && STANDING_RANK[member.standing] < ownRank;
  const grantableStandings = STANDINGS.filter((s) => STANDING_RANK[s] <= ownRank);

  const standingMutation = useMutation({
    mutationFn: (standing: MembershipStanding) =>
      updateMemberStanding(tenantId, member.id, { standing }),
    onSuccess: (_data, standing) => {
      queryClient.invalidateQueries({ queryKey: ["portal", tenantId, "members"] });
      toast.success(`${member.email} is now ${STANDING_LABEL[standing]}`);
    },
    onError: (error) =>
      toast.error("Could not change standing", { description: describeError(error) }),
  });

  return (
    <TableRow>
      <TableCell className="h-9 px-3 py-1">
        <div className="font-medium">{member.name || member.email}</div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </TableCell>
      <TableCell className="h-9 px-3 py-1">
        {canAct ? (
          <SelectNative
            className="h-7 w-32"
            value={member.standing}
            disabled={standingMutation.isPending}
            onChange={(e) => standingMutation.mutate(e.target.value as MembershipStanding)}
          >
            {grantableStandings.map((standing) => (
              <option key={standing} value={standing}>
                {STANDING_LABEL[standing]}
              </option>
            ))}
          </SelectNative>
        ) : (
          <StatusPill tone="neutral">{STANDING_LABEL[member.standing]}</StatusPill>
        )}
      </TableCell>
      <TableCell
        className="h-9 px-3 py-1 font-mono text-xs"
        title={formatTimestamp(member.createdAt)}
      >
        {formatAgo(member.createdAt)}
      </TableCell>
      <TableCell className="h-9 px-3 py-1 text-right">
        {canAct ? (
          <Button size="xs" variant="ghost" onClick={() => setRevoking(true)}>
            Remove
          </Button>
        ) : null}
      </TableCell>
      <RevokeMemberDialog
        tenantId={tenantId}
        member={member}
        open={revoking}
        onOpenChange={setRevoking}
      />
    </TableRow>
  );
}

function MembersTable({ tenantId }: { tenantId: string }) {
  const members = useQuery(portalMembersQuery(tenantId));
  const [adding, setAdding] = useState(false);

  if (members.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (members.isError)
    return <ErrorState error={members.error} onRetry={() => members.refetch()} />;

  const canAdd = members.data.standing === "owner" || members.data.standing === "admin";

  return (
    <>
      {canAdd ? (
        <div className="flex justify-end pb-3">
          <Button size="sm" onClick={() => setAdding(true)}>
            Add member
          </Button>
        </div>
      ) : null}
      {members.data.items.length === 0 ? (
        <EmptyState>No members yet.</EmptyState>
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Member</TableHead>
              <TableHead className="h-8 px-3 text-xs">Standing</TableHead>
              <TableHead className="h-8 px-3 text-xs">Joined</TableHead>
              <TableHead className="h-8 px-3 text-xs" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data.items.map((member) => (
              <MemberRow
                key={member.id}
                tenantId={tenantId}
                member={member}
                ownStanding={members.data.standing}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {canAdd ? (
        <InviteMemberDialog tenantId={tenantId} open={adding} onOpenChange={setAdding} />
      ) : null}
    </>
  );
}

export function MembersPage() {
  return (
    <>
      <PageHeader title="Members" description="Who can sign in to this organisation's portal." />
      <div className="pt-4">
        <RequireActiveTenant>
          {(tenantId) => <MembersTable tenantId={tenantId} />}
        </RequireActiveTenant>
      </div>
    </>
  );
}
