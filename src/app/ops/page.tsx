"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Package, Radar, Radio } from "lucide-react";
import { Badge, Button, EmptyState, Panel } from "@/components/ui";
import { fadeUp, list } from "@/lib/motion";
import { OPS_AGENTS, OPS_PHASES, isResolvedPhase } from "@/lib/ops";
import { listShipments, type ShipmentSummary } from "@/lib/shipments";

const VesselMap = dynamic(() => import("@/components/VesselMap").then((m) => m.VesselMap), {
  ssr: false,
  loading: () => (
    <div className="skeleton border border-border rounded-2xl h-[300px] md:h-[340px] grid place-items-center text-muted text-xs mono">
      Loading vessel map…
    </div>
  ),
});

interface IncidentRow {
  id: number;
  phase: string;
  port: string | null;
  vessel_mmsi: number | null;
  type: string | null;
  severity: string | null;
  detected_at: string | null;
  linked_shipments: { id: number; product: string; origin: string; destination: string }[];
}

const MONITORED_PORTS = ["Los Angeles / Long Beach", "New York / New Jersey", "Singapore"];

export default function OpsIndexPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const [incidents, setIncidents] = useState<IncidentRow[] | null>(null);
  const [shipments, setShipments] = useState<ShipmentSummary[]>([]);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/incidents`);
        if (!res.ok) throw new Error(String(res.status));
        const rows: IncidentRow[] = await res.json();
        if (cancelled) return;
        setIncidents(rows);
        setReachable(true);
      } catch {
        if (cancelled) return;
        setIncidents([]);
        setReachable(false);
      }
      const mine = await listShipments();
      if (!cancelled) setShipments(mine);
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiBaseUrl]);

  const onMyShipments = (incidents ?? []).filter((i) => i.linked_shipments.length > 0);
  const others = (incidents ?? []).filter((i) => i.linked_shipments.length === 0);
  const monitoredLanes = shipments.filter((s) => s.monitored);

  return (
    <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
      <motion.div {...fadeUp}>
        <div className="mb-6">
          <h1 className="serif text-3xl">Live Ops Room</h1>
          <p className="text-sm text-muted mt-0.5">
            {incidents === null
              ? "Checking for live incidents…"
              : incidents.length > 0
                ? `${incidents.length} incident${incidents.length === 1 ? "" : "s"} on record · agents negotiate, you decide`
                : "Standing by. Nothing is disrupted right now."}
          </p>
        </div>

        {!reachable && (
          <Panel size="sm" className="mb-5 border-border">
            <div className="flex items-start gap-3">
              <Radio className="size-4 text-muted mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-medium">Ops backend offline</div>
                <p className="text-[12px] text-muted mt-1 leading-relaxed">
                  The live half of this product runs as a separate service (AIS ingestion, the agent room bus and
                  Postgres). It isn&apos;t reachable from this browser right now, so incidents can&apos;t be listed.
                  Everything below describes what happens when it is.
                </p>
              </div>
            </div>
          </Panel>
        )}

        {onMyShipments.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[11px] mono uppercase tracking-wider text-muted mb-2.5">On your shipments</h2>
            <IncidentList rows={onMyShipments} highlight />
          </section>
        )}

        {others.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[11px] mono uppercase tracking-wider text-muted mb-2.5">
              Other incidents at monitored ports
            </h2>
            <IncidentList rows={others} />
          </section>
        )}

        {incidents !== null && incidents.length === 0 && (
          <Panel className="mb-6">
            <EmptyState
              icon={Radar}
              title="No incidents on record"
              body="This room lights up when the AIS feed reports a real vessel disruption at a monitored port — it isn't a demo that plays on load. The map below is live either way."
            />
          </Panel>
        )}

        {/* Genuinely live regardless of whether anything is wrong: real vessels
            moving is the best evidence the thing is actually running. */}
        <div className="mb-6">
          <VesselMap apiBaseUrl={apiBaseUrl} />
          <p className="text-[11px] mono text-muted mt-2">
            Watching {MONITORED_PORTS.join(" · ")} {reachable ? "· live AIS" : "· AIS feed unavailable"}
          </p>
        </div>

        {/* Your lanes against that coverage — the honest version of "are you
            being watched", including when the answer is no. */}
        <Panel title="Your tracked lanes" className="mb-6">
          {shipments.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Nothing tracked yet"
              body="Plan a shipment and track it, and any disruption at its entry port will open a room here automatically."
              action={
                <Link href="/plan">
                  <Button className="border-accent/40 bg-accent/10 text-accent hover:bg-accent/20">
                    Plan a shipment <ArrowRight className="size-3.5" />
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              <p className="text-[12px] text-muted mb-3">
                {monitoredLanes.length} of {shipments.length} tracked shipment
                {shipments.length === 1 ? "" : "s"} route through a port under live AIS monitoring.
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {shipments.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/shipments/${s.id}`}
                      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-border bg-panel-2 hover:border-accent/40 transition"
                      title={s.port_match_basis ?? undefined}
                    >
                      <span className="text-foreground">
                        {s.origin} → {s.destination}
                      </span>
                      {s.monitored ? (
                        <span className="text-accent">{s.port_name}</span>
                      ) : (
                        <span className="text-muted">not monitored</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        {/* The stepper rendered as a legend: this teaches the widget before it
            ever runs, using the same phase data the live stepper uses. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Panel title="How an incident is handled">
            <ol className="space-y-3">
              {OPS_PHASES.filter((p) => !isResolvedPhase(p.key)).map((p, i) => (
                <li key={p.key} className="flex gap-3">
                  <span className="size-5 shrink-0 rounded-full border-[1.5px] border-border bg-panel-2 text-muted grid place-items-center text-[11px] font-bold mono">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{p.name}</div>
                    <p className="text-[12px] text-muted leading-snug mt-0.5">{p.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Who is in the room">
            <ul className="space-y-2.5">
              {OPS_AGENTS.map((a) => (
                <li key={a.role} className="flex items-start gap-2.5">
                  <Badge tone="neutral" className="shrink-0 mt-0.5">
                    {a.framework}
                  </Badge>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{a.label}</div>
                    <p className="text-[12px] text-muted leading-snug">{a.does}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted mt-4 pt-3 border-t border-border leading-relaxed">
              Three different agent frameworks on purpose, and Dissent runs on a different model from the agents it
              argues with — so the objection isn&apos;t one model agreeing with itself.
            </p>
          </Panel>
        </div>
      </motion.div>
    </main>
  );
}

function IncidentList({ rows, highlight = false }: { rows: IncidentRow[]; highlight?: boolean }) {
  return (
    <motion.ul {...list(0.04)} initial="initial" animate="animate" className="space-y-2.5">
      {rows.map((incident) => {
        const open = !isResolvedPhase(incident.phase);
        return (
          <motion.li key={incident.id} variants={fadeUp}>
            <Link href={`/ops/${incident.id}`} className="block group">
              <Panel
                size="sm"
                className={`transition group-hover:border-accent/40 ${highlight ? "border-accent/30 bg-accent/5" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[11px] text-muted">#{incident.id}</span>
                      <span className="text-sm font-medium truncate">
                        {incident.type ?? "Disruption"} at {incident.port ?? "unknown port"}
                      </span>
                      {incident.severity && (
                        <Badge tone={incident.severity.toLowerCase() === "high" ? "danger" : "warn"}>
                          {incident.severity}
                        </Badge>
                      )}
                      <Badge tone={open ? "danger" : "neutral"} dot pulse={open}>
                        {incident.phase.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    {incident.linked_shipments.length > 0 && (
                      <div className="text-[12px] text-accent mt-1.5 flex items-center gap-1.5">
                        <AlertTriangle className="size-3 shrink-0" />
                        Affects {incident.linked_shipments.map((s) => s.product).join(", ")}
                      </div>
                    )}
                    {incident.detected_at && (
                      <div className="text-[10px] mono text-muted mt-1">
                        detected {new Date(incident.detected_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <ArrowRight className="size-4 text-muted/50 group-hover:text-accent transition shrink-0 mt-1" />
                </div>
              </Panel>
            </Link>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}
