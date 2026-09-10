"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { Check, Loader2, Radar } from "lucide-react";
import { AgentConsole, type AgentState } from "@/components/AgentConsole";
import { Dashboard } from "@/components/Dashboard";
import { PlanIntake } from "@/components/PlanIntake";
import { Button } from "@/components/ui";
import { fadeUp } from "@/lib/motion";
import { shipmentsConfigured, trackShipment } from "@/lib/shipments";
import type { AnalysisResult, AnalyzeEvent, ShipmentInput } from "@/lib/types";

type Phase = "idle" | "running" | "done";

export default function PlanPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ShipmentInput | null>(null);
  const [tracking, setTracking] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const upsertAgent = useCallback((a: AgentState) => {
    setAgents((prev) => {
      const idx = prev.findIndex((p) => p.id === a.id);
      if (idx === -1) return [...prev, a];
      const next = [...prev];
      next[idx] = a;
      return next;
    });
  }, []);

  const run = useCallback(
    async (input: ShipmentInput) => {
      setActive(input);
      setPhase("running");
      setAgents([]);
      setLogs([]);
      setResult(null);
      setError(null);
      setTrackError(null);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            let evt: AnalyzeEvent;
            try {
              evt = JSON.parse(json);
            } catch {
              continue;
            }
            if (evt.type === "agent") {
              upsertAgent({ id: evt.id, name: evt.name, status: evt.status, summary: evt.summary });
            } else if (evt.type === "log") {
              setLogs((p) => [...p, evt.message]);
            } else if (evt.type === "result") {
              setResult(evt.data);
              setPhase("done");
            } else if (evt.type === "error") {
              setError(evt.message);
              setPhase("done");
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Analysis failed");
          setPhase("done");
        }
      }
    },
    [upsertAgent],
  );

  // Arriving from the watchlist's intake: pick up the shipment it collected and
  // start immediately, so describing and analysing feel like one motion rather
  // than a form the user has to fill in twice.
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem("taf.pendingPlan");
      if (pending) sessionStorage.removeItem("taf.pendingPlan");
    } catch {
      return;
    }
    if (!pending) return;
    try {
      // Starting the analysis is the whole point of the handoff, and `run`
      // sets state as it kicks off. That's a deliberate mount-time task, not
      // the accidental cascade this rule guards against.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      run(JSON.parse(pending) as ShipmentInput);
    } catch {
      /* malformed handoff — the intake screen below is the fallback */
    }
  }, [run]);

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setResult(null);
    setError(null);
    setAgents([]);
    setTrackError(null);
  };

  // Tracking is what turns a one-off report into something the ops half of the
  // product actually watches, so it hands the user straight to the shipment.
  const track = async () => {
    if (!result) return;
    setTracking(true);
    setTrackError(null);
    try {
      const shipment = await trackShipment(result);
      router.push(`/shipments/${shipment.id}`);
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : "Could not track this shipment.");
      setTracking(false);
    }
  };

  return (
    <main className="flex-1 mx-auto w-full max-w-7xl px-5">
      <AnimatePresence mode="wait">
        {phase === "idle" && (
          <motion.div
            key="idle"
            {...fadeUp}
            className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center py-10"
          >
            <PlanIntake onReady={run} />
          </motion.div>
        )}

        {phase === "running" && (
          <motion.div
            key="running"
            {...fadeUp}
            className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center py-10"
          >
            <div className="w-full max-w-xl">
              {active && (
                <div className="text-center mb-6">
                  <div className="serif text-3xl">Analyzing your shipment</div>
                  <p className="text-sm text-muted mt-2">
                    {active.product} · {active.origin} → {active.destination}
                    {active.shippingMode ? ` · ${active.shippingMode}` : ""}
                  </p>
                </div>
              )}
              <AgentConsole agents={agents} logs={logs} />
            </div>
          </motion.div>
        )}

        {phase === "done" && (
          <motion.div key="done" {...fadeUp} className="space-y-5 py-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="serif text-3xl">Risk Analysis</h1>
                {result && (
                  <p className="text-sm text-muted mt-0.5">
                    {result.input.product} · {result.input.origin} → {result.input.destination}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={reset}>New analysis</Button>
                {result && shipmentsConfigured() && (
                  <Button
                    onClick={track}
                    disabled={tracking}
                    className="border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                  >
                    {tracking ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" /> Tracking…
                      </>
                    ) : (
                      <>
                        <Radar className="size-3.5" /> Track this shipment
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {result && shipmentsConfigured() && !trackError && (
              <p className="text-[12px] text-muted flex items-center gap-1.5">
                <Check className="size-3.5 text-accent shrink-0" />
                Tracking keeps this analysis, watches the lane&apos;s port advisories, carrier tariff and
                billing rules for changes, and attaches any live disruption at its entry port.
              </p>
            )}
            {trackError && (
              <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger px-4 py-3 text-sm">
                {trackError}
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger px-4 py-3 text-sm">
                {error}
              </div>
            )}
            {result && <Dashboard result={result} />}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
