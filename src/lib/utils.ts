import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function riskColor(score: number): string {
  if (score >= 70) return "var(--danger)";
  if (score >= 45) return "var(--warn)";
  return "var(--ok)";
}

export function riskLabel(score: number): string {
  if (score >= 75) return "Critical";
  if (score >= 60) return "High";
  if (score >= 45) return "Elevated";
  if (score >= 30) return "Moderate";
  return "Low";
}

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  commodity: { label: "Commodity", icon: "🛢️" },
  freight: { label: "Freight", icon: "🚢" },
  port: { label: "Port", icon: "⚓" },
  weather: { label: "Weather", icon: "🌀" },
  geopolitical: { label: "Geopolitical", icon: "🌐" },
  supplier: { label: "Supplier", icon: "🏭" },
  regulatory: { label: "Regulatory", icon: "⚖️" },
};

export function categoryMeta(category: string) {
  return CATEGORY_META[category] ?? { label: category, icon: "📊" };
}

export function fmtUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
