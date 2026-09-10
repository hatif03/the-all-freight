/**
 * Client for the tracked-shipment endpoints on the ops backend.
 *
 * The frontend runs on Vercel with no database access, so persistence goes
 * through the same backend that already proxies LLM calls. Every function here
 * fails soft and returns null/[] — the backend is a separate deployment and can
 * be down while the planning flow still works perfectly well on its own.
 */

import type { AnalysisResult } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

export interface ShipmentSummary {
  id: number;
  product: string;
  origin: string;
  destination: string;
  ship_date: string | null;
  mode: string | null;
  risk_score: number;
  entry_port: string | null;
  port_code: string | null;
  port_name: string | null;
  port_match_field: string | null;
  port_match_basis: string | null;
  monitored: boolean;
  open_incident_count: number;
  created_at: string | null;
}

export interface LinkedIncident {
  incident_id: number;
  phase: string;
  port: string | null;
  type: string | null;
  severity: string | null;
  detected_at: string | null;
  inferred: boolean;
  basis: string;
}

export interface MonitorSignal {
  id: number;
  kind: string;
  monitor: string;
  summary: string;
  source_url: string;
  detected_at: string | null;
}

export interface WatchedMonitor {
  label: string;
  kind: string;
  url: string;
  interval_minutes: number;
}

export interface ShipmentDetail extends ShipmentSummary {
  analysis: AnalysisResult;
  incidents: LinkedIncident[];
  monitor_signals: MonitorSignal[];
  monitors: WatchedMonitor[];
}

export function shipmentsConfigured(): boolean {
  return Boolean(API_BASE);
}

export async function listShipments(): Promise<ShipmentSummary[]> {
  if (!API_BASE) return [];
  try {
    const res = await fetch(`${API_BASE}/shipments`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as ShipmentSummary[];
  } catch {
    return [];
  }
}

export async function getShipment(id: number | string): Promise<ShipmentDetail | null> {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${API_BASE}/shipments/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ShipmentDetail;
  } catch {
    return null;
  }
}

/**
 * Persist an analysis as a tracked shipment.
 *
 * Sends the whole AnalysisResult and nothing else: the backend derives the
 * summary fields and resolves the monitored port itself, so there's exactly one
 * implementation of "what port does this lane mean".
 *
 * Throws on failure — unlike the read paths, the user pressed a button here and
 * needs to be told if it didn't work.
 */
export async function trackShipment(analysis: AnalysisResult): Promise<ShipmentDetail> {
  if (!API_BASE) throw new Error("Tracking is unavailable: no backend configured.");
  const res = await fetch(`${API_BASE}/shipments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis }),
  });
  if (!res.ok) {
    throw new Error(`Could not track this shipment (${res.status}).`);
  }
  return (await res.json()) as ShipmentDetail;
}

export async function deleteShipment(id: number): Promise<void> {
  if (!API_BASE) throw new Error("Tracking is unavailable: no backend configured.");
  const res = await fetch(`${API_BASE}/shipments/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Could not remove this shipment (${res.status}).`);
  }
}
