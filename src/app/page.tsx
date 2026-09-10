"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { PlanIntake } from "@/components/PlanIntake";
import { ShipmentList } from "@/components/ShipmentList";
import { Button } from "@/components/ui";
import { fadeUp } from "@/lib/motion";
import { listShipments, shipmentsConfigured, type ShipmentSummary } from "@/lib/shipments";
import type { ShipmentInput } from "@/lib/types";

/**
 * The watchlist — everything being tracked, and the way into planning
 * something new.
 *
 * With nothing tracked it renders the intake screen unchanged, so a first-time
 * visitor gets the same start they always did rather than an empty table
 * pointing them elsewhere. The watchlist only appears once it has content.
 */
export default function Home() {
  const router = useRouter();
  const [shipments, setShipments] = useState<ShipmentSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const rows = await listShipments();
      if (!cancelled) setShipments(rows);
    };
    load();
    // Cheap refresh so an incident opening elsewhere shows up without a reload.
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Planning happens on /plan; the intake here just hands the input over via
  // sessionStorage so the analysis starts immediately on arrival.
  const startPlan = (input: ShipmentInput) => {
    try {
      sessionStorage.setItem("taf.pendingPlan", JSON.stringify(input));
    } catch {
      /* private mode — /plan falls back to its own intake screen */
    }
    router.push("/plan");
  };

  const hasShipments = (shipments?.length ?? 0) > 0;

  if (!shipmentsConfigured() || (shipments !== null && !hasShipments)) {
    return (
      <main className="flex-1 mx-auto w-full max-w-7xl px-5">
        <div className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center py-10">
          <PlanIntake onReady={startPlan} />
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="serif text-3xl">Watchlist</h1>
          <p className="text-sm text-muted mt-0.5">
            {shipments === null
              ? "Loading tracked shipments…"
              : `${shipments.length} shipment${shipments.length === 1 ? "" : "s"} tracked · watching ports, tariffs and billing rules for changes`}
          </p>
        </div>
        <Button onClick={() => router.push("/plan")} className="border-accent/40 bg-accent/10 text-accent hover:bg-accent/20">
          <Plus className="size-3.5" /> Plan a shipment
        </Button>
      </div>

      {shipments === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[86px] rounded-2xl border border-border" />
          ))}
        </div>
      ) : (
        <motion.div {...fadeUp}>
          <ShipmentList shipments={shipments} />
        </motion.div>
      )}
    </main>
  );
}
