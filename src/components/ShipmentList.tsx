"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Radar, ShieldOff } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { fadeUp, list } from "@/lib/motion";
import { riskBand } from "@/lib/utils";
import type { ShipmentSummary } from "@/lib/shipments";

export function ShipmentList({ shipments }: { shipments: ShipmentSummary[] }) {
  return (
    <motion.ul {...list(0.05)} initial="initial" animate="animate" className="space-y-3">
      {shipments.map((s) => {
        const band = riskBand(s.risk_score);
        return (
          <motion.li key={s.id} variants={fadeUp}>
            <Link href={`/shipments/${s.id}`} className="block group">
              <Panel size="sm" className="transition group-hover:border-accent/40">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 text-center w-12">
                    <div className="text-xl font-semibold tabular-nums" style={{ color: band.color }}>
                      {s.risk_score}
                    </div>
                    <div className="text-[9px] mono uppercase tracking-wider text-muted">risk</div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{s.product}</div>
                    <div className="text-[12px] text-muted mt-0.5 truncate">
                      {s.origin} → {s.destination}
                      {s.ship_date ? ` · ${s.ship_date}` : ""}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <Badge tone={band.label === "Low" ? "ok" : band.label === "Critical" ? "danger" : "warn"}>
                        {band.label}
                      </Badge>
                      {s.monitored ? (
                        <Badge tone="accent" title={s.port_match_basis ?? undefined}>
                          <Radar className="size-2.5" /> {s.port_name}
                        </Badge>
                      ) : (
                        <Badge
                          tone="neutral"
                          title="Live vessel monitoring covers three ports; this lane isn't one of them, so no vessel-level incident will attach to it."
                        >
                          <ShieldOff className="size-2.5" /> not AIS-monitored
                        </Badge>
                      )}
                      {s.open_incident_count > 0 && (
                        <Badge tone="danger" dot pulse>
                          <AlertTriangle className="size-2.5" />
                          {s.open_incident_count} open incident{s.open_incident_count > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
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
