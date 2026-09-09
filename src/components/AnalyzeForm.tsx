"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import type { ShipmentInput } from "@/lib/types";

export const SHIP_MODES = ["Ocean (container)", "Air", "Rail", "Truck"];
export const CONTAINER_SIZES = ["20ft", "40ft", "40ft HC", "LCL", "Pallets", "Air ULD"];
export const SPECIAL_REQS = ["Standard (ambient)", "Refrigerated", "Frozen", "Fragile", "Hazardous", "Organic"];

export const PRESETS: { label: string; short: string; value: ShipmentInput }[] = [
  {
    label: "10,000 Plastic Chairs · Shanghai → LA",
    short: "Plastic chairs → LA",
    value: { product: "Plastic Chair", origin: "Shanghai, China", destination: "Los Angeles, USA", weightKg: 20000, quantity: 10000, shipDate: "September 2026", shippingMode: "Ocean (container)", containerSize: "40ft HC", pricePerKg: 3.2, specialRequirements: ["Standard (ambient)"] },
  },
  {
    label: "Lithium Batteries · Shenzhen → Rotterdam",
    short: "Batteries → Rotterdam",
    value: { product: "Lithium-ion Battery Pack", origin: "Shenzhen, China", destination: "Rotterdam, Netherlands", weightKg: 12000, quantity: 5000, shipDate: "August 2026", shippingMode: "Ocean (container)", containerSize: "40ft", pricePerKg: 24, specialRequirements: ["Hazardous"] },
  },
  {
    label: "Cotton T-Shirts · Dhaka → New York",
    short: "Cotton tees → New York",
    value: { product: "Cotton T-Shirt", origin: "Dhaka, Bangladesh", destination: "New York, USA", weightKg: 8000, quantity: 40000, shipDate: "October 2026", shippingMode: "Ocean (container)", containerSize: "40ft HC", pricePerKg: 8, specialRequirements: ["Standard (ambient)"] },
  },
];

const field = "w-full rounded-lg bg-panel-2 border border-border px-3 py-2.5 text-sm outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/30 transition";
const label = "block text-[11px] mono text-muted mb-1.5 uppercase tracking-wide";

export function AnalyzeForm({
  onSubmit,
  loading,
  initial,
}: {
  onSubmit: (input: ShipmentInput) => void;
  loading: boolean;
  initial?: ShipmentInput;
}) {
  const [input, setInput] = useState<ShipmentInput>(initial ?? PRESETS[0].value);
  const set = (patch: Partial<ShipmentInput>) => setInput((p) => ({ ...p, ...patch }));

  return (
    <div className="rounded-2xl border border-border bg-panel/70 p-5 sm:p-6">
      <div className="flex flex-wrap gap-2 mb-5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setInput(p.value)}
            disabled={loading}
            className="text-[11px] mono px-2.5 py-1.5 rounded-md border border-border bg-panel-2 text-muted hover:text-foreground hover:border-accent/40 transition disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading) onSubmit(input);
        }}
        className="grid grid-cols-1 sm:grid-cols-2 gap-4"
      >
        <div className="sm:col-span-2">
          <label className={label}>Product</label>
          <input className={field} value={input.product} onChange={(e) => set({ product: e.target.value })} placeholder="e.g. Plastic Chair" required />
        </div>
        <div>
          <label className={label}>Origin</label>
          <input className={field} value={input.origin} onChange={(e) => set({ origin: e.target.value })} placeholder="Shanghai, China" required />
        </div>
        <div>
          <label className={label}>Destination</label>
          <input className={field} value={input.destination} onChange={(e) => set({ destination: e.target.value })} placeholder="Los Angeles, USA" required />
        </div>
        <div>
          <label className={label}>Weight (kg)</label>
          <input type="number" className={field} value={input.weightKg || ""} onChange={(e) => set({ weightKg: Number(e.target.value) })} placeholder="20000" />
        </div>
        <div>
          <label className={label}>Price per kg (USD)</label>
          <input type="number" step="0.01" className={field} value={input.pricePerKg || ""} onChange={(e) => set({ pricePerKg: Number(e.target.value) })} placeholder="3.20" />
        </div>
        <div>
          <label className={label}>Shipping Mode</label>
          <select className={field} value={input.shippingMode || ""} onChange={(e) => set({ shippingMode: e.target.value })}>
            <option value="">Select…</option>
            {SHIP_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Container / Load</label>
          <select className={field} value={input.containerSize || ""} onChange={(e) => set({ containerSize: e.target.value })}>
            <option value="">Select…</option>
            {CONTAINER_SIZES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Quantity (units)</label>
          <input type="number" className={field} value={input.quantity || ""} onChange={(e) => set({ quantity: Number(e.target.value) })} placeholder="10000" />
        </div>
        <div>
          <label className={label}>Desired Ship Date</label>
          <input className={field} value={input.shipDate} onChange={(e) => set({ shipDate: e.target.value })} placeholder="September 2026" />
        </div>

        <div className="sm:col-span-2">
          <label className={label}>Special Handling</label>
          <div className="flex flex-wrap gap-2">
            {SPECIAL_REQS.map((r) => {
              const on = (input.specialRequirements ?? []).includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    const cur = input.specialRequirements ?? [];
                    set({ specialRequirements: on ? cur.filter((x) => x !== r) : [...cur.filter((x) => x !== "Standard (ambient)" || r === "Standard (ambient)"), r] });
                  }}
                  className={
                    "text-[12px] px-3 py-1.5 rounded-full border transition " +
                    (on ? "border-accent/50 bg-accent/15 text-accent" : "border-border bg-panel-2 text-muted hover:text-foreground")
                  }
                >
                  {r}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className={label}>Already locked / paid? (optional)</label>
          <div className="flex flex-wrap gap-2">
            {["Goods", "Freight", "Duty"].map((r) => {
              const on = (input.locked ?? []).includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    const cur = input.locked ?? [];
                    set({ locked: on ? cur.filter((x) => x !== r) : [...cur, r] });
                  }}
                  className={
                    "text-[12px] px-3 py-1.5 rounded-full border transition " +
                    (on ? "border-ok/50 bg-ok/15 text-ok" : "border-border bg-panel-2 text-muted hover:text-foreground")
                  }
                >
                  {r} {on ? "✓" : ""}
                </button>
              );
            })}
          </div>
          <div className="text-[10px] mono text-muted mt-1.5">Lock what you&apos;ve committed — the dashboard only shows exposure on what&apos;s still open.</div>
        </div>

        <div className="sm:col-span-2 mt-1">
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-white font-semibold py-3 text-sm hover:brightness-110 transition disabled:opacity-60"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {loading ? "Running intelligence analysis…" : "Run Risk Analysis"}
          </button>
        </div>
      </form>
    </div>
  );
}
