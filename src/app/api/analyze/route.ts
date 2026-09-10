import { runAnalysis } from "@/lib/orchestrator";
import type { AnalyzeEvent, ShipmentInput } from "@/lib/types";

export const runtime = "nodejs";
// The pipeline runs ~30 live web searches and a chain of four sequential LLM
// hops (product → intel fan-out → synthesis → summary/plan), so a real run
// takes a couple of minutes. 120s was set back when every search was silently
// failing fast with an HTTP 400 and the whole thing finished in seconds; once
// the searches actually worked, production runs were being cut off at the limit
// and no result event ever reached the client.
export const maxDuration = 300;

export async function POST(req: Request) {
  let input: ShipmentInput;
  try {
    const body = await req.json();
    input = {
      product: String(body.product || "").slice(0, 200),
      origin: String(body.origin || "").slice(0, 120),
      destination: String(body.destination || "").slice(0, 120),
      weightKg: Number(body.weightKg) || 0,
      quantity: body.quantity ? Number(body.quantity) : undefined,
      shipDate: String(body.shipDate || "").slice(0, 60),
      shippingMode: body.shippingMode ? String(body.shippingMode).slice(0, 40) : undefined,
      containerSize: body.containerSize ? String(body.containerSize).slice(0, 40) : undefined,
      pricePerKg: body.pricePerKg ? Number(body.pricePerKg) : undefined,
      specialRequirements: Array.isArray(body.specialRequirements)
        ? body.specialRequirements.slice(0, 6).map((s: unknown) => String(s).slice(0, 40))
        : undefined,
      locked: Array.isArray(body.locked)
        ? body.locked.slice(0, 3).map((s: unknown) => String(s).slice(0, 20))
        : undefined,
    };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!input.product || !input.origin || !input.destination) {
    return new Response("product, origin and destination are required", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AnalyzeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      try {
        const result = await runAnalysis(input, send);
        send({ type: "result", data: result });
      } catch (err) {
        console.error("[analyze] pipeline error:", err);
        send({ type: "error", message: err instanceof Error ? err.message : "Analysis failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
