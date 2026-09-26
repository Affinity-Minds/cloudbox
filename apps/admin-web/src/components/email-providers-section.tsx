// Owner: WT-12. Settings → "Email providers": ordered table, add/edit sheet (react-hook-form),
// test-send with a visible result, delete with typed-name confirmation. Operational console
// density; an empty registry is not an error (the Cloudflare Email binding is used instead).
import type { EmailProvider, EmailProviderKind } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { describeError } from "@/api/client";
import {
  createEmailProvider,
  deleteEmailProvider,
  emailProvidersQuery,
  testEmailProvider,
  updateEmailProvider,
} from "@/api/email-providers";
import { EmptyState, ErrorState, Section } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { NativeSelect } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

const KIND_LABEL: Record<EmailProviderKind, string> = {
  cloudflare_binding: "Cloudflare Email",
  smtp: "SMTP",
  log: "Log (dev only)",
};

const FormSchema = z.object({
  name: z.string().min(1, "Required").max(120),
  kind: z.enum(["cloudflare_binding", "smtp", "log"]),
  fromAddress: z.email("Enter a valid email address"),
  priority: z.number().int().min(0).max(1000),
  enabled: z.boolean(),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().max(255),
  secret: z.string().max(1000),
});
type FormValues = z.infer<typeof FormSchema>;

const emptyForm = (): FormValues => ({
  name: "",
  kind: "cloudflare_binding",
  fromAddress: "",
  priority: 100,
  enabled: true,
  host: "",
  port: 587,
  secure: false,
  username: "",
  secret: "",
});

const formFor = (provider: EmailProvider): FormValues => ({
  name: provider.name,
  kind: provider.kind,
  fromAddress: provider.fromAddress,
  priority: provider.priority,
  enabled: provider.enabled,
  host: typeof provider.config.host === "string" ? provider.config.host : "",
  port: typeof provider.config.port === "number" ? provider.config.port : 587,
  secure: provider.config.secure === true,
  username: typeof provider.config.username === "string" ? provider.config.username : "",
  secret: "",
});

