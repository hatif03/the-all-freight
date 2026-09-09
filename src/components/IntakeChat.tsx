"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import type { IntakeResult, ShipmentInput } from "@/lib/types";

interface ChatMsg {
  role: "user" | "agent";
  text: string;
}

const MODE_OPTIONS = ["Ocean (container)", "Air", "Rail", "Truck"];
const SPECIAL_OPTIONS = ["Standard (ambient)", "Refrigerated", "Frozen", "Fragile", "Hazardous", "Organic"];

const FIELD_META: Record<string, { label: string; type: "text" | "number" | "mode" | "special"; placeholder?: string }> = {
  product: { label: "Product", type: "text", placeholder: "e.g. Plastic Chair" },
  origin: { label: "Origin", type: "text", placeholder: "Shanghai, China" },
  destination: { label: "Destination", type: "text", placeholder: "Los Angeles, USA" },
  weightKg: { label: "Weight (kg)", type: "number", placeholder: "20000" },
  pricePerKg: { label: "Price per kg (USD)", type: "number", placeholder: "3.20" },
  shipDate: { label: "Ship date", type: "text", placeholder: "September 2026" },
  shippingMode: { label: "Shipping mode", type: "mode" },
  specialRequirements: { label: "Special handling", type: "special" },
};

function computeMissing(p: Partial<ShipmentInput>): string[] {
  const m: string[] = [];
  if (!p.product) m.push("product");
  if (!p.origin) m.push("origin");
  if (!p.destination) m.push("destination");
  if (!(p.weightKg && p.weightKg > 0)) m.push("weightKg");
  if (!p.shippingMode) m.push("shippingMode");
  if (!(p.pricePerKg && p.pricePerKg > 0)) m.push("pricePerKg");
  if (!p.shipDate) m.push("shipDate");
  if (!(p.specialRequirements && p.specialRequirements.length)) m.push("specialRequirements");
  return m;
}

function greeting(): string {
  // Deterministic on the server; refined on the client after mount.
  return "Good day.";
}

