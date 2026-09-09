// Thin LLM wrapper used by the agent layer, talking to Gemini's OpenAI-compatible
// endpoint via the `openai` SDK. Centralizes the client, model selection, and a
// JSON-structured-output helper with a deterministic fallback so the pipeline
// never hard-fails.

import OpenAI from "openai";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const apiKey = process.env.GEMINI_API_KEY || "";
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
export const hasLLM = Boolean(apiKey);

const client = apiKey ? new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL }) : null;

/**
 * Ask the model for a JSON object matching the described shape.
 * Returns `fallback` if OpenAI is unavailable or the response can't be parsed.
 */
export async function jsonCompletion<T>(opts: {
  system: string;
  user: string;
  fallback: T;
}): Promise<T> {
  if (!client) return opts.fallback;
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    } as Parameters<typeof client.chat.completions.create>[0]);
    const raw = (res as { choices: { message?: { content?: string } }[] }).choices[0]?.message?.content;
    if (!raw) return opts.fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[openai] jsonCompletion failed:", err);
    return opts.fallback;
  }
}

/** Plain-text completion (used for the executive summary). */
export async function textCompletion(opts: {
  system: string;
  user: string;
  fallback: string;
}): Promise<string> {
  if (!client) return opts.fallback;
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    } as Parameters<typeof client.chat.completions.create>[0]);
    return (res as { choices: { message?: { content?: string } }[] }).choices[0]?.message?.content?.trim() || opts.fallback;
  } catch (err) {
    console.error("[openai] textCompletion failed:", err);
    return opts.fallback;
  }
}
