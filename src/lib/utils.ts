import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Anchor,
  BarChart3,
  CloudRain,
  Factory,
  Fuel,
  Globe,
  Scale,
  Ship,
  type LucideIcon,
} from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// One table, because two of them can't be kept in agreement by discipline:
// the colour thresholds used to be 70/45 while the labels were 75/60/45/30, so
// a score of 72 read "High" but was painted danger-red, and a 50 read
// "Elevated" but was painted warn. Deriving both from one list makes that
// disagreement structurally impossible rather than merely fixed.
const RISK_BANDS = [
  { min: 75, label: "Critical", color: "var(--danger)" },
  { min: 60, label: "High", color: "var(--danger)" },
  { min: 45, label: "Elevated", color: "var(--warn)" },
  { min: 30, label: "Moderate", color: "var(--warn)" },
  { min: 0, label: "Low", color: "var(--ok)" },
] as const;

export function riskBand(score: number): { label: string; color: string } {
  return RISK_BANDS.find((band) => score >= band.min) ?? RISK_BANDS[RISK_BANDS.length - 1];
}

export function riskColor(score: number): string {
  return riskBand(score).color;
}

export function riskLabel(score: number): string {
  return riskBand(score).label;
}

// Lucide components rather than literal emoji: emoji render differently on
// every OS and sat inconsistently beside the lucide icons used everywhere else.
const CATEGORY_META: Record<string, { label: string; Icon: LucideIcon }> = {
  commodity: { label: "Commodity", Icon: Fuel },
  freight: { label: "Freight", Icon: Ship },
  port: { label: "Port", Icon: Anchor },
  weather: { label: "Weather", Icon: CloudRain },
  geopolitical: { label: "Geopolitical", Icon: Globe },
  supplier: { label: "Supplier", Icon: Factory },
  regulatory: { label: "Regulatory", Icon: Scale },
};

export function categoryMeta(category: string): { label: string; Icon: LucideIcon } {
  return CATEGORY_META[category] ?? { label: category, Icon: BarChart3 };
}

export function fmtUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