export function IntakeChat({
  onReady,
  disabled,
  presets,
}: {
  onReady: (input: ShipmentInput) => void;
  disabled?: boolean;
  presets?: { label: string; short?: string; value: ShipmentInput }[];
}) {
  const [partial, setPartial] = useState<Partial<ShipmentInput>>({});
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chat, setChat] = useState("");
  const [parsing, setParsing] = useState(false);
  const [hello, setHello] = useState(greeting());
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);

  // Time-aware greeting on the client.
  useEffect(() => {
    const h = new Date().getHours();
    setHello(h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.");
  }, []);

  const setField = (k: keyof ShipmentInput, v: string | number | string[]) =>
    setPartial((p) => ({ ...p, [k]: v }));

  const toggleSpecial = (r: string) =>
    setPartial((p) => {
      const cur = p.specialRequirements ?? [];
      const next = cur.includes(r)
        ? cur.filter((x) => x !== r)
        : [...cur.filter((x) => x !== "Standard (ambient)" || r === "Standard (ambient)"), r];
      return { ...p, specialRequirements: next };
    });

  const toggleLocked = (r: string) =>
    setPartial((p) => {
      const cur = p.locked ?? [];
      return { ...p, locked: cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r] };
    });

  const submitForm = () => {
    const stillMissing = computeMissing(partial);
    if (stillMissing.length === 0) {
      setMissingFields([]);
      setMessages((m) => [...m, { role: "agent", text: "Got everything — running the analysis." }]);
      onReady(partial as ShipmentInput);
    } else {
      setMissingFields(stillMissing);
    }
  };

  const scrollDown = () =>
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });

  async function send(text: string) {
    const t = text.trim();
    if (!t || parsing || disabled) return;
    setMessages((m) => [...m, { role: "user", text: t }]);
    setChat("");
    setParsing(true);
    scrollDown();
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, current: partial }),
      });
      const data: IntakeResult = await res.json();
      if (data?.input) setPartial(data.input);
      if (data.ready) {
        setMissingFields([]);
        setMessages((m) => [...m, { role: "agent", text: "Got everything I need — running the analysis." }]);
        scrollDown();
        onReady(data.input);
      } else {
        setMissingFields(data.missingFields ?? []);
        setMessages((m) => [...m, { role: "agent", text: data.question ?? "Tell me a little more?" }]);
        scrollDown();
      }
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Sorry, I had trouble reading that — mind rephrasing?" }]);
    } finally {
      setParsing(false);
    }
  }

  const started = messages.length > 0;

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Greeting */}
      <div className="text-center mb-8">
        <h1 className="serif text-5xl sm:text-6xl tracking-tight text-foreground">{hello}</h1>
        <p className="text-foreground/70 mt-3 text-[15px] max-w-md mx-auto">
          Tell me what you&apos;re shipping, from where to where, the weight, price per kg, ship date, mode, and any
          special handling. I&apos;ll ask for anything you miss.
        </p>
      </div>

      {/* Conversation (only once it begins) */}
      {started && (
        <div ref={threadRef} className="max-h-64 overflow-y-auto space-y-2.5 mb-4 px-1">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-snug " +
                  (m.role === "user"
                    ? "bg-accent/15 border border-accent/30"
                    : "bg-panel-2 border border-border text-foreground/90")
                }
              >
                {m.text}
              </div>
            </div>
          ))}
          {parsing && (
            <div className="flex justify-start">
              <div className="rounded-2xl px-3.5 py-2.5 bg-panel-2 border border-border text-muted text-sm flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> thinking…
              </div>
            </div>
          )}
        </div>
      )}

      {/* Missing-fields form — appears when the agent still needs details */}
      {!disabled && missingFields.length > 0 && (
        <div className="mb-3 rounded-2xl border border-border bg-panel/60 p-4">
          <div className="text-[11px] mono uppercase tracking-wider text-accent mb-3">
            Fill the missing details — or just tell me above
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {missingFields.map((key) => {
              const meta = FIELD_META[key];
              if (!meta) return null;
              return (
                <div key={key} className={meta.type === "special" ? "sm:col-span-2" : ""}>
                  <label className="block text-[10px] mono uppercase tracking-wide text-muted mb-1.5">{meta.label}</label>
                  {meta.type === "text" && (
                    <input
                      value={(partial[key as keyof ShipmentInput] as string) || ""}
                      onChange={(e) => setField(key as keyof ShipmentInput, e.target.value)}
                      placeholder={meta.placeholder}
                      className="w-full rounded-lg bg-panel-2 border border-border px-3 py-2 text-sm outline-none focus:border-accent/60 transition"
                    />
                  )}
                  {meta.type === "number" && (
                    <input
                      type="number"
                      step="0.01"
                      value={(partial[key as keyof ShipmentInput] as number) || ""}
                      onChange={(e) => setField(key as keyof ShipmentInput, Number(e.target.value))}
                      placeholder={meta.placeholder}
                      className="w-full rounded-lg bg-panel-2 border border-border px-3 py-2 text-sm outline-none focus:border-accent/60 transition"
                    />
                  )}
                  {meta.type === "mode" && (
                    <div className="flex flex-wrap gap-1.5">
                      {MODE_OPTIONS.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => setField("shippingMode", o)}
                          className={
                            "text-[12px] px-2.5 py-1.5 rounded-lg border transition " +
                            (partial.shippingMode === o ? "border-accent/50 bg-accent/15 text-accent" : "border-border bg-panel-2 text-muted hover:text-foreground")
                          }
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  {meta.type === "special" && (
                    <div className="flex flex-wrap gap-1.5">
                      {SPECIAL_OPTIONS.map((o) => {
                        const on = (partial.specialRequirements ?? []).includes(o);
                        return (
                          <button
                            key={o}
                            type="button"
                            onClick={() => toggleSpecial(o)}
                            className={
                              "text-[12px] px-2.5 py-1.5 rounded-lg border transition " +
                              (on ? "border-accent/50 bg-accent/15 text-accent" : "border-border bg-panel-2 text-muted hover:text-foreground")
                            }
                          >
                            {o}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <label className="block text-[10px] mono uppercase tracking-wide text-muted mb-1.5">Already locked / paid? (optional)</label>
            <div className="flex flex-wrap gap-1.5">
              {["Goods", "Freight", "Duty"].map((r) => {
                const on = (partial.locked ?? []).includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleLocked(r)}
                    className={
                      "text-[12px] px-2.5 py-1.5 rounded-lg border transition " +
                      (on ? "border-ok/50 bg-ok/15 text-ok" : "border-border bg-panel-2 text-muted hover:text-foreground")
                    }
                  >
                    {r} {on ? "✓" : ""}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={submitForm}
            disabled={parsing}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-white font-semibold py-2.5 text-sm hover:brightness-110 transition disabled:opacity-50"
          >
            Send & analyze
          </button>
        </div>
      )}

      {/* Input pill */}
      <div className="relative">
        <input
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send(chat);
            }
          }}
          disabled={disabled || parsing}
          placeholder="Describe your shipment…"
          className="w-full rounded-full bg-panel border border-border pl-5 pr-14 py-4 text-sm outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20 transition shadow-lg placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => send(chat)}
          disabled={disabled || parsing || !chat.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 size-9 grid place-items-center rounded-full bg-accent text-white hover:brightness-110 transition disabled:opacity-40"
          aria-label="Send"
        >
          {parsing ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>

      {/* Quick-start presets */}
      {!started && presets && presets.length > 0 && (
        <div className="mt-6">
          <div className="text-center text-[11px] mono uppercase tracking-wider text-foreground/50 mb-2.5">Try one</div>
          <div className="flex flex-wrap justify-center gap-2">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onReady(p.value)}
                disabled={disabled}
                className="text-[12px] px-3.5 py-2 rounded-full border border-accent/25 bg-accent/10 text-foreground hover:bg-accent/20 hover:border-accent/50 transition disabled:opacity-50"
              >
                {p.short ?? p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