export function EmailProvidersSection() {
  const query = useQuery(emailProvidersQuery);
  const items = [...(query.data?.items ?? [])].sort((a, b) => a.priority - b.priority);
  const [sheet, setSheet] = useState<
    { mode: "create" } | { mode: "edit"; provider: EmailProvider } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<EmailProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>(
    {},
  );

  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["settings", "email-providers"] });

  const reorder = useMutation({
    mutationFn: ({ id, priority }: { id: string; priority: number }) =>
      updateEmailProvider(id, { priority }),
    onSuccess: invalidate,
    onError: (error) => toast.error(`Could not reorder: ${describeError(error)}`),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateEmailProvider(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => toast.error(`Could not update: ${describeError(error)}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteEmailProvider(id),
    onSuccess: async () => {
      toast.success("Provider deleted");
      setDeleteTarget(null);
      await invalidate();
    },
    onError: (error) => toast.error(`Could not delete: ${describeError(error)}`),
  });

  const test = useMutation({
    mutationFn: (id: string) => testEmailProvider(id),
    onSuccess: (result, id) =>
      setTestResults((prev) => ({
        ...prev,
        [id]: result.ok
          ? { ok: true, detail: "sent" }
          : { ok: false, detail: result.errorCode ?? "failed" },
      })),
    onError: (error, id) =>
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, detail: describeError(error) } })),
  });

  const move = (index: number, direction: -1 | 1) => {
    const other = items[index + direction];
    const current = items[index];
    if (!other || !current) return;
    reorder.mutate({ id: current.id, priority: other.priority });
    reorder.mutate({ id: other.id, priority: current.priority });
  };

  return (
    <>
      <Section
        title="Email providers"
        meta={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setSheet({ mode: "create" })}>
              <Plus />
              Add provider
            </Button>
          </div>
        }
      >
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.isPending ? (
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState>No providers configured; the Cloudflare Email binding is used.</EmptyState>
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 w-16 px-3 text-xs">Order</TableHead>
                <TableHead className="h-8 px-3 text-xs">Name</TableHead>
                <TableHead className="h-8 px-3 text-xs">Kind</TableHead>
                <TableHead className="h-8 px-3 text-xs">From</TableHead>
                <TableHead className="h-8 px-3 text-xs">Status</TableHead>
                <TableHead className="h-8 px-3 text-xs">Last test</TableHead>
                <TableHead className="h-8 px-3 text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, index) => {
                const result = testResults[item.id];
                return (
                  <TableRow key={item.id}>
                    <TableCell className="h-9 px-3">
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          aria-label="Move up"
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={index === items.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label="Move down"
                        >
                          <ArrowDown />
                        </Button>
                        <span className="tabular-nums text-xs text-muted-foreground">
                          {item.priority}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="h-9 px-3 font-medium">{item.name}</TableCell>
                    <TableCell className="h-9 px-3">
                      <StatusPill tone="info">{KIND_LABEL[item.kind]}</StatusPill>
                    </TableCell>
                    <TableCell className="h-9 px-3 font-mono text-xs">{item.fromAddress}</TableCell>
                    <TableCell className="h-9 px-3">
                      <button
                        type="button"
                        onClick={() =>
                          toggleEnabled.mutate({ id: item.id, enabled: !item.enabled })
                        }
                        disabled={toggleEnabled.isPending}
                      >
                        <StatusPill tone={item.enabled ? "success" : "neutral"}>
                          {item.enabled ? "enabled" : "disabled"}
                        </StatusPill>
                      </button>
                    </TableCell>
                    <TableCell className="h-9 px-3">
                      {result ? (
                        <StatusPill tone={result.ok ? "success" : "danger"}>
                          {result.detail}
                        </StatusPill>
                      ) : (
                        <span className="text-xs text-muted-foreground">not tested</span>
                      )}
                    </TableCell>
                    <TableCell className="h-9 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => test.mutate(item.id)}
                          disabled={test.isPending}
                          aria-label="Send test email"
                        >
                          <Send />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setSheet({ mode: "edit", provider: item })}
                          aria-label="Edit"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setDeleteTarget(item)}
                          aria-label="Delete"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <ProviderSheet
        key={sheet === null ? "closed" : sheet.mode === "edit" ? sheet.provider.id : "create"}
        state={sheet}
        onOpenChange={(open) => !open && setSheet(null)}
        onSaved={invalidate}
      />

      <DeleteDialog
        key={deleteTarget?.id ?? "none"}
        target={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        pending={remove.isPending}
      />
    </>
  );
}

function ProviderSheet({
  state,
  onOpenChange,
  onSaved,
}: {
  state: { mode: "create" } | { mode: "edit"; provider: EmailProvider } | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const editing = state?.mode === "edit" ? state.provider : null;
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: editing ? formFor(editing) : emptyForm(),
  });
  const kind = form.watch("kind");

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const smtp = values.kind === "smtp";
      if (editing) {
        return updateEmailProvider(editing.id, {
          name: values.name,
          fromAddress: values.fromAddress,
          priority: values.priority,
          enabled: values.enabled,
          ...(smtp
            ? {
                config: {
                  host: values.host,
                  port: values.port,
                  secure: values.secure,
                  username: values.username,
                },
                ...(values.secret ? { secret: values.secret } : {}),
              }
            : {}),
        });
      }
      if (values.kind === "smtp") {
        return createEmailProvider({
          kind: "smtp",
          name: values.name,
          fromAddress: values.fromAddress,
          priority: values.priority,
          enabled: values.enabled,
          config: {
            host: values.host,
            port: values.port,
            secure: values.secure,
            username: values.username,
          },
          secret: values.secret,
        });
      }
      return createEmailProvider({
        kind: values.kind,
        name: values.name,
        fromAddress: values.fromAddress,
        priority: values.priority,
        enabled: values.enabled,
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Provider updated" : "Provider created");
      onOpenChange(false);
      onSaved();
    },
    onError: (error) => toast.error(`Could not save: ${describeError(error)}`),
  });

  const onSubmit = (values: FormValues) => {
    if (values.kind === "smtp" && !editing && !values.secret) {
      form.setError("secret", { message: "Required for a new SMTP provider" });
      return;
    }
    if (values.kind === "smtp" && !values.host) {
      form.setError("host", { message: "Required" });
      return;
    }
    mutation.mutate(values);
  };

  return (
    <Sheet open={state !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{editing ? `Edit ${editing.name}` : "Add email provider"}</SheetTitle>
          <SheetDescription>
            {editing
              ? "Kind cannot change after creation."
              : "Providers are tried in priority order (lower first) until one succeeds."}
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-4"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <Field>
            <FieldLabel htmlFor="ep-name">Name</FieldLabel>
            <Input id="ep-name" {...form.register("name")} />
            <FieldError errors={[form.formState.errors.name]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="ep-kind">Kind</FieldLabel>
            <NativeSelect id="ep-kind" {...form.register("kind")} disabled={!!editing}>
              <option value="cloudflare_binding">Cloudflare Email</option>
              <option value="smtp">SMTP</option>
              <option value="log">Log (dev only)</option>
            </NativeSelect>
          </Field>

          <Field>
            <FieldLabel htmlFor="ep-from">From address</FieldLabel>
            <Input id="ep-from" type="email" {...form.register("fromAddress")} />
            <FieldError errors={[form.formState.errors.fromAddress]} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="ep-priority">Priority</FieldLabel>
              <Input
                id="ep-priority"
                type="number"
                min={0}
                max={1000}
                {...form.register("priority", { valueAsNumber: true })}
              />
              <FieldDescription>Lower is tried first.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <input
                id="ep-enabled"
                type="checkbox"
                className="size-4"
                {...form.register("enabled")}
              />
              <FieldLabel htmlFor="ep-enabled">Enabled</FieldLabel>
            </Field>
          </div>

          {kind === "smtp" ? (
            <>
              <Field>
                <FieldLabel htmlFor="ep-host">SMTP host</FieldLabel>
                <Input
                  id="ep-host"
                  placeholder="smtp.mx.cloudflare.net"
                  {...form.register("host")}
                />
                <FieldError errors={[form.formState.errors.host]} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="ep-port">Port</FieldLabel>
                  <Input
                    id="ep-port"
                    type="number"
                    min={1}
                    max={65535}
                    {...form.register("port", { valueAsNumber: true })}
                  />
                </Field>
                <Field orientation="horizontal">
                  <input
                    id="ep-secure"
                    type="checkbox"
                    className="size-4"
                    {...form.register("secure")}
                  />
                  <FieldLabel htmlFor="ep-secure">TLS (secure)</FieldLabel>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="ep-username">Username</FieldLabel>
                <Input id="ep-username" {...form.register("username")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="ep-secret">Password</FieldLabel>
                <Input
                  id="ep-secret"
                  type="password"
                  placeholder={editing?.hasSecret ? "Set — leave blank to keep it" : "Required"}
                  {...form.register("secret")}
                />
                <FieldError errors={[form.formState.errors.secret]} />
              </Field>
            </>
          ) : null}
        </form>
        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit(onSubmit)} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DeleteDialog({
  target,
  onOpenChange,
  onConfirm,
  pending,
}: {
  target: EmailProvider | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const [typed, setTyped] = useState("");

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete "{target?.name}"?</DialogTitle>
          <DialogDescription>
            This cannot be undone. Type the provider's name to confirm.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={target?.name}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed !== target?.name || pending}
            onClick={onConfirm}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
