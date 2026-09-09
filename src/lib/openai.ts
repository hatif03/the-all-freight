// Thin LLM wrapper used by the agent layer, talking to Vertex AI's OpenAI-compatible
// endpoint via the `openai` SDK. Billed through standard Cloud Billing (not the
// separate Gemini Developer API prepay wallet), authenticated with Application
// Default Credentials — no API key to manage: `gcloud auth application-default
// login` locally, or the attached service account automatically when deployed on GCP.
//
// Vertex AI access tokens expire after about an hour. `google-auth-library`'s
// GoogleAuth.getAccessToken() caches and refreshes internally, so callers just
// need to fetch a token fresh on every request rather than caching a client —
// this module does that inside each exported function.

import OpenAI from "openai";
import { GoogleAuth } from "google-auth-library";

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const GCP_LOCATION = process.env.GCP_LOCATION || "us-central1";
const VERTEX_BASE_URL = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT_ID}/locations/${GCP_LOCATION}/endpoints/openapi`;

export const MODEL = process.env.GEMINI_MODEL || "google/gemini-2.5-flash";
export const hasLLM = Boolean(GCP_PROJECT_ID);

const auth = GCP_PROJECT_ID ? new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }) : null;

async function client(): Promise<OpenAI | null> {
  if (!auth) return null;
  try {
    const token = await auth.getAccessToken();
    if (!token) return null;
    return new OpenAI({ apiKey: token, baseURL: VERTEX_BASE_URL });
  } catch (err) {
    console.error("[vertex] failed to acquire access token:", err);
    return null;
  }
}

/**
 * Ask the model for a JSON object matching the described shape.
 * Returns `fallback` if Vertex AI is unavailable or the response can't be parsed.
 */
export async function jsonCompletion<T>(opts: {
  system: string;
  user: string;
  fallback: T;
}): Promise<T> {
  const c = await client();
  if (!c) return opts.fallback;
  try {
    const res = await c.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    } as Parameters<typeof c.chat.completions.create>[0]);
    const raw = (res as { choices: { message?: { content?: string } }[] }).choices[0]?.message?.content;
    if (!raw) return opts.fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[vertex] jsonCompletion failed:", err);
    return opts.fallback;
  }
}

/** Plain-text completion (used for the executive summary). */
export async function textCompletion(opts: {
  system: string;
  user: string;
  fallback: string;
}): Promise<string> {
  const c = await client();
  if (!c) return opts.fallback;
  try {
    const res = await c.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    } as Parameters<typeof c.chat.completions.create>[0]);
    return (res as { choices: { message?: { content?: string } }[] }).choices[0]?.message?.content?.trim() || opts.fallback;
  } catch (err) {
    console.error("[vertex] textCompletion failed:", err);
    return opts.fallback;
  }
}
