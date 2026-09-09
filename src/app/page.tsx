"use client";

import { useCallback, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { AnalyzeForm, PRESETS } from "@/components/AnalyzeForm";
import { IntakeChat } from "@/components/IntakeChat";
import { AgentConsole, type AgentState } from "@/components/AgentConsole";
import { Dashboard } from "@/components/Dashboard";
import type { AnalysisResult, AnalyzeEvent, ShipmentInput } from "@/lib/types";

type Phase = "idle" | "running" | "done";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ShipmentInput | null>(null);
  const [manual, setManual] = useState(false);
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

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setResult(null);
    setError(null);
    setAgents([]);
    setManual(false);
  };

  return (
    <>
      <Header dataMode={result?.dataMode} />
      <main className="flex-1 mx-auto w-full max-w-7xl px-5">
        {phase === "idle" && (
          <div className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center py-10">
            <IntakeChat onReady={run} presets={PRESETS} />
            <div className="mt-8">
              {manual ? (
                <div className="w-full max-w-2xl mx-auto">
                  <AnalyzeForm onSubmit={run} loading={false} />
                  <button onClick={() => setManual(false)} className="mt-3 block mx-auto text-[11px] mono text-muted hover:text-foreground transition">
                    ← back to assistant
                  </button>
                </div>
              ) : (
                <button onClick={() => setManual(true)} className="text-xs text-foreground/60 hover:text-foreground border-b border-foreground/20 hover:border-foreground/50 pb-0.5 transition">
                  or enter details manually
                </button>
              )}
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center py-10">
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
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-5 py-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-semibold">Risk Analysis</h1>
                {result && (
                  <p className="text-sm text-muted mt-0.5">
                    {result.input.product} · {result.input.origin} → {result.input.destination}
                  </p>
                )}
              </div>
              <button
                onClick={reset}
                className="text-sm px-3.5 py-2 rounded-lg border border-border bg-panel-2 hover:border-accent/40 transition"
              >
                New analysis
              </button>
            </div>
            {error && (
              <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger px-4 py-3 text-sm">{error}</div>
            )}
            {result && <Dashboard result={result} />}
          </div>
        )}
      </main>
    </>
  );
}
