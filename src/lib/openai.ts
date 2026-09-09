// Thin OpenAI wrapper used by the agent layer.
// Centralizes the client, model selection, and a JSON-structured-output helper
// with a deterministic fallback so the pipeline never hard-fails.

import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY || "";
const baseURL = process.env.OPENAI_BASE_URL || undefined; // e.g. Azure v1 endpoint
export const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const hasOpenAI = Boolean(apiKey);

// GPT-5 family on Azure rejects non-default `temperature`; omit it for those.
const isGpt5 = /gpt-5/i.test(MODEL);
const supportsTemperature = !isGpt5;
// GPT-5 reasoning is slow; default to "low" so the multi-agent pipeline stays fast.
// Override with OPENAI_REASONING_EFFORT (none|low|medium|high|xhigh).
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "low";
const gpt5Extra = isGpt5 ? { reasoning_effort: reasoningEffort } : {};

const client = apiKey
  ? new OpenAI({
      apiKey,
      baseURL,
      // Azure's OpenAI-compatible endpoint authenticates with an `api-key`
      // header in addition to the standard Authorization bearer.
      defaultHeaders: baseURL ? { "api-key": apiKey } : undefined,
    })
  : null;

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
      ...(supportsTemperature ? { temperature: 0.3 } : {}),
      ...gpt5Extra,
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
      ...(supportsTemperature ? { temperature: 0.4 } : {}),
      ...gpt5Extra,
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
