"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Eye,
  Loader2,
  Radar,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { Dashboard } from "@/components/Dashboard";
import { Badge, Button, EmptyState, Panel } from "@/components/ui";
import { fadeUp } from "@/lib/motion";
import { deleteShipment, getShipment, type ShipmentDetail } from "@/lib/shipments";
import { riskBand } from "@/lib/utils";

const PHASE_LABEL: Record<string, string> = {
  detected: "Detected",
  negotiating: "Agents negotiating",
  options_collected: "Options collected",
  evaluating: "Evaluating",
  awaiting_approval: "Awaiting your approval",
  approved: "Approved",
  rejected: "Rejected",
};

export default function ShipmentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [shipment, setShipment] = useState<ShipmentDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const data = await getShipment(params.id);
      if (cancelled) return;
      setShipment(data);
      setState(data ? "ready" : "missing");
    };
    load();
    // Incidents and web signals arrive independently of this page.
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [params.id]);

  const remove = async () => {
    setRemoving(true);
    try {
      await deleteShipment(Number(params.id));
      router.push("/");
    } catch {
      setRemoving(false);
    }
  };

  if (state === "loading") {
    return (
      <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
        <div className="skeleton h-28 rounded-2xl border border-border mb-5" />
        <div className="skeleton h-64 rounded-2xl border border-border" />
      </main>
    );
  }

  if (state === "missing" || !shipment) {
    return (
      <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
        <Panel>
          <EmptyState
            icon={AlertTriangle}
            title="Shipment not found"
            body="It may have been removed, or the ops backend may be unreachable from here."
            action={
              <Button onClick={() => router.push("/")}>
                <ArrowLeft className="size-3.5" /> Back to watchlist
              </Button>
            }
          />
        </Panel>
      </main>
    );
  }

  const band = riskBand(shipment.risk_score);
  const openIncidents = shipment.incidents.filter((i) => !["approved", "rejected"].includes(i.phase));

  return (
    <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
      <motion.div {...fadeUp}>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[11px] mono text-muted hover:text-foreground transition mb-4"
        >
          <ArrowLeft className="size-3.5" /> Watchlist
        </Link>

        {/* Header strip */}
        <Panel className="mb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="serif text-3xl truncate">{shipment.product}</h1>
              <p className="text-sm text-muted mt-1">
                {shipment.origin} → {shipment.destination}
                {shipment.ship_date ? ` · ${shipment.ship_date}` : ""}
                {shipment.mode ? ` · ${shipment.mode}` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                <Badge tone={band.label === "Low" ? "ok" : band.label === "Critical" ? "danger" : "warn"}>
                  risk {shipment.risk_score} · {band.label}
                </Badge>
                {shipment.monitored ? (
                  <Badge tone="accent" title={shipment.port_match_basis ?? undefined}>
                    <Radar className="size-2.5" /> AIS-monitored · {shipment.port_name}
                  </Badge>
                ) : (
                  <Badge tone="neutral">
                    <ShieldOff className="size-2.5" /> not AIS-monitored
                  </Badge>
                )}
                {shipment.monitors.length > 0 && (
                  <Badge tone="accent2" dot pulse>
                    <Eye className="size-2.5" /> {shipment.monitors.length} pages watched
                  </Badge>
                )}
              </div>
            </div>
            <Button onClick={remove} disabled={removing} className="hover:border-danger/50 hover:text-danger">
              {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Stop tracking
            </Button>
          </div>
        </Panel>

        {/* Activity: live incidents and web signals */}
        <Panel
          title="Activity"
          className="mb-5"
          action={
            <span className="text-[10px] mono text-muted">
              vessel incidents · page changes via Anakin
            </span>
          }
        >
          {shipment.incidents.length === 0 && shipment.monitor_signals.length === 0 ? (
            <EmptyState
              icon={Radar}
              title="Nothing has happened on this lane yet"
              body={
                shipment.monitored
                  ? `${shipment.port_name} is under live AIS monitoring — a vessel disruption there will open an incident and appear here automatically. Changes to the watched tariff and advisory pages land here too.`
                  : `Live vessel monitoring covers three ports and this lane isn't one of them, so no vessel-level incident will attach to it. The carrier tariff and billing-rule pages are still watched, and changes there will appear here.`
              }
            />
          ) : (
            <ul className="space-y-2.5">
              {shipment.incidents.map((incident) => (
                <li key={incident.incident_id}>
                  <Link href={`/ops/${incident.incident_id}`} className="block group">
                    <div className="rounded-xl border border-border bg-panel-2/40 p-3.5 group-hover:border-accent/40 transition">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <Badge
                          tone={openIncidents.some((i) => i.incident_id === incident.incident_id) ? "danger" : "neutral"}
                          dot
                        >
                          {PHASE_LABEL[incident.phase] ?? incident.phase}
                        </Badge>
                        <span className="text-sm font-medium">
                          {incident.type} at {incident.port}
                        </span>
                        {incident.inferred && <Badge tone="warn">port match · inferred</Badge>}
                      </div>
                      <p className="text-[12px] text-muted leading-snug">{incident.basis}</p>
                      <span className="text-[11px] mono text-accent-2 group-hover:underline inline-flex items-center gap-1 mt-2">
                        Open the ops room <ExternalLink className="size-3" />
                      </span>
                    </div>
                  </Link>
                </li>
              ))}

              {shipment.monitor_signals.map((signal) => (
                <li key={`sig-${signal.id}`}>
                  <div className="rounded-xl border border-accent-2/25 bg-accent-2/5 p-3.5">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <Badge tone="accent2">web signal · {signal.kind.replace(/_/g, " ")}</Badge>
                      <span className="text-sm font-medium">{signal.monitor}</span>
                      {signal.detected_at && (
                        <span className="text-[10px] mono text-muted">
                          {new Date(signal.detected_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-foreground/80 leading-snug">{signal.summary}</p>
                    <a
                      href={signal.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] mono text-accent-2 hover:underline inline-flex items-center gap-1 mt-2"
                    >
                      View the source page <ExternalLink className="size-3" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {shipment.monitors.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="text-[10px] mono uppercase tracking-wider text-muted mb-2">
                Pages watched for this lane
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {shipment.monitors.map((m) => (
                  <li key={m.url}>
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border bg-panel-2 text-muted hover:text-foreground hover:border-accent-2/40 transition"
                      title={`Checked every ${m.interval_minutes} minutes`}
                    >
                      {m.label} <ExternalLink className="size-2.5" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        {/* The original analysis, rehydrated from storage */}
        <Dashboard result={shipment.analysis} />
      </motion.div>
    </main>
  );
}
