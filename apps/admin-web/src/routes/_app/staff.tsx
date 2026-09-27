// Owner: WT-15. Staff screen (ops console, Govern > Staff). Gated `staff.manage` — the API itself
// refuses every route below without it (agent-notes: hiding a control is not disabling it), and this
// route's own `beforeLoad` keeps a caller without the permission from landing on a page that would
// only ever show ErrorState.

import type { StaffMember, StaffRole } from "@cloudbox/contracts";
import { CreateStaffRequest } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Dices, RotateCcw, ShieldOff, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { sessionQuery } from "@/api/auth";
import { describeError } from "@/api/client";
import { revokeStaff, staffQuery, upsertStaff } from "@/api/staff";
import { ROLE_LABEL } from "@/auth/session";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { SelectNative } from "@/components/ui/select-native";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

const ROLE_RANK: Record<StaffRole, number> = { read_only: 1, support: 2, admin: 3, super_admin: 4 };
const ROLES: StaffRole[] = ["read_only", "support", "admin", "super_admin"];

/** A password the admin can hand over out of band; never sent anywhere until "Add"/"Reset" submits. */
function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

export const Route = createFileRoute("/_app/staff")({
  beforeLoad: ({ context }) => {
    if (!context.session.permissions.includes("staff.manage")) {
      throw redirect({ to: "/" });
    }
  },
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(staffQuery);
  },
  component: StaffPage,
});

/** Shown once, right after a create/reset succeeds — the caller copies it and hands it over. */
function ShownOncePassword({ password, onDone }: { password: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Shown once — copy it now and hand it to them out of band. They must change it (and enrol an
        authenticator) at their next sign-in.
      </p>
      <InputGroup>
        <InputGroupInput readOnly value={password} className="font-mono tracking-wide" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Copy password"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password);
                setCopied(true);
                toast.success("Copied");
              } catch {
                toast.error("Could not copy — select and copy it manually.");
              }
            }}
          >
            <Dices />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <Button className="w-full" onClick={onDone}>
        {copied ? "Done" : "Close"}
      </Button>
    </div>
  );
}

