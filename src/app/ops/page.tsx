"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  MessageSquare,
  ShieldCheck,
  ShieldAlert,
  Clock,
  ExternalLink,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Info,
} from "lucide-react";

// MapLibre touches the DOM/window at map-construction time, so load it client-side only.
const VesselMap = dynamic(() => import("@/components/VesselMap").then((m) => m.VesselMap), {
  ssr: false,
  loading: () => (
    <div className="bg-ops-surface/70 border border-ops-line rounded-2xl h-[300px] md:h-[340px] grid place-items-center text-ops-mute text-xs mono">
      Loading vessel map…
    </div>
  ),
});

interface Incident {
  id: number;
  room_id: string;
  phase: string;
}

interface DisruptionEvent {
  vessel: string;
  mmsi: number;
  port: string;
  type: string;
  severity: string;
  detected_at: string;
}

interface AffectedParty {
  importer_name: string;
  cargo_desc: string;
  bol_ref: string;
  inferred: boolean;
  basis: string;
  source_url: string;
}

interface RecoveryOption {
  id: number;
  proposer: string;
  type: string;
  feasibility: string;
  eta_delta_hours: number;
  cost_delta: number | null;
  risk: string;
  rationale: string;
  source_url: string;
}

interface Participant {
  role: string;
  framework: string;
  status: string;
}

interface Recommendation {
  option_id: number;
  proposer: string;
  type: string;
  feasibility: string;
  eta_delta_hours: number;
  cost_delta: number | null;
  rationale: string;
  vote_score?: number;
  contested: boolean;
  source_url?: string;
}

interface Dissent {
  objection: string;
  material: boolean;
  target_option_id: number;
}

interface IncidentSnapshot {
  incident: Incident | null;
  event: DisruptionEvent | null;
  affected_parties: AffectedParty[];
  options: RecoveryOption[];
  participants: Participant[];
  recommendation: Recommendation | null;
  dissent: Dissent | null;
}

