/**
 * Shared copy for the ops room.
 *
 * The phase list and the agent roster are described in three places — the
 * stepper on a live incident, the legend on the standing-by screen, and the
 * /how-it-works page — so the descriptions live here once. That's also what
 * lets the empty state double as the explanation: it's the same data, just
 * rendered before anything has happened.
 */

export interface OpsPhase {
  key: string;
  name: string;
  detail: string;
}

export const OPS_PHASES: OpsPhase[] = [
  {
    key: "detected",
    name: "Detection",
    detail: "A Sentinel agent watching the live AIS feed spots a vessel dwelling in a monitored anchorage.",
  },
  {
    key: "negotiating",
    name: "Negotiation",
    detail: "It opens a room and recruits the other agents, who start proposing and challenging recovery options.",
  },
  {
    key: "options_collected",
    name: "Options",
    detail: "Each proposal is costed against the carrier's published demurrage tariff, not an estimate.",
  },
  {
    key: "evaluating",
    name: "Evaluating",
    detail: "The agents vote to a quorum, and an adversarial Dissent agent argues against the front-runner.",
  },
  {
    key: "awaiting_approval",
    name: "Approval gate",
    detail: "A human reads the recommendation and the objection, then approves or rejects it. Nothing acts on its own.",
  },
  { key: "approved", name: "Approved", detail: "The decision and its reasoning are recorded in an audit dossier." },
  { key: "rejected", name: "Rejected", detail: "The rejection and its reasoning are recorded just the same." },
];

export interface OpsAgent {
  role: string;
  label: string;
  framework: string;
  does: string;
}

export const OPS_AGENTS: OpsAgent[] = [
  { role: "sentinel", label: "Sentinel", framework: "LangGraph", does: "Watches AIS, opens the room, drives the phases." },
  { role: "logistics", label: "Logistics", framework: "LangGraph", does: "Proposes reroutes, holds and expedites." },
  { role: "carrier", label: "Carrier", framework: "PydanticAI", does: "Negotiates from the published tariff and FMC billing rules." },
  { role: "finance", label: "Finance", framework: "PydanticAI", does: "Costs each option against real demurrage exposure." },
  { role: "procurement", label: "Procurement", framework: "CrewAI", does: "Looks for alternate supply and air-freight cover." },
  { role: "customer_impact", label: "Customer impact", framework: "PydanticAI", does: "Assesses downstream SLA and order risk." },
  { role: "dissent", label: "Dissent", framework: "PydanticAI", does: "Argues against the leading option, on purpose." },
];

/** Phases that mean an incident is closed. */
export const RESOLVED_PHASES = ["approved", "rejected"];

export function isResolvedPhase(phase: string | null | undefined): boolean {
  return Boolean(phase) && RESOLVED_PHASES.includes(phase as string);
}
