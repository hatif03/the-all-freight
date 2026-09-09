"use client";

import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";

export interface AgentState {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

export function AgentConsole({ agents, logs }: { agents: AgentState[]; logs: string[] }) {
  return (
    <div className="rounded-2xl border border-border bg-panel/70 p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="size-2 rounded-full bg-accent pulse-ring" />
        <h2 className="text-sm font-semibold">Agent pipeline</h2>
        <span className="text-[11px] mono text-muted ml-auto">
          {agents.filter((a) => a.status === "done").length}/{agents.length} complete
        </span>
      </div>

      {logs.length > 0 && (
        <div className="mb-4 text-[11px] mono text-muted">{logs[logs.length - 1]}</div>
      )}

      <ul className="space-y-1.5">
        {agents.map((a) => (
          <li
            key={a.id}
            className="flex items-start gap-3 rounded-lg border border-border/60 bg-panel-2/50 px-3 py-2.5"
          >
            <span className="mt-0.5">
              {a.status === "running" && <Loader2 className="size-4 text-accent animate-spin" />}
              {a.status === "done" && <CheckCircle2 className="size-4 text-ok" />}
              {a.status === "error" && <XCircle className="size-4 text-danger" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm">{a.name}</div>
              {a.summary && <div className="text-[11px] mono text-muted truncate mt-0.5">{a.summary}</div>}
            </div>
          </li>
        ))}
        {agents.length === 0 && (
          <li className="flex items-center gap-3 text-muted text-sm px-3 py-2">
            <CircleDashed className="size-4 animate-spin" /> Initializing agents…
          </li>
        )}
      </ul>
    </div>
  );
}
