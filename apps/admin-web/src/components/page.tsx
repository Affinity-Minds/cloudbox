// Shared page chrome for the operational console: header row, panels, honest states.
import { AlertTriangle, Construction, RefreshCw } from "lucide-react";
import type * as React from "react";
import { describeError } from "@/api/client";
import { Button } from "@/components/ui/button";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b px-4 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b">
      <div className="flex h-9 items-center justify-between gap-4 px-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm" role="alert">
      <AlertTriangle className="size-4 shrink-0 text-destructive" />
      <span>
        Could not load this panel. <span className="font-mono text-xs">{describeError(error)}</span>
      </span>
      {onRetry ? (
        <Button variant="outline" size="sm" className="ml-auto" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-muted-foreground">{children}</div>;
}

/** Placeholder for a section another worktree owns. Honest: no fake rows, no fake numbers. */
export function NotBuilt({ title, owner, scope }: { title: string; owner: string; scope: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="flex items-start gap-3 px-4 py-6 text-sm">
        <Construction className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">Not built yet</p>
          <p className="text-muted-foreground">
            {scope} This section is owned by {owner} and shows no data until its API lands.
          </p>
        </div>
      </div>
    </>
  );
}