interface RoomEvent {
  kind: "room_created" | "agent_recruited" | "message" | "option_added" | "phase_change" | "decision";
  room_id: string;
  ts: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

const EMPTY_SNAPSHOT: IncidentSnapshot = {
  incident: null,
  event: null,
  affected_parties: [],
  options: [],
  participants: [],
  recommendation: null,
  dissent: null,
};

const PHASES = [
  { key: "detected", name: "Detection" },
  { key: "negotiating", name: "Negotiation" },
  { key: "options_collected", name: "Options" },
  { key: "evaluating", name: "Evaluating" },
  { key: "awaiting_approval", name: "Approval Gate" },
  { key: "approved", name: "Approved" },
  { key: "rejected", name: "Rejected" },
];

export default function OpsPage() {
  const [snapshot, setSnapshot] = useState<IncidentSnapshot>(EMPTY_SNAPSHOT);
  const [status, setStatus] = useState("Connecting to backend...");
  const [wsEvents, setWsEvents] = useState<RoomEvent[]>([]);
  const [dollarAccumulator, setDollarAccumulator] = useState(0);
  const [decisionReason, setDecisionReason] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [selectedDecisionOption, setSelectedDecisionOption] = useState<number | null>(null);
  const [tariffState, setTariffState] = useState<{
    loading: boolean;
    result?: { loaded: number; source_url: string };
    error?: string;
  }>({ loading: false });

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws";

  const fetchActiveIncident = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/incidents/active`);
      const data = await res.json();
      if (data && data.incident) {
        setSnapshot(data);
        if (data.recommendation) setSelectedDecisionOption(data.recommendation.option_id);
      } else {
        setSnapshot(EMPTY_SNAPSHOT);
      }
    } catch (err) {
      console.error("Failed to fetch active incident snapshot:", err);
    }
  };

  const refreshTariffs = async () => {
    setTariffState({ loading: true });
    try {
      const res = await fetch(`${apiBaseUrl}/admin/tariffs/refresh`, { method: "POST" });
      if (!res.ok) throw new Error(res.statusText || "Request failed");
      const data = await res.json();
      setTariffState({ loading: false, result: data });
      setTimeout(() => setTariffState((s) => (s.result === data ? { loading: false } : s)), 10000);
    } catch (err) {
      setTariffState({ loading: false, error: err instanceof Error ? err.message : "Failed to refresh tariffs" });
    }
  };

  // Demurrage/detention dollar-meter tick — accrues from incident detection
  // time using published per-day rates for reefer vs. dry cargo.
  useEffect(() => {
    if (!snapshot.event) {
      setDollarAccumulator(0);
      return;
    }
    const detectedTime = new Date(snapshot.event.detected_at).getTime();
    const elapsedSeconds = Math.max(0, (Date.now() - detectedTime) / 1000);

    const reeferCount = snapshot.affected_parties.filter(
      (p) => p.cargo_desc.toLowerCase().includes("reefer") || p.cargo_desc.toLowerCase().includes("temp"),
    ).length;
    const dryCount = Math.max(1, snapshot.affected_parties.length - reeferCount);
    const ratePerSecond = (reeferCount * 350 + dryCount * 150) / 86400;

    setDollarAccumulator(elapsedSeconds * ratePerSecond);
    const interval = setInterval(() => {
      setDollarAccumulator((prev) => prev + ratePerSecond * 0.1);
    }, 100);
    return () => clearInterval(interval);
  }, [snapshot.event, snapshot.affected_parties]);

  useEffect(() => {
    fetchActiveIncident();

    let socket: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connectWS = () => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setStatus("Live Connected");
        fetchActiveIncident();
      };

      socket.onmessage = (event) => {
        try {
          const parsed: RoomEvent = JSON.parse(event.data);
          setWsEvents((prev) => [parsed, ...prev]);

          if (parsed.kind === "phase_change") {
            setSnapshot((prev) =>
              prev.incident ? { ...prev, incident: { ...prev.incident, phase: parsed.payload.phase } } : prev,
            );
            fetchActiveIncident();
          } else if (
            parsed.kind === "option_added" ||
            parsed.kind === "decision" ||
            parsed.kind === "room_created"
          ) {
            fetchActiveIncident();
          }
        } catch {
          console.warn("WS received non-JSON message:", event.data);
          setWsEvents((prev) => [
            {
              kind: "message",
              room_id: "",
              ts: new Date().toISOString(),
              payload: { sender: "System", text: event.data },
            },
            ...prev,
          ]);
        }
      };

      socket.onclose = () => {
        setStatus("Disconnected. Reconnecting...");
        reconnectTimeout = setTimeout(connectWS, 3000);
      };

      socket.onerror = (err) => console.error("WS connection error:", err);
    };

    connectWS();
    return () => {
      socket?.close();
      clearTimeout(reconnectTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDecision = async (action: "approve" | "reject") => {
    if (!snapshot.incident) return;
    setSubmittingDecision(true);
    try {
      const res = await fetch(`${apiBaseUrl}/incidents/${snapshot.incident.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          actor: "Ops Manager",
          reason: decisionReason,
          option_id: selectedDecisionOption,
        }),
      });
      if (res.ok) {
        setSnapshot(await res.json());
        setDecisionReason("");
      } else {
        alert("Failed to submit decision: " + res.statusText);
      }
    } catch (err) {
      console.error("Error submitting decision:", err);
      alert("Network error submitting decision");
    } finally {
      setSubmittingDecision(false);
    }
  };

  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  };

  const activePhase = snapshot.incident?.phase || "detected";
  const activeIndex = PHASES.findIndex((p) => p.key === activePhase);
  const isResolved = activePhase === "approved" || activePhase === "rejected";
  const visiblePhases = PHASES.filter((p) => {
    const isSpecial = p.key === "approved" || p.key === "rejected";
    return !isSpecial || activePhase === p.key;
  });

  const renderMessageText = (text: string) => {
    const parts = text.split(/(@\w+|@\[\[.*?\]\])/g);
    return parts.map((part, index) =>
      part.startsWith("@") ? (
        <span key={index} className="text-accent-2 bg-accent-2/10 px-1.5 py-0.5 rounded mono text-[11px]">
          {part}
        </span>
      ) : (
        part
      ),
    );
  };

  const isLive = status.includes("Live");

  return (
      <main className="flex-1 text-ops-ink font-sans">
      <div className="mx-auto max-w-7xl px-5 py-5">
        {/* Incident context + phase card — one card instead of two stacked sticky bars,
            matching the landing page's card conventions (rounded-2xl, translucent panel). */}
        <div className="rounded-2xl border border-border bg-panel/70 mb-5">
          <div className="flex items-center justify-between gap-4 px-4 md:px-5 py-3 border-b border-ops-line">
            <div className="flex items-center gap-2 mono text-xs text-ops-mute min-w-0">
              <span className="text-ops-faint">incident</span>
              <span className="text-ops-ink font-semibold">{snapshot.incident ? `#${snapshot.incident.id}` : "—"}</span>
              <span className="text-ops-faint">/</span>
              <span className="truncate">{snapshot.event?.port || "No active incident"}</span>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="hidden sm:flex items-center gap-2 bg-ok/8 border border-ok/25 px-3 py-1.5 rounded-lg">
                <span className="relative w-[7px] h-[7px]">
                  <span className="absolute inset-0 rounded-full bg-ok" />
                  <span className="absolute inset-0 rounded-full bg-ok pulse-ring" />
                </span>
                <span className="mono text-[11px] text-ok font-semibold">LIVE AIS</span>
              </div>

              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
                  isLive ? "bg-accent/8 border-accent/25" : "bg-warn/8 border-warn/25"
                }`}
              >
                <span className={`w-[7px] h-[7px] rounded-full animate-ops-blink ${isLive ? "bg-accent" : "bg-warn"}`} />
                <span className={`mono text-[11px] font-semibold ${isLive ? "text-accent" : "text-warn"}`}>
                  {isLive ? "ROOM BUS CONNECTED" : "RECONNECTING"}
                </span>
              </div>

              <button
                onClick={fetchActiveIncident}
                title="Refresh data"
                className="w-[34px] h-[34px] rounded-lg bg-ops-surface border border-ops-line flex items-center justify-center text-ops-mute hover:text-ops-ink transition-colors"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Phase stepper */}
          <div className="px-4 md:px-5 py-4 overflow-x-auto">
          <div className="flex items-center gap-0 min-w-max">
            {visiblePhases.map((p, i) => {
              const fullIdx = PHASES.findIndex((x) => x.key === p.key);
              const isCompleted = fullIdx < activeIndex || isResolved;
              const isActive = fullIdx === activeIndex && !isResolved;
              const isApprovedStep = p.key === "approved";
              const isRejectedStep = p.key === "rejected";
              const accentText = isRejectedStep ? "text-danger" : isApprovedStep ? "text-accent" : "text-ok";
              const circleCls =
                isCompleted || isApprovedStep
                  ? isRejectedStep
                    ? "bg-danger/15 border-danger text-danger"
                    : isApprovedStep
                      ? "bg-accent/15 border-accent text-accent"
                      : "bg-ok/15 border-ok text-ok"
                  : isActive
                    ? "bg-accent/15 border-accent text-accent animate-ops-blink"
                    : "bg-ops-surface border-ops-line text-ops-faint";

              return (
                <div key={p.key} className="flex items-center">
                  <div className="flex items-center gap-2.5 pr-2">
                    <div className={`w-5 h-5 rounded-full border-[1.5px] flex items-center justify-center text-[11px] font-bold ${circleCls}`}>
                      {isCompleted || isApprovedStep || isRejectedStep ? (isRejectedStep ? "✕" : "✓") : fullIdx + 1}
                    </div>
                    <span
                      className={`text-[13px] font-semibold whitespace-nowrap ${
                        isActive ? "text-ops-ink" : isCompleted ? "text-ops-ink" : isApprovedStep || isRejectedStep ? accentText : "text-ops-faint"
                      }`}
                    >
                      {p.name}
                    </span>
                  </div>
                  {i < visiblePhases.length - 1 && (
                    <div className={`h-px w-8 sm:w-12 mx-2 ${fullIdx < activeIndex || isResolved ? "bg-ok" : "bg-ops-line"}`} />
                  )}
                </div>
              );
            })}
            <div className="flex-1" />
            <div className="mono text-[11px] text-ops-faint whitespace-nowrap pl-4">
              phase · <span className={isResolved ? (activePhase === "approved" ? "text-accent" : "text-danger") : "text-ok"}>{activePhase}</span>
            </div>
          </div>
          </div>
        </div>

        {/* Body grid */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-5">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="bg-ops-surface/70 border border-ops-line rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  {snapshot.event?.severity && (
                    <span className="mono text-[9px] text-danger bg-danger/10 border border-danger/30 px-1.5 py-0.5 rounded font-bold uppercase">
                      {snapshot.event.severity} severity
                    </span>
                  )}
                  {snapshot.event?.type && (
                    <span className="mono text-[9px] tracking-wider text-ops-mute uppercase">
                      {snapshot.event.type.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <div className="mono text-[10px] text-ops-faint tracking-wider">INCIDENT TARGET</div>
                <div className="text-xl font-extrabold tracking-tight mt-1.5 leading-tight">
                  {snapshot.event ? snapshot.event.vessel : "No active incident"}
                </div>
                {snapshot.event && (
                  <div className="text-ops-mute text-[11px] mt-2 mono leading-relaxed">
                    MMSI {snapshot.event.mmsi} · detected {formatTime(snapshot.event.detected_at)}
                  </div>
                )}
              </div>

              <div className="rounded-2xl p-4 relative overflow-hidden border border-danger/30 bg-danger/8">
                <div className="mono text-[9px] tracking-wider text-danger/80">D&amp;D COST OF INACTION · ACCRUING</div>
                <div className="mono text-[32px] font-bold text-danger tracking-tight mt-2 leading-none tabular-nums">
                  ${dollarAccumulator.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[11px] mt-2.5 mono text-ops-mute leading-relaxed">published carrier demurrage tariff</div>
              </div>
            </div>

            <VesselMap apiBaseUrl={apiBaseUrl} disruptedMmsi={snapshot.event?.mmsi} port={snapshot.event?.port} />

            {/* Recovery options matrix */}
            <div className="bg-ops-surface/70 border border-ops-line rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-bold">Recovery options</span>
                  <span className="mono text-[10px] text-ops-mute bg-ops-bg border border-ops-line px-2 py-0.5 rounded">
                    demurrage-grounded
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {tariffState.result && (
                    <a
                      href={tariffState.result.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono text-[10px] text-ok hover:underline"
                    >
                      loaded {tariffState.result.loaded} tariffs · source ↗
                    </a>
                  )}
                  {tariffState.error && <span className="mono text-[10px] text-danger">{tariffState.error}</span>}
                  <button
                    onClick={refreshTariffs}
                    disabled={tariffState.loading}
                    className="flex items-center gap-1.5 mono text-[10px] text-accent border border-accent/30 bg-accent/8 hover:bg-accent/15 disabled:opacity-50 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    <RefreshCw className={`h-3 w-3 ${tariffState.loading ? "animate-spin" : ""}`} />
                    {tariffState.loading ? "Refreshing…" : "Refresh live tariff"}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-[1.1fr_0.9fr_0.7fr_1.7fr] gap-3 mono text-[9px] tracking-wider text-ops-faint uppercase pb-2.5 px-2 border-b border-ops-line">
                <div className="min-w-0">Proposer · strategy</div>
                <div className="min-w-0">Feasibility</div>
                <div className="text-right min-w-0">ETA Δ</div>
                <div className="text-right min-w-0">D&amp;D cost Δ · rationale</div>
              </div>

              {snapshot.options.length === 0 ? (
                <div className="py-6 text-ops-faint italic text-center text-xs">
                  Waiting for agents to propose tariff-grounded recovery options…
                </div>
              ) : (
                snapshot.options.map((opt) => {
                  const isRecommended = snapshot.recommendation?.option_id === opt.id;
                  const feas = opt.feasibility?.toLowerCase();
                  const feasColor = feas === "high" ? "text-ok" : feas === "medium" ? "text-warn" : "text-danger";
                  const etaColor = opt.eta_delta_hours <= 0 ? "text-ops-ink" : opt.eta_delta_hours >= 100 ? "text-danger" : "text-warn";

                  return (
                    <div key={opt.id}>
                      <div
                        className={`grid grid-cols-[1.1fr_0.9fr_0.7fr_1.7fr] gap-3 items-center min-w-0 px-2 ${
                          isRecommended
                            ? "py-3.5 mt-2 bg-ok/8 border border-ok/30 rounded-xl"
                            : "py-3.5 border-b border-ops-line/50"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.proposer === "logistics" ? "bg-ok" : "bg-warn"}`} />
                            <span className="text-xs font-semibold capitalize truncate">{opt.proposer}</span>
                          </div>
                          <div className={`mono text-[13px] font-bold mt-1.5 uppercase truncate ${isRecommended ? "text-ok" : "text-ops-ink"}`}>
                            {opt.type}
                          </div>
                        </div>
                        <div className={`text-xs font-semibold min-w-0 truncate ${feasColor}`}>{opt.feasibility}</div>
                        <div className={`text-right mono text-[13px] min-w-0 ${etaColor}`}>
                          {opt.eta_delta_hours > 0 ? `+${opt.eta_delta_hours}` : opt.eta_delta_hours} h
                        </div>
                        <div className="text-right min-w-0">
                          <span className={`mono text-[13px] font-bold ${opt.cost_delta !== null ? (isRecommended ? "text-ops-ink" : feas === "low" ? "text-danger" : "text-ops-ink") : "text-ops-faint"}`}>
                            {opt.cost_delta !== null ? `$${opt.cost_delta.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
                          </span>
                          <div className="text-[11px] text-ops-mute mt-1 truncate" title={opt.rationale || ""}>
                            {opt.rationale || "no rationale"}
                          </div>
                          {opt.source_url && (
                            <a
                              href={opt.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 mt-1 mono text-[9px] text-accent-2 hover:underline"
                            >
                              tariff page <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                        </div>
                      </div>
                      {isRecommended && (
                        <div className="flex items-center gap-2 pt-2 pl-3">
                          <span className="mono text-[9px] text-ok bg-ok/10 border border-ok/30 px-2 py-0.5 rounded font-bold">
                            ★ RECOMMENDED{typeof snapshot.recommendation?.vote_score === "number" ? ` · QUORUM ${snapshot.recommendation.vote_score.toFixed(2)}` : ""}
                          </span>
                          {snapshot.recommendation?.contested && (
                            <span className="mono text-[9px] text-danger bg-danger/10 border border-danger/30 px-2 py-0.5 rounded font-bold">
                              CONTESTED
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="flex flex-col gap-4">
            {/* Human gate — approval */}
            {snapshot.incident && activePhase === "awaiting_approval" && (
              <div className="rounded-2xl p-4 md:p-5 border border-accent/40 bg-panel/70">
                <div className="flex items-center gap-2.5 border-b border-ops-line pb-3">
                  <ShieldCheck className="h-6 w-6 text-accent" />
                  <div>
                    <h2 className="text-base font-bold text-ops-ink">Ops Manager approval gate</h2>
                    <p className="text-[11px] text-ops-mute">Review the recommendation and authorize recovery</p>
                  </div>
                </div>

                {snapshot.recommendation && (
                  <div className="bg-accent/6 border border-accent/20 p-4 rounded-xl flex flex-col gap-2.5 mt-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="mono text-[10px] uppercase font-bold text-accent tracking-wider flex items-center gap-1.5">
                        Top recommendation
                        {typeof snapshot.recommendation.vote_score === "number" && (
                          <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 text-[9px] font-bold normal-case tracking-normal">
                            quorum {snapshot.recommendation.vote_score.toFixed(2)}
                          </span>
                        )}
                      </span>
                      {snapshot.recommendation.contested && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-danger/15 text-danger border border-danger/25 text-[9px] font-bold">
                          <ShieldAlert className="h-3 w-3" />
                          CONTESTED
                        </span>
                      )}
                    </div>

                    <div className="flex justify-between items-center">
                      <div className="text-base font-bold text-ops-ink flex items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded bg-accent text-white font-bold text-xs uppercase">
                          {snapshot.recommendation.type}
                        </span>
                        <span className="text-ops-ink text-sm">by {snapshot.recommendation.proposer}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] text-ops-faint mono">ETA Δ</div>
                        <div className="text-sm font-bold text-ops-ink mono">+{snapshot.recommendation.eta_delta_hours} h</div>
                      </div>
                    </div>

                    <p className="text-xs text-ops-mute italic border-l-2 border-accent/50 pl-3">
                      &quot;{snapshot.recommendation.rationale}&quot;
                    </p>
                    {snapshot.recommendation.source_url && (
                      <a
                        href={snapshot.recommendation.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mono text-[9px] text-accent-2 hover:underline"
                      >
                        source <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                )}

                {snapshot.dissent && (
                  <div className="bg-danger/6 border border-danger/25 p-4 rounded-xl flex flex-col gap-2.5 mt-3">
                    <div className="mono text-[10px] uppercase font-bold text-danger tracking-wider flex items-center gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      Recorded adversarial dissent
                    </div>
                    <p className="text-xs text-ops-mute leading-relaxed">{snapshot.dissent.objection}</p>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="px-1.5 py-0.5 bg-danger/10 text-danger border border-danger/20 font-bold rounded mono">
                        Material: {snapshot.dissent.material ? "YES" : "NO"}
                      </span>
                      <span className="mono text-ops-faint">target option #{snapshot.dissent.target_option_id}</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2.5 mt-4">
                  <label className="text-xs font-semibold text-ops-mute">Decision rationale / comments</label>
                  <textarea
                    value={decisionReason}
                    onChange={(e) => setDecisionReason(e.target.value)}
                    placeholder="State your operational justification for authorization / rejection…"
                    className="bg-ops-bg border border-ops-line p-3 rounded-xl text-xs h-20 text-ops-ink placeholder-ops-faint focus:outline-none focus:border-accent-2 resize-none font-sans"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-3">
                  <button
                    onClick={() => handleDecision("approve")}
                    disabled={submittingDecision || !decisionReason}
                    className="py-2.5 rounded-xl text-xs font-bold bg-ok/90 hover:bg-ok disabled:bg-ops-surface disabled:text-ops-faint text-white flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Approve plan
                  </button>
                  <button
                    onClick={() => handleDecision("reject")}
                    disabled={submittingDecision || !decisionReason}
                    className="py-2.5 rounded-xl text-xs font-bold bg-danger/90 hover:bg-danger disabled:bg-ops-surface disabled:text-ops-faint text-white flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <XCircle className="h-4 w-4" />
                    Reject &amp; escalate
                  </button>
                </div>
              </div>
            )}

            {/* Locked decision */}
            {snapshot.incident && isResolved && (
              <div
                className={`rounded-2xl p-4 md:p-5 flex flex-col gap-3.5 border ${
                  activePhase === "approved" ? "bg-ok/8 border-ok/30" : "bg-danger/8 border-danger/30"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-[30px] h-[30px] rounded-full border-[1.5px] flex items-center justify-center text-[15px] ${
                      activePhase === "approved" ? "bg-ok/15 border-ok text-ok" : "bg-danger/15 border-danger text-danger"
                    }`}
                  >
                    {activePhase === "approved" ? "✓" : "✕"}
                  </div>
                  <div>
                    <div className="text-base font-bold capitalize">Plan {activePhase}</div>
                    <div className="text-xs text-ops-mute">Operational gate locked &amp; executed</div>
                  </div>
                </div>
                <div className="bg-ops-surface border border-ops-line rounded-xl p-3.5">
                  <div className="mono text-[9px] tracking-wider text-ops-faint">HUMAN DECISION LOG</div>
                  <div className="text-[13px] text-ops-ink mt-1.5 italic">
                    &quot;Authorization submitted by Ops Manager. Phase advanced.&quot;
                  </div>
                </div>
                <a
                  href={`${apiBaseUrl}/incidents/${snapshot.incident.id}/dossier`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold bg-ops-surface hover:bg-ops-line/40 border border-ops-line text-accent-2 mono transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  Download audit dossier
                </a>
              </div>
            )}

            {/* Room feed */}
            <div className="bg-ops-surface/70 border border-ops-line rounded-2xl flex flex-col h-[480px]">
              <div className="p-4 border-b border-ops-line flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-accent-2" />
                  <h2 className="font-bold text-[15px]">Room feed</h2>
                </div>
                <span className="mono text-[9px] text-ok flex items-center gap-1.5">
                  <span className="w-[5px] h-[5px] rounded-full bg-ok animate-ops-blink" />
                  SYNC
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 ops-scrollbar">
                {wsEvents.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-ops-faint gap-2">
                    <Info className="h-8 w-8 text-ops-line animate-ops-blink" />
                    <p className="text-xs italic text-center">Waiting for room activity…</p>
                  </div>
                ) : (
                  wsEvents.map((evt, i) => {
                    const timestampStr = formatTime(evt.ts);

                    switch (evt.kind) {
                      case "room_created":
                        return (
                          <div key={i} className="bg-accent-2/6 border border-accent-2/20 p-3.5 rounded-xl flex flex-col gap-1.5">
                            <div className="flex justify-between items-center mono text-[10px] text-accent-2 font-bold uppercase tracking-wider">
                              <span>Room opened</span>
                              <span className="text-ops-faint">{timestampStr}</span>
                            </div>
                            <div className="text-xs font-bold text-ops-ink">
                              Incident room created for <span className="text-accent-2">{evt.payload.vessel}</span> @ {evt.payload.port}
                            </div>
                            <div className="mono text-[10px] text-ops-faint">incident #{evt.payload.incident_id}</div>
                          </div>
                        );

                      case "agent_recruited":
                        return (
                          <div key={i} className="bg-ops-bg border border-ops-line p-3 rounded-xl flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg bg-accent-2/10 border border-accent-2/25 flex items-center justify-center mono text-[11px] font-bold text-accent-2 uppercase">
                                {evt.payload.role?.slice(0, 2)}
                              </div>
                              <div>
                                <div className="text-xs font-semibold capitalize">{evt.payload.role} joined</div>
                                <div className="mono text-[10px] text-ops-faint">framework · {evt.payload.framework || "Agent"}</div>
                              </div>
                            </div>
                            <span className="mono text-[9px] text-ok bg-ok/10 border border-ok/30 px-2 py-1 rounded font-bold uppercase">
                              Joined
                            </span>
                          </div>
                        );

                      case "option_added":
                        return (
                          <div key={i} className="border-l-2 border-warn bg-warn/8 rounded-r-xl p-3 flex flex-col gap-1.5">
                            <div className="flex justify-between items-center mono text-[10px] text-warn font-bold uppercase tracking-wider">
                              <span>Option proposed</span>
                              <span className="text-ops-mute">{timestampStr}</span>
                            </div>
                            <div className="flex justify-between items-baseline">
                              <span className="text-sm font-bold uppercase text-ops-ink">{evt.payload.type}</span>
                              <span className="mono text-sm font-bold text-warn">
                                {evt.payload.cost_delta !== null && evt.payload.cost_delta !== undefined ? `$${evt.payload.cost_delta.toLocaleString()}` : "—"}
                              </span>
                            </div>
                            <div className="text-[11px] text-ops-mute">
                              by {evt.payload.proposer} · ETA change {evt.payload.eta_delta_hours} hrs
                            </div>
                          </div>
                        );

                      case "phase_change":
                        return (
                          <div key={i} className="flex justify-center my-1">
                            <div className="px-3 py-1 rounded-full bg-ops-bg border border-ops-line text-ops-mute mono text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5">
                              <Clock className="h-3 w-3 text-accent-2" />
                              Phase · <span className="text-ops-ink font-extrabold">{evt.payload.phase}</span>
                            </div>
                          </div>
                        );

                      case "decision": {
                        const isApp = evt.payload.action?.toLowerCase() === "approve";
                        return (
                          <div
                            key={i}
                            className={`border p-4 rounded-xl flex flex-col gap-2 ${
                              isApp ? "bg-ok/6 border-ok/25" : "bg-danger/6 border-danger/25"
                            }`}
                          >
                            <div className="flex justify-between items-center mono text-[10px] font-bold uppercase tracking-wider">
                              <span className={isApp ? "text-ok" : "text-danger"}>Human gate · {evt.payload.action}d</span>
                              <span className="text-ops-faint">{timestampStr}</span>
                            </div>
                            <div className="text-xs text-ops-ink">
                              <span className="font-bold text-ops-ink">{evt.payload.actor}</span>: &quot;{evt.payload.reason}&quot;
                            </div>
                            {evt.payload.option_id && (
                              <div className="mono text-[10px] text-ops-faint">target option #{evt.payload.option_id}</div>
                            )}
                          </div>
                        );
                      }

                      case "message":
                      default: {
                        const sender = evt.payload.sender || "Agent";
                        return (
                          <div key={i} className="py-3 border-b border-ops-line/50 last:border-b-0">
                            <div className="flex justify-between items-center mb-1.5">
                              <span className="text-xs font-bold text-ops-ink capitalize">{sender}</span>
                              <span className="mono text-[10px] text-ops-faint">{timestampStr}</span>
                            </div>
                            <p className="text-xs text-ops-mute leading-relaxed font-sans whitespace-pre-wrap">
                              {renderMessageText(evt.payload.text || "")}
                            </p>
                          </div>
                        );
                      }
                    }
                  })
                )}
              </div>
            </div>

            {/* Affected importers */}
            <div className="bg-ops-surface/70 border border-ops-line rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bold text-sm">Affected importers</h2>
                <span className="mono text-[9px] text-ok bg-ok/10 border border-ok/30 px-2 py-1 rounded font-bold uppercase">
                  Live DB
                </span>
              </div>

              <div className="space-y-3 max-h-[210px] overflow-y-auto ops-scrollbar pr-1">
                {snapshot.affected_parties.length === 0 ? (
                  <p className="text-ops-faint text-xs italic text-center py-4">No affected importers identified yet.</p>
                ) : (
                  snapshot.affected_parties.map((party, idx) => (
                    <div key={idx} className="bg-ops-bg border border-ops-line p-3 rounded-xl">
                      <div className="flex justify-between items-start gap-3">
                        <div className="text-sm font-bold text-ops-ink">{party.importer_name}</div>
                        <span
                          className={`flex-shrink-0 mono text-[9px] px-2 py-0.5 rounded font-bold uppercase border ${
                            party.inferred ? "bg-warn/10 text-warn border-warn/30" : "bg-ok/10 text-ok border-ok/30"
                          }`}
                        >
                          {party.inferred ? "Inferred" : "Fact"}
                        </span>
                      </div>
                      <div className="text-[11px] text-ops-mute mt-2 leading-relaxed">
                        Cargo: {party.cargo_desc || "General cargo"}
                      </div>
                      {party.bol_ref && <div className="mono text-[10px] text-ops-faint mt-2">BoL · {party.bol_ref}</div>}
                      {party.basis && (
                        <div className="text-[11px] text-ops-mute mt-2 leading-relaxed border-t border-ops-line/50 pt-2">
                          Basis: {party.basis}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Agent roster strip */}
        {snapshot.participants.length > 0 && (
          <div className="rounded-2xl border border-border bg-panel/70 mt-5 px-4 py-3.5 flex items-center gap-3.5 flex-wrap">
            <span className="mono text-[10px] tracking-wider text-ops-faint uppercase">Collaborating via room bus</span>
            <div className="flex gap-2 flex-wrap">
              {snapshot.participants.map((p, idx) => (
                <span key={idx} className="mono text-[11px] text-ops-mute bg-ops-bg border border-ops-line px-2.5 py-1 rounded-lg">
                  {p.role} <span className="text-ops-faint">· {p.framework}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      </main>
  );
}
