// Thin LLM wrapper used by the agent layer. Calls the ops-room backend's
// `/llm/complete` proxy rather than Vertex AI directly: Vercel (where this app
// deploys) has no Application Default Credentials, and the backend's VM
// already has clean ADC via its attached GCP service account — so no GCP
// credentials of any kind need to live in this app's environment.

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
export const hasLLM = Boolean(API_BASE);

async function complete(opts: {
  system: string;
  user: string;
  jsonMode: boolean;
  temperature: number;
}): Promise<string | null> {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${API_BASE}/llm/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: opts.system,
        user: opts.user,
        json_mode: opts.jsonMode,
        temperature: opts.temperature,
      }),
    });
    if (!res.ok) {
      console.error(`[llm] /llm/complete failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return typeof data?.result === "string" ? data.result : null;
  } catch (err) {
    console.error("[llm] /llm/complete request failed:", err);
    return null;
  }
}

/**
 * Ask the model for a JSON object matching the described shape.
 * Returns `fallback` if the backend is unavailable or the response can't be parsed.
 */
export async function jsonCompletion<T>(opts: {
  system: string;
  user: string;
  fallback: T;
}): Promise<T> {
  const raw = await complete({ system: opts.system, user: opts.user, jsonMode: true, temperature: 0.3 });
  if (!raw) return opts.fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[llm] jsonCompletion: failed to parse response:", err);
    return opts.fallback;
  }
}

/** Plain-text completion (used for the executive summary). */
export async function textCompletion(opts: {
  system: string;
  user: string;
  fallback: string;
}): Promise<string> {
  const raw = await complete({ system: opts.system, user: opts.user, jsonMode: false, temperature: 0.4 });
  return raw?.trim() || opts.fallback;
}
