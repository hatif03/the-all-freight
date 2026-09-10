"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { Panel } from "./ui";
import { fadeUp, popIn } from "@/lib/motion";

export interface AgentState {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

export function AgentConsole({ agents, logs }: { agents: AgentState[]; logs: string[] }) {
  const done = agents.filter((a) => a.status === "done").length;
  const pct = agents.length ? (done / agents.length) * 100 : 0;

  return (
    <Panel>
      <div className="flex items-center gap-2 mb-3">
        <span className="size-2 rounded-full bg-accent pulse-ring" />
        <h2 className="text-sm font-semibold">Agent pipeline</h2>
        <span className="text-[11px] mono text-muted ml-auto tabular-nums">
          {done}/{agents.length} complete
        </span>
      </div>

      {/* The analysis takes minutes, so the only thing worse than no progress
          indicator is one that pretends to know how long it'll take. This
          tracks agents actually finished. */}
      <div className="h-1 rounded-full bg-border overflow-hidden mb-4">
        <motion.div
          className="h-full bg-accent origin-left"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: pct / 100 }}
          style={{ width: "100%" }}
        />
      </div>

      {logs.length > 0 && <div className="mb-4 text-[11px] mono text-muted">{logs[logs.length - 1]}</div>}

      <ul className="space-y-1.5">
        {/* Not a stagger: the SSE stream already delivers these seconds apart,
            so they stagger themselves. This animates arrival only. */}
        <AnimatePresence initial={false}>
          {agents.map((a) => (
            <motion.li
              key={a.id}
              layout
              {...fadeUp}
              className="flex items-start gap-3 rounded-lg border border-border/60 bg-panel-2/50 px-3 py-2.5"
            >
              {/* Keyed on status so the icon re-mounts and pops when an agent
                  flips from running to done — the one moment of feedback that
                  proves work is happening. */}
              <motion.span key={a.status} {...popIn} className="mt-0.5">
                {a.status === "running" && <Loader2 className="size-4 text-accent animate-spin" />}
                {a.status === "done" && <CheckCircle2 className="size-4 text-ok" />}
                {a.status === "error" && <XCircle className="size-4 text-danger" />}
              </motion.span>
              <div className="min-w-0 flex-1">
                <div className="text-sm">{a.name}</div>
                {a.summary && <div className="text-[11px] mono text-muted truncate mt-0.5">{a.summary}</div>}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
        {agents.length === 0 && (
          <li className="flex items-center gap-3 text-muted text-sm px-3 py-2">
            <CircleDashed className="size-4 animate-spin" /> Initializing agents…
          </li>
        )}
      </ul>
    </Panel>
  );
}
