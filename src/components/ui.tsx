"use client";

/**
 * Shared UI primitives.
 *
 * One file rather than a `ui/` directory: none of these needs its own tests,
 * stories or sub-files, and seven files averaging twenty lines is scaffolding.
 *
 * Only genuinely repeated surfaces live here. `Panel` was private to
 * Dashboard while sixteen other places hand-rolled its class string, and the
 * badge string was retyped ~25 times in the ops console alone at three
 * different sizes — that inconsistency is most of why the two halves of the
 * app looked hand-built. Deliberately absent: Card, Input, Select, Table,
 * Tabs, Tooltip, Toast, Skeleton. Inputs share a class constant, not a
 * component; a toast system for two error paths would be over-building.
 */

import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, X, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { DUR, fade, popIn } from "@/lib/motion";

/* -------------------------------------------------------------- Panel ---- */

export function Panel({
  title,
  action,
  size = "md",
  className,
  children,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-panel shadow-panel",
        size === "sm" ? "p-4" : "p-5",
        className,
      )}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {title ? (
            <h3 className="text-[11px] mono uppercase tracking-wider text-muted">{title}</h3>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------- Badge ---- */

export type BadgeTone = "neutral" | "accent" | "accent2" | "ok" | "warn" | "danger";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "border-border text-muted bg-panel-2",
  accent: "border-accent/40 text-accent bg-accent/10",
  accent2: "border-accent-2/40 text-accent-2 bg-accent-2/10",
  ok: "border-ok/40 text-ok bg-ok/10",
  warn: "border-warn/40 text-warn bg-warn/10",
  danger: "border-danger/40 text-danger bg-danger/10",
};

export function Badge({
  tone = "neutral",
  dot = false,
  pulse = false,
  title,
  className,
  children,
}: {
  tone?: BadgeTone;
  /** Leading status dot, inheriting the badge's colour. */
  dot?: boolean;
  pulse?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5",
        "text-[10px] mono uppercase tracking-wide whitespace-nowrap",
        BADGE_TONE[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn("size-1.5 rounded-full bg-current shrink-0", pulse && "animate-pulse")}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

/**
 * Live-vs-mock provenance, in one place.
 *
 * This project's hard rule is that it never presents fabricated data as real,
 * so the decision about how that's communicated shouldn't be re-made at each
 * call site.
 */
export function LiveBadge({
  live,
  liveLabel = "Live",
  mockLabel = "Mock",
  title,
}: {
  live: boolean;
  liveLabel?: string;
  mockLabel?: string;
  title?: string;
}) {
  return (
    <Badge
      tone={live ? "ok" : "warn"}
      dot
      pulse={live}
      title={title ?? (live ? "Fetched from the live web" : "Demo dataset — not fetched live")}
    >
      {live ? liveLabel : mockLabel}
    </Badge>
  );
}

/* ------------------------------------------------------------- Button ---- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "chip";
  tone?: "accent" | "ok" | "danger";
  selected?: boolean;
};

const PRIMARY_TONE = {
  accent: "bg-accent text-white hover:brightness-110",
  ok: "bg-ok text-white hover:brightness-110",
  danger: "bg-danger text-white hover:brightness-110",
};

export function Button({
  variant = "ghost",
  tone = "accent",
  selected = false,
  className,
  ...props
}: ButtonProps) {
  const base = "transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

  if (variant === "primary") {
    return (
      <button
        {...props}
        className={cn(
          base,
          "w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3",
          "text-sm font-semibold",
          PRIMARY_TONE[tone],
          className,
        )}
      />
    );
  }

  if (variant === "chip") {
    return (
      <button
        {...props}
        className={cn(
          base,
          "text-[11px] px-2.5 py-1.5 rounded-md border",
          selected
            ? "border-accent/60 text-accent bg-accent/10"
            : "border-border text-muted bg-panel-2 hover:text-foreground hover:border-accent/40",
          className,
        )}
      />
    );
  }

  return (
    <button
      {...props}
      className={cn(
        base,
        "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5",
        "text-xs border-border bg-panel-2 text-foreground hover:border-accent/40",
        className,
      )}
    />
  );
}

/* --------------------------------------------------------------- Stat ---- */

const STAT_TONE = {
  default: "text-foreground",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
};

export function Stat({
  label,
  value,
  sub,
  tone = "default",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: keyof typeof STAT_TONE;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[10px] mono uppercase tracking-wider text-muted mb-1">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", STAT_TONE[tone])}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* --------------------------------------------------------- EmptyState ---- */

/**
 * An empty state should teach: say what will appear here and where it comes
 * from, never just "nothing here". Several of these screens are the first
 * thing a new visitor sees.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-center py-8 px-4", className)}>
      {Icon && <Icon className="size-6 text-muted/60 mx-auto mb-3" />}
      <div className="text-sm font-medium">{title}</div>
      {body && <p className="text-[12px] text-muted mt-1.5 leading-relaxed max-w-md mx-auto">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* --------------------------------------------------------- SourceLink ---- */

export function SourceLink({
  url,
  title,
  snippet,
  compact = false,
}: {
  url: string;
  title: string;
  snippet?: string;
  compact?: boolean;
}) {
  // A mock source carries no real URL (see lib/anakin.ts) — render it as plain
  // text rather than a link that goes nowhere or, worse, looks like a citation.
  if (!url) {
    return (
      <div className={cn("rounded-lg border border-border bg-panel-2/40", compact ? "px-2 py-1" : "p-2.5")}>
        <div className="text-[12px] text-muted flex items-center gap-1.5">
          <span className="truncate">{title}</span>
          <Badge tone="warn">no source</Badge>
        </div>
        {snippet && !compact && <p className="text-[11px] text-muted/80 mt-1 leading-snug">{snippet}</p>}
      </div>
    );
  }

  if (compact) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] text-accent-2 hover:underline max-w-full"
      >
        <span className="truncate">{title}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-border bg-panel-2/40 p-2.5 hover:border-accent-2/50 transition group"
    >
      <div className="text-[12px] text-accent-2 flex items-start gap-1.5">
        <span className="group-hover:underline">{title}</span>
        <ExternalLink className="size-3 shrink-0 mt-0.5" />
      </div>
      {snippet && <p className="text-[11px] text-muted mt-1 leading-snug">{snippet}</p>}
    </a>
  );
}

/* -------------------------------------------------------------- Modal ---- */

export function Modal({
  open,
  onClose,
  title,
  icon,
  maxWidth = "max-w-lg",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  // Escape to close and a scroll lock — the three hand-rolled copies this
  // replaces had neither, so the page scrolled behind an open dialog and the
  // only way out was finding the X.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
          {...fade}
          transition={{ duration: DUR.fast }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "relative w-full rounded-2xl border border-border bg-panel shadow-xl",
              "max-h-[85vh] overflow-y-auto p-5",
              maxWidth,
            )}
            {...popIn}
            transition={{ duration: DUR.fast }}
          >
            <button
              type="button"
              onClick={onClose}
              autoFocus
              aria-label="Close"
              className="absolute top-4 right-4 text-muted hover:text-foreground transition cursor-pointer"
            >
              <X className="size-5" />
            </button>
            {(title || icon) && (
              <div className="flex items-center gap-2 mb-4 pr-8">
                {icon}
                {title && <h3 className="text-base font-semibold">{title}</h3>}
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
