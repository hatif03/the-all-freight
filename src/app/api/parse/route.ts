import { intake } from "@/lib/agents";
import type { ShipmentInput } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let text = "";
  let current: Partial<ShipmentInput> | undefined;
  try {
    const body = await req.json();
    text = String(body.text || "").slice(0, 600);
    current = body.current && typeof body.current === "object" ? body.current : undefined;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!text.trim()) return Response.json({ error: "text required" }, { status: 400 });

  const result = await intake(text, current);
  return Response.json(result);
}