function AddStaffSheet({
  open,
  onOpenChange,
  ownRank,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownRank: number;
}) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(CreateStaffRequest),
    defaultValues: { email: "", role: "read_only" as StaffRole, initialPassword: "" },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: form.reset is stable; only re-open should clear the form.
  useEffect(() => {
    if (open) {
      setShown(null);
      form.reset({ email: "", role: "read_only", initialPassword: generatePassword() });
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: upsertStaff,
    onSuccess: (member, variables) => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      setShown(variables.initialPassword ?? null);
      toast.success(`Added ${member.email}`);
    },
    onError: (error) =>
      toast.error("Could not add this person", { description: describeError(error) }),
  });

  const availableRoles = ROLES.filter((role) => ROLE_RANK[role] <= ownRank);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {shown ? (
          <>
            <SheetHeader>
              <SheetTitle>Staff member added</SheetTitle>
              <SheetDescription>Their initial password.</SheetDescription>
            </SheetHeader>
            <div className="px-4">
              <ShownOncePassword password={shown} onDone={() => onOpenChange(false)} />
            </div>
          </>
        ) : (
          <form onSubmit={form.handleSubmit((values) => mutation.mutate(values))} noValidate>
            <SheetHeader>
              <SheetTitle>Add staff</SheetTitle>
              <SheetDescription>
                They sign in at the ops login with this password, then set up an authenticator.
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="px-4">
              <Field data-invalid={form.formState.errors.email ? true : undefined}>
                <FieldLabel htmlFor="staff-email">Email</FieldLabel>
                <Input id="staff-email" type="email" autoFocus {...form.register("email")} />
                <FieldError errors={[form.formState.errors.email]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="staff-role">Role</FieldLabel>
                <SelectNative id="staff-role" {...form.register("role")}>
                  {availableRoles.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </SelectNative>
                <FieldDescription>You can only grant a role at or below your own.</FieldDescription>
              </Field>
              <Field data-invalid={form.formState.errors.initialPassword ? true : undefined}>
                <FieldLabel htmlFor="staff-password">Initial password</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="staff-password"
                    className="font-mono"
                    {...form.register("initialPassword")}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      type="button"
                      aria-label="Generate a password"
                      onClick={() => form.setValue("initialPassword", generatePassword())}
                    >
                      <Dices />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldError errors={[form.formState.errors.initialPassword]} />
              </Field>
            </FieldGroup>
            {mutation.isError ? (
              <p role="alert" className="px-4 text-sm text-destructive">
                {describeError(mutation.error)}
              </p>
            ) : null}
            <SheetFooter>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Adding…" : "Add staff"}
              </Button>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ResetPasswordDialog({
  member,
  open,
  onOpenChange,
}: {
  member: StaffMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword(generatePassword());
      setShown(false);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      upsertStaff({ email: member.email, role: member.role, initialPassword: password }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      setShown(true);
      toast.success(`Reset ${member.email}`);
    },
    onError: (error) =>
      toast.error("Could not reset this password", { description: describeError(error) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {shown ? (
          <>
            <DialogHeader>
              <DialogTitle>Password reset</DialogTitle>
            </DialogHeader>
            <ShownOncePassword password={password} onDone={() => onOpenChange(false)} />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Reset {member.email}'s password?</DialogTitle>
              <DialogDescription>
                Sets a new initial password, ends every one of their sessions, and removes their
                enrolled authenticator. They must set both up again at their next sign-in.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? "Resetting…" : "Reset password"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeStaffDialog({
  member,
  open,
  onOpenChange,
}: {
  member: StaffMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => revokeStaff(member.userId, reason.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      toast.success(`Revoked ${member.email}`);
      onOpenChange(false);
    },
    onError: (error) => toast.error("Could not revoke", { description: describeError(error) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke {member.email}?</DialogTitle>
          <DialogDescription>
            They lose staff access immediately. This does not affect any tenant they happen to be a
            member of separately.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="revoke-reason">Reason (optional)</FieldLabel>
          <Input
            id="revoke-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. left the team"
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
            {mutation.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StaffRow({
  member,
  ownRank,
  ownUserId,
}: {
  member: StaffMember;
  ownRank: number;
  ownUserId: string;
}) {
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const targetRank = ROLE_RANK[member.role];
  const isSelf = member.userId === ownUserId;
  // Mirrors the server's own ranking (staff.ts S-5): acting on a peer or a higher role is refused
  // there regardless — this only avoids offering a control the API would 403.
  const canAct = !isSelf && targetRank < ownRank;

  return (
    <TableRow>
      <TableCell className="h-9 px-3 py-1">{member.email}</TableCell>
      <TableCell className="h-9 px-3 py-1">{ROLE_LABEL[member.role]}</TableCell>
      <TableCell className="h-9 px-3 py-1">
        <StatusPill tone={member.twoFactorEnabled ? "success" : "neutral"}>
          {member.twoFactorEnabled ? "Enrolled" : "Not enrolled"}
        </StatusPill>
      </TableCell>
      <TableCell className="h-9 px-3 py-1">
        <StatusPill tone={member.mustChangePassword ? "warning" : "neutral"}>
          {member.mustChangePassword ? "Pending" : "Done"}
        </StatusPill>
      </TableCell>
      <TableCell
        className="h-9 px-3 py-1 font-mono text-xs"
        title={member.lastSignInAt ? formatTimestamp(member.lastSignInAt) : undefined}
      >
        {member.lastSignInAt ? formatAgo(member.lastSignInAt) : "Never"}
      </TableCell>
      <TableCell
        className="h-9 px-3 py-1 font-mono text-xs"
        title={formatTimestamp(member.createdAt)}
      >
        {formatAgo(member.createdAt)}
      </TableCell>
      <TableCell className="h-9 px-3 py-1 text-right">
        {canAct ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setResetting(true)}>
              <RotateCcw />
              Reset
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRevoking(true)}>
              <ShieldOff />
              Revoke
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{isSelf ? "You" : "—"}</span>
        )}
      </TableCell>
      <ResetPasswordDialog member={member} open={resetting} onOpenChange={setResetting} />
      <RevokeStaffDialog member={member} open={revoking} onOpenChange={setRevoking} />
    </TableRow>
  );
}

function StaffPage() {
  const staff = useQuery(staffQuery);
  const session = useQuery(sessionQuery);
  const [adding, setAdding] = useState(false);
  const ownUserId = session.data?.user.id ?? "";
  const ownRole = session.data?.user.staffRole;
  const ownRank = ownRole ? ROLE_RANK[ownRole] : 0;

  return (
    <>
      <PageHeader
        title="Staff"
        description="Everyone who can sign in to the CloudBox ops console."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <UserPlus />
            Add staff
          </Button>
        }
      />
      {staff.isError ? (
        <ErrorState error={staff.error} onRetry={() => staff.refetch()} />
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Email</TableHead>
              <TableHead className="h-8 px-3 text-xs">Role</TableHead>
              <TableHead className="h-8 px-3 text-xs">Authenticator</TableHead>
              <TableHead className="h-8 px-3 text-xs">Must change password</TableHead>
              <TableHead className="h-8 px-3 text-xs">Last sign-in</TableHead>
              <TableHead className="h-8 px-3 text-xs">Created</TableHead>
              <TableHead className="h-8 px-3 text-xs" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.isPending
              ? Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={`skeleton-${i.toString()}`}>
                    {Array.from({ length: 7 }, (_, j) => (
                      <TableCell key={`cell-${j.toString()}`} className="h-9 px-3">
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : staff.data?.items.map((member) => (
                  <StaffRow
                    key={member.userId}
                    member={member}
                    ownRank={ownRank}
                    ownUserId={ownUserId}
                  />
                ))}
          </TableBody>
        </Table>
      )}
      {staff.isSuccess && staff.data.items.length === 0 ? (
        <EmptyState>No staff yet. Add the first one above.</EmptyState>
      ) : null}
      <AddStaffSheet open={adding} onOpenChange={setAdding} ownRank={ownRank} />
    </>
  );
}
