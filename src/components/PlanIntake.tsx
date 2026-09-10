"use client";

import { useState } from "react";
import { AnalyzeForm, PRESETS } from "@/components/AnalyzeForm";
import { IntakeChat } from "@/components/IntakeChat";
import type { ShipmentInput } from "@/lib/types";

/**
 * The "describe a shipment" step.
 *
 * Extracted from the plan page so the watchlist can show it verbatim when
 * nothing is tracked yet — a first-time visitor lands on the same screen they
 * always did, rather than an empty table telling them to go somewhere else.
 */
export function PlanIntake({
  onReady,
  heading,
}: {
  onReady: (input: ShipmentInput) => void;
  heading?: React.ReactNode;
}) {
  const [manual, setManual] = useState(false);

  return (
    <div className="w-full">
      {heading}
      <IntakeChat onReady={onReady} presets={PRESETS} />
      <div className="mt-8">
        {manual ? (
          <div className="w-full max-w-2xl mx-auto">
            <AnalyzeForm onSubmit={onReady} loading={false} />
            <button
              onClick={() => setManual(false)}
              className="mt-3 block mx-auto text-[11px] mono text-muted hover:text-foreground transition cursor-pointer"
            >
              ← back to assistant
            </button>
          </div>
        ) : (
          <button
            onClick={() => setManual(true)}
            className="block mx-auto text-xs text-foreground/60 hover:text-foreground border-b border-foreground/20 hover:border-foreground/50 pb-0.5 transition cursor-pointer"
          >
            or enter details manually
          </button>
        )}
      </div>
    </div>
  );
}
