"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
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
  ArrowLeft,
  Package,
  Check,
} from "lucide-react";
import { Badge, Button, EmptyState, Panel } from "@/components/ui";
import { CostTicker } from "@/components/CostTicker";
import { DUR, EASE, fadeUp, popIn } from "@/lib/motion";
import { OPS_PHASES } from "@/lib/ops";

// MapLibre touches the DOM/window at map-construction time, so load it client-side only.
const VesselMap = dynamic(() => import("@/components/VesselMap").then((m) => m.VesselMap), {
  ssr: false,
  loading: () => (
    <div className="skeleton border border-border rounded-2xl h-[300px] md:h-[340px] grid place-items-center text-muted text-xs mono">
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

interface LinkedShipment {
  id: number;
  product: string;
  origin: string;
  destination: string;
  inferred: boolean;
  basis: string;
}

interface IncidentSnapshot {
  incident: Incident | null;
  event: DisruptionEvent | null;
  affected_parties: AffectedParty[];
  options: RecoveryOption[];
  participants: Participant[];
  recommendation: Recommendation | null;
  dissent: Dissent | null;
  linked_shipments?: LinkedShipment[];
}

interface RoomEvent {
  kind:
    | "room_created"
    | "agent_recruited"
    | "message"
    | "option_added"
    | "phase_change"
    | "decision"
    | "monitor_signal";
  room_id: string;
  ts: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  /** Stamped on arrival so a prepending list has stable keys. */
  _seq?: number;
}

const EMPTY_SNAPSHOT: IncidentSnapshot = {
  incident: null,
  event: null,
  affected_parties: [],
  options: [],
  participants: [],
  recommendation: null,
  dissent: null,
  linked_shipments: [],
};

const PHASE_DETAIL: Record<string, string> = Object.fromEntries(OPS_PHASES.map((p) => [p.key, p.detail]));

const PHASES = [
  { key: "detected", name: "Detection" },
  { key: "negotiating", name: "Negotiation" },
  { key: "options_collected", name: "Options" },
  { key: "evaluating", name: "Evaluating" },
  { key: "awaiting_approval", name: "Approval Gate" },
  { key: "approved", name: "Approved" },
  { key: "rejected", name: "Rejected" },
];

/** Three honest states. "Reconnecting" forever is a lie — after a few failed
 *  attempts the backend being unreachable is simply a fact, and saying so reads
 *  as a working product with a status line rather than a broken one. */
type Connection = "connecting" | "live" | "offline";

export default function OpsIncidentPage() {
  const params = useParams<{ id: string }>();
  const incidentId = params.id;

  const [snapshot, setSnapshot] = useState<IncidentSnapshot>(EMPTY_SNAPSHOT);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">("loading");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [wsEvents, setWsEvents] = useState<RoomEvent[]>([]);
  const [decisionReason, setDecisionReason] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [selectedDecisionOption, setSelectedDecisionOption] = useState<number | null>(null);
  const [tariffState, setTariffState] = useState<{
    loading: boolean;
    result?: { loaded: number; source_url: string };
    error?: string;
  }>({ loading: false });

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws";

  const fetchIncident = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/incidents/${incidentId}`);
      if (!res.ok) {
        setLoadState("missing");
        return;
      }
      const data = await res.json();
      if (data && data.incident) {
        setSnapshot(data);
        setLoadState("ready");
        if (data.recommendation) setSelectedDecisionOption(data.recommendation.option_id);
      } else {
        setLoadState("missing");
      }
    } catch (err) {
      console.error("Failed to fetch incident snapshot:", err);
      // A fetch failure is a connectivity problem, not a missing incident —
      // don't tell the user their incident is gone because the VM is down.
      setLoadState((prev) => (prev === "loading" ? "loading" : prev));
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

  // Published per-day D&D rates for reefer vs. dry cargo, as a per-second rate
  // for the ticker. Computed here (cheap) but accrued inside <CostTicker/>, so
  // the whole page doesn't re-render on every tick.
  const reeferCount = snapshot.affected_parties.filter(
    (p) => p.cargo_desc.toLowerCase().includes("reefer") || p.cargo_desc.toLowerCase().includes("temp"),
  ).length;
  const dryCount = Math.max(1, snapshot.affected_parties.length - reeferCount);
  const ratePerSecond = (reeferCount * 350 + dryCount * 150) / 86400;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let closed = false;
    // Event ids stamped at insert time. The feed prepends, so an array index
    // would re-key every existing item on each arrival and React would reuse
    // the wrong DOM nodes — which also makes exit/enter animation land on the
    // wrong element.
    let seq = 0;

    const load = async () => {
      await fetchIncident();
    };
    load();

    const connectWS = () => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        attempts = 0;
        setConnection("live");
        load();
      };

      socket.onmessage = (event) => {
        try {
          const parsed: RoomEvent = JSON.parse(event.data);
          // Ignore chatter from other incidents' rooms; this page is one room.
          if (parsed.room_id && parsed.room_id !== String(incidentId) && parsed.kind !== "monitor_signal") {
            return;
          }
          setWsEvents((prev) => [{ ...parsed, _seq: ++seq }, ...prev]);

          if (parsed.kind === "phase_change") {
            setSnapshot((prev) =>
              prev.incident ? { ...prev, incident: { ...prev.incident, phase: parsed.payload.phase } } : prev,
            );
            load();
          } else if (
            parsed.kind === "option_added" ||
            parsed.kind === "decision" ||
            parsed.kind === "room_created"
          ) {
            load();
          }
        } catch {
          console.warn("WS received non-JSON message:", event.data);
          setWsEvents((prev) => [
            {
              kind: "message",
              room_id: "",
              ts: new Date().toISOString(),
              payload: { sender: "System", text: event.data },
              _seq: ++seq,
            },
            ...prev,
          ]);
        }
      };

      socket.onclose = () => {
        if (closed) return;
        attempts += 1;
        setConnection(attempts >= 2 ? "offline" : "connecting");
        // Capped backoff. A flat 3s retry forever meant that on the deployed
        // URL with the backend down, this hammered the network tab
        // indefinitely.
        const delay = Math.min(3000 * 2 ** (attempts - 1), 30000);
        reconnectTimeout = setTimeout(connectWS, delay);
      };

      socket.onerror = (err) => console.error("WS connection error:", err);
    };

    connectWS();
    return () => {
      closed = true;
      socket?.close();
      clearTimeout(reconnectTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const handleDecision = async (action: "approve" | "reject") => {
    if (!snapshot.incident) return;
    setSubmittingDecision(true);
    setDecisionError(null);
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
        // Inline rather than alert(): this is the most consequential action in
        // the product and a browser dialog was the most unfinished thing in it.
        setDecisionError(`Could not record the decision (${res.status} ${res.statusText}).`);
      }
    } catch (err) {
      console.error("Error submitting decision:", err);
      setDecisionError("Network error — the decision was not recorded. Check the ops backend and try again.");
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

  // `?? null` rather than `|| "detected"`. Defaulting to a real phase is what
  // used to make an empty console blink step 1 as if something were happening.
  const activePhase = snapshot.incident?.phase ?? null;
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

  const isLive = connection === "live";

  if (loadState === "loading") {
    return (
      <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-5">
        <div className="skeleton h-24 rounded-2xl border border-border mb-5" />
        <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-5">
          <div className="skeleton h-96 rounded-2xl border border-border" />
          <div className="skeleton h-96 rounded-2xl border border-border" />
        </div>
      </main>
    );
  }

  if (loadState === "missing") {
    return (
      <main className="flex-1 mx-auto w-full max-w-7xl px-5 py-8">
        <Panel>
          <EmptyState
            icon={Info}
            title={`Incident #${incidentId} not found`}
            body="It may never have existed, or the ops backend may be unreachable from here."
            action={
              <Link href="/ops">
                <Button>
                  <ArrowLeft className="size-3.5" /> All incidents
                </Button>
              </Link>
            }
          />
        </Panel>
      </main>
    );
  }

  return (
      <main className="flex-1 font-sans">
      <div className="mx-auto max-w-7xl px-5 py-5">
        <Link
          href="/ops"
          className="inline-flex items-center gap-1.5 text-[11px] mono text-muted hover:text-foreground transition mb-4"
        >
          <ArrowLeft className="size-3.5" /> All incidents
        </Link>

        {/* Which tracked shipments this incident actually touches — the reverse
            of the link shown on the shipment page, and the thing that stops the
            ops room reading as an anonymous global feed. */}
        {snapshot.linked_shipments && snapshot.linked_shipments.length > 0 && (
          <motion.div {...fadeUp} className="mb-4">
            <Panel size="sm" className="border-accent/40 bg-accent/5">
              <div className="flex items-start gap-3">
                <Package className="size-4 text-accent mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium mb-1">
                    Affects {snapshot.linked_shipments.length} shipment
                    {snapshot.linked_shipments.length > 1 ? "s" : ""} you&apos;re tracking
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {snapshot.linked_shipments.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/shipments/${s.id}`}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition"
                          title={s.basis}
                        >
                          {s.product} · {s.origin} → {s.destination}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-muted mt-2 leading-snug">
                    Matched at the port level — this does not establish that the cargo is aboard the affected
                    vessel.
                  </p>
                </div>
              </div>
            </Panel>
          </motion.div>
        )}

        {/* Incident context + phase card — one card instead of two stacked sticky bars,
            matching the landing page's card conventions. */}
        <div className="rounded-2xl border border-border bg-panel shadow-panel mb-5">
          <div className="flex items-center justify-between gap-4 px-4 md:px-5 py-3 border-b border-border">
            <div className="flex items-center gap-2 mono text-xs text-muted min-w-0">
              <span className="text-muted/70">incident</span>
              <span className="text-foreground font-semibold">#{snapshot.incident?.id ?? incidentId}</span>
              <span className="text-muted/70">/</span>
              <span className="truncate">{snapshot.event?.port || "—"}</span>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="hidden sm:flex items-center gap-2 bg-ok/8 border border-ok/25 px-3 py-1.5 rounded-lg">
                <span className="relative w-[7px] h-[7px]">
                  <span className="absolute inset-0 rounded-full bg-ok" />
                  <span className="absolute inset-0 rounded-full bg-ok pulse-ring" />
                </span>
                <span className="mono text-[11px] text-ok font-semibold">LIVE AIS</span>
              </div>

              {connection === "offline" ? (
                <Badge tone="neutral" title="The ops backend isn't reachable from this browser.">
                  ops backend offline
                </Badge>
              ) : (
                <Badge tone={isLive ? "accent" : "neutral"} dot pulse={!isLive}>
                  {isLive ? "room bus connected" : "connecting…"}
                </Badge>
              )}

              <button
                onClick={fetchIncident}
                title="Refresh data"
                className="w-[34px] h-[34px] rounded-lg bg-panel-2 border border-border flex items-center justify-center text-muted hover:text-foreground transition-colors cursor-pointer"
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
                    : "bg-panel border-border text-muted/70";

              const isDone = isCompleted || isApprovedStep || isRejectedStep;
              return (
                <div key={p.key} className="flex items-center">
                  <div className="flex items-center gap-2.5 pr-2" title={PHASE_DETAIL[p.key]}>
                    {/* Keyed on state so the circle re-mounts and pops when a
                        step completes — the stepper advancing is the whole
                        story of an incident, told in one widget. */}
                    <motion.div
                      key={`${p.key}-${isDone ? "done" : isActive ? "active" : "idle"}`}
                      {...popIn}
                      className={`w-5 h-5 rounded-full border-[1.5px] flex items-center justify-center text-[11px] font-bold ${circleCls}`}
                    >
                      {isDone ? (
                        isRejectedStep ? (
                          <XCircle className="size-3" />
                        ) : (
                          <Check className="size-3" />
                        )
                      ) : (
                        fullIdx + 1
                      )}
                    </motion.div>
                    <span
                      className={`text-[13px] font-semibold whitespace-nowrap ${
                        isActive ? "text-foreground" : isCompleted ? "text-foreground" : isApprovedStep || isRejectedStep ? accentText : "text-muted/70"
                      }`}
                    >
                      {p.name}
                    </span>
                  </div>
                  {i < visiblePhases.length - 1 && (
                    <div className="h-px w-8 sm:w-12 mx-2 bg-border relative overflow-hidden">
                      <motion.div
                        className="absolute inset-0 bg-ok origin-left"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: fullIdx < activeIndex || isResolved ? 1 : 0 }}
                        transition={{ duration: DUR.slow, ease: EASE }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex-1" />
            <div className="mono text-[11px] text-muted/70 whitespace-nowrap pl-4">
              phase ·{" "}
              <span className={isResolved ? (activePhase === "approved" ? "text-accent" : "text-danger") : "text-ok"}>
                {activePhase}
              </span>
            </div>
          </div>
          </div>
        </div>

        {/* Body grid */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-5">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="bg-panel border border-border rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  {snapshot.event?.severity && (
                    <span className="mono text-[9px] text-danger bg-danger/10 border border-danger/30 px-1.5 py-0.5 rounded font-bold uppercase">
                      {snapshot.event.severity} severity
                    </span>
                  )}
                  {snapshot.event?.type && (
                    <span className="mono text-[9px] tracking-wider text-muted uppercase">
                      {snapshot.event.type.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <div className="mono text-[10px] text-muted/70 tracking-wider">INCIDENT TARGET</div>
                <div className="text-xl font-extrabold tracking-tight mt-1.5 leading-tight">
                  {snapshot.event ? snapshot.event.vessel : "No active incident"}
                </div>
                {snapshot.event && (
                  <div className="text-muted text-[11px] mt-2 mono leading-relaxed">
                    MMSI {snapshot.event.mmsi} · detected {formatTime(snapshot.event.detected_at)}
                  </div>
                )}
              </div>

              <div className="rounded-2xl p-4 relative overflow-hidden border border-danger/30 bg-danger/8">
                <div className="mono text-[10px] tracking-wider text-danger/80">D&amp;D COST OF INACTION · ACCRUING</div>
                <div className="mono text-[32px] font-bold text-danger tracking-tight mt-2 leading-none tabular-nums">
                  {snapshot.event ? (
                    <CostTicker detectedAt={snapshot.event.detected_at} ratePerSecond={ratePerSecond} />
                  ) : (
                    "—"
                  )}
                </div>
                <div className="text-[11px] mt-2.5 mono text-muted leading-relaxed">
                  published carrier demurrage tariff
                </div>
              </div>
            </div>

            <VesselMap apiBaseUrl={apiBaseUrl} disruptedMmsi={snapshot.event?.mmsi} port={snapshot.event?.port} />

            {/* Recovery options matrix */}
            <div className="bg-panel border border-border rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-bold">Recovery options</span>
                  <span className="mono text-[10px] text-muted bg-panel-2 border border-border px-2 py-0.5 rounded">
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

              <div className="grid grid-cols-[1.1fr_0.9fr_0.7fr_1.7fr] gap-3 mono text-[9px] tracking-wider text-muted/70 uppercase pb-2.5 px-2 border-b border-border">
                <div className="min-w-0">Proposer · strategy</div>
                <div className="min-w-0">Feasibility</div>
                <div className="text-right min-w-0">ETA Δ</div>
                <div className="text-right min-w-0">D&amp;D cost Δ · rationale</div>
              </div>

              {snapshot.options.length === 0 ? (
                <div className="py-6 text-muted/70 italic text-center text-xs">
                  Waiting for agents to propose tariff-grounded recovery options…
                </div>
              ) : (
                snapshot.options.map((opt) => {
                  const isRecommended = snapshot.recommendation?.option_id === opt.id;
                  const feas = opt.feasibility?.toLowerCase();
                  const feasColor = feas === "high" ? "text-ok" : feas === "medium" ? "text-warn" : "text-danger";
                  const etaColor = opt.eta_delta_hours <= 0 ? "text-foreground" : opt.eta_delta_hours >= 100 ? "text-danger" : "text-warn";

                  return (
                    <div key={opt.id}>
                      <div
                        className={`grid grid-cols-[1.1fr_0.9fr_0.7fr_1.7fr] gap-3 items-center min-w-0 px-2 ${
                          isRecommended
                            ? "py-3.5 mt-2 bg-ok/8 border border-ok/30 rounded-xl"
                            : "py-3.5 border-b border-border/50"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.proposer === "logistics" ? "bg-ok" : "bg-warn"}`} />
                            <span className="text-xs font-semibold capitalize truncate">{opt.proposer}</span>
                          </div>
                          <div className={`mono text-[13px] font-bold mt-1.5 uppercase truncate ${isRecommended ? "text-ok" : "text-foreground"}`}>
                            {opt.type}
                          </div>
                        </div>
                        <div className={`text-xs font-semibold min-w-0 truncate ${feasColor}`}>{opt.feasibility}</div>
                        <div className={`text-right mono text-[13px] min-w-0 ${etaColor}`}>
                          {opt.eta_delta_hours > 0 ? `+${opt.eta_delta_hours}` : opt.eta_delta_hours} h
                        </div>
                        <div className="text-right min-w-0">
                          <span className={`mono text-[13px] font-bold ${opt.cost_delta !== null ? (isRecommended ? "text-foreground" : feas === "low" ? "text-danger" : "text-foreground") : "text-muted/70"}`}>
                            {opt.cost_delta !== null ? `$${opt.cost_delta.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
                          </span>
                          <div className="text-[11px] text-muted mt-1 truncate" title={opt.rationale || ""}>
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
              <div className="rounded-2xl p-4 md:p-5 border border-accent/40 bg-panel shadow-panel">
                <div className="flex items-center gap-2.5 border-b border-border pb-3">
                  <ShieldCheck className="h-6 w-6 text-accent" />
                  <div>
                    <h2 className="text-base font-bold text-foreground">Ops Manager approval gate</h2>
                    <p className="text-[11px] text-muted">Review the recommendation and authorize recovery</p>
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
                      <div className="text-base font-bold text-foreground flex items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded bg-accent text-white font-bold text-xs uppercase">
                          {snapshot.recommendation.type}
                        </span>
                        <span className="text-foreground text-sm">by {snapshot.recommendation.proposer}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] text-muted/70 mono">ETA Δ</div>
                        <div className="text-sm font-bold text-foreground mono">+{snapshot.recommendation.eta_delta_hours} h</div>
                      </div>
                    </div>

                    <p className="text-xs text-muted italic border-l-2 border-accent/50 pl-3">
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
                    <p className="text-xs text-muted leading-relaxed">{snapshot.dissent.objection}</p>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="px-1.5 py-0.5 bg-danger/10 text-danger border border-danger/20 font-bold rounded mono">
                        Material: {snapshot.dissent.material ? "YES" : "NO"}
                      </span>
                      <span className="mono text-muted/70">target option #{snapshot.dissent.target_option_id}</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2.5 mt-4">
                  <label className="text-xs font-semibold text-muted">Decision rationale / comments</label>
                  <textarea
                    value={decisionReason}
                    onChange={(e) => setDecisionReason(e.target.value)}
                    placeholder="State your operational justification for authorization / rejection…"
                    className="bg-panel-2 border border-border p-3 rounded-xl text-xs h-20 text-foreground placeholder-muted/70 focus:outline-none focus:border-accent-2 resize-none font-sans"
                  />
                </div>

                {decisionError && (
                  <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger px-3 py-2.5 text-[12px] leading-snug">
                    {decisionError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 pt-3">
                  <button
                    onClick={() => handleDecision("approve")}
                    disabled={submittingDecision || !decisionReason}
                    className="py-2.5 rounded-xl text-xs font-bold bg-ok/90 hover:bg-ok disabled:bg-panel disabled:text-muted/70 text-white flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Approve plan
                  </button>
                  <button
                    onClick={() => handleDecision("reject")}
                    disabled={submittingDecision || !decisionReason}
                    className="py-2.5 rounded-xl text-xs font-bold bg-danger/90 hover:bg-danger disabled:bg-panel disabled:text-muted/70 text-white flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
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
                    <div className="text-xs text-muted">Operational gate locked &amp; executed</div>
                  </div>
                </div>
                <div className="bg-panel border border-border rounded-xl p-3.5">
                  <div className="mono text-[9px] tracking-wider text-muted/70">HUMAN DECISION LOG</div>
                  <div className="text-[13px] text-foreground mt-1.5 italic">
                    &quot;Authorization submitted by Ops Manager. Phase advanced.&quot;
                  </div>
                </div>
                <a
                  href={`${apiBaseUrl}/incidents/${snapshot.incident.id}/dossier`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold bg-panel hover:bg-border/40 border border-border text-accent-2 mono transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  Download audit dossier
                </a>
              </div>
            )}

            {/* Room feed */}
            <div className="bg-panel border border-border rounded-2xl flex flex-col h-[480px]">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-accent-2" />
                  <h2 className="font-bold text-[15px]">Room feed</h2>
                </div>
                <span className="mono text-[9px] text-ok flex items-center gap-1.5">
                  <span className="w-[5px] h-[5px] rounded-full bg-ok animate-ops-blink" />
                  SYNC
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
                {wsEvents.length === 0 ? (
                  <EmptyState
                    icon={MessageSquare}
                    title="Nothing has happened yet"
                    body="When a disruption is detected the agents introduce themselves here, and you watch them disagree in real time."
                  />
                ) : (
                  wsEvents.map((evt, i) => {
                    const key = evt._seq ?? `idx-${i}`;
                    const timestampStr = formatTime(evt.ts);

                    switch (evt.kind) {
                      case "room_created":
                        return (
                          <div key={key} data-feed-item className="bg-accent-2/6 border border-accent-2/20 p-3.5 rounded-xl flex flex-col gap-1.5">
                            <div className="flex justify-between items-center mono text-[10px] text-accent-2 font-bold uppercase tracking-wider">
                              <span>Room opened</span>
                              <span className="text-muted/70">{timestampStr}</span>
                            </div>
                            <div className="text-xs font-bold text-foreground">
                              Incident room created for <span className="text-accent-2">{evt.payload.vessel}</span> @ {evt.payload.port}
                            </div>
                            <div className="mono text-[10px] text-muted/70">incident #{evt.payload.incident_id}</div>
                          </div>
                        );

                      case "agent_recruited":
                        return (
                          <div key={key} data-feed-item className="bg-panel-2 border border-border p-3 rounded-xl flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg bg-accent-2/10 border border-accent-2/25 flex items-center justify-center mono text-[11px] font-bold text-accent-2 uppercase">
                                {evt.payload.role?.slice(0, 2)}
                              </div>
                              <div>
                                <div className="text-xs font-semibold capitalize">{evt.payload.role} joined</div>
                                <div className="mono text-[10px] text-muted/70">framework · {evt.payload.framework || "Agent"}</div>
                              </div>
                            </div>
                            <span className="mono text-[9px] text-ok bg-ok/10 border border-ok/30 px-2 py-1 rounded font-bold uppercase">
                              Joined
                            </span>
                          </div>
                        );

                      case "option_added":
                        return (
                          <div key={key} data-feed-item className="border-l-2 border-warn bg-warn/8 rounded-r-xl p-3 flex flex-col gap-1.5">
                            <div className="flex justify-between items-center mono text-[10px] text-warn font-bold uppercase tracking-wider">
                              <span>Option proposed</span>
                              <span className="text-muted">{timestampStr}</span>
                            </div>
                            <div className="flex justify-between items-baseline">
                              <span className="text-sm font-bold uppercase text-foreground">{evt.payload.type}</span>
                              <span className="mono text-sm font-bold text-warn">
                                {evt.payload.cost_delta !== null && evt.payload.cost_delta !== undefined ? `$${evt.payload.cost_delta.toLocaleString()}` : "—"}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted">
                              by {evt.payload.proposer} · ETA change {evt.payload.eta_delta_hours} hrs
                            </div>
                          </div>
                        );

                      case "phase_change":
                        return (
                          <div key={key} data-feed-item className="flex justify-center my-1">
                            <div className="px-3 py-1 rounded-full bg-panel-2 border border-border text-muted mono text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5">
                              <Clock className="h-3 w-3 text-accent-2" />
                              Phase · <span className="text-foreground font-extrabold">{evt.payload.phase}</span>
                            </div>
                          </div>
                        );

                      case "decision": {
                        const isApp = evt.payload.action?.toLowerCase() === "approve";
                        return (
                          <div
                            key={key}
                            className={`border p-4 rounded-xl flex flex-col gap-2 ${
                              isApp ? "bg-ok/6 border-ok/25" : "bg-danger/6 border-danger/25"
                            }`}
                          >
                            <div className="flex justify-between items-center mono text-[10px] font-bold uppercase tracking-wider">
                              <span className={isApp ? "text-ok" : "text-danger"}>Human gate · {evt.payload.action}d</span>
                              <span className="text-muted/70">{timestampStr}</span>
                            </div>
                            <div className="text-xs text-foreground">
                              <span className="font-bold text-foreground">{evt.payload.actor}</span>: &quot;{evt.payload.reason}&quot;
                            </div>
                            {evt.payload.option_id && (
                              <div className="mono text-[10px] text-muted/70">target option #{evt.payload.option_id}</div>
                            )}
                          </div>
                        );
                      }

                      case "message":
                      default: {
                        const sender = evt.payload.sender || "Agent";
                        return (
                          <div key={key} data-feed-item className="py-3 border-b border-border/50 last:border-b-0">
                            <div className="flex justify-between items-center mb-1.5">
                              <span className="text-xs font-bold text-foreground capitalize">{sender}</span>
                              <span className="mono text-[10px] text-muted/70">{timestampStr}</span>
                            </div>
                            <p className="text-xs text-muted leading-relaxed font-sans whitespace-pre-wrap">
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
            <div className="bg-panel border border-border rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bold text-sm">Affected importers</h2>
                <span className="mono text-[9px] text-ok bg-ok/10 border border-ok/30 px-2 py-1 rounded font-bold uppercase">
                  Live DB
                </span>
              </div>

              <div className="space-y-3 max-h-[210px] overflow-y-auto scrollbar-thin pr-1">
                {snapshot.affected_parties.length === 0 ? (
                  <p className="text-muted/70 text-xs italic text-center py-4">No affected importers identified yet.</p>
                ) : (
                  snapshot.affected_parties.map((party, idx) => (
                    <div key={idx} className="bg-panel-2 border border-border p-3 rounded-xl">
                      <div className="flex justify-between items-start gap-3">
                        <div className="text-sm font-bold text-foreground">{party.importer_name}</div>
                        <span
                          className={`flex-shrink-0 mono text-[9px] px-2 py-0.5 rounded font-bold uppercase border ${
                            party.inferred ? "bg-warn/10 text-warn border-warn/30" : "bg-ok/10 text-ok border-ok/30"
                          }`}
                        >
                          {party.inferred ? "Inferred" : "Fact"}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted mt-2 leading-relaxed">
                        Cargo: {party.cargo_desc || "General cargo"}
                      </div>
                      {party.bol_ref && <div className="mono text-[10px] text-muted/70 mt-2">BoL · {party.bol_ref}</div>}
                      {party.basis && (
                        <div className="text-[11px] text-muted mt-2 leading-relaxed border-t border-border/50 pt-2">
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
          <div className="rounded-2xl border border-border bg-panel shadow-panel mt-5 px-4 py-3.5 flex items-center gap-3.5 flex-wrap">
            <span className="mono text-[10px] tracking-wider text-muted/70 uppercase">Collaborating via room bus</span>
            <div className="flex gap-2 flex-wrap">
              {snapshot.participants.map((p, idx) => (
                <span key={idx} className="mono text-[11px] text-muted bg-panel-2 border border-border px-2.5 py-1 rounded-lg">
                  {p.role} <span className="text-muted/70">· {p.framework}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      </main>
  );
}
