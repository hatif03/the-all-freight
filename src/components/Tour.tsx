"use client";

/**
 * First-run walkthrough.
 *
 * Hand-rolled rather than pulling in a tour library, for a specific reason:
 * the spotlight is a positioned div with a huge outward box-shadow, and the
 * rest of what those libraries sell is a step index and a storage flag. More
 * decisively, the targets don't all exist at once — the home page has no
 * dashboard, and the ops room is empty until something breaks — so any library
 * would need custom step-gating anyway, and we'd be paying for the bundle *and*
 * writing the gating.
 *
 * Every step here targets something present on a cold load of the home page
 * with no backend, no API key and no data, which is exactly the state a first
 * visitor arrives in.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowRight, X } from "lucide-react";
import { DUR, fade, popIn } from "@/lib/motion";
import { store } from "@/lib/storage";

const SEEN_KEY = "taf.tour.v1";

interface Step {
  target: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    target: '[data-tour="intake"]',
    title: "Describe a shipment",
    body: "Plain English is fine. Anything you leave out — weight, ship date, handling — gets asked for.",
  },
  {
    target: '[data-tour="presets"]',
    title: "Or start from a sample",
    body: "Loads a real lane and runs the whole pipeline, so you can watch it work before typing anything.",
  },
  {
    target: '[data-tour="nav-ops"]',
    title: "Planning is only half of it",
    body: "Once a shipment is tracked, a disruption at its port opens a room where agents negotiate a recovery and you approve it.",
  },
  {
    target: '[data-tour="provenance"]',
    title: "Every number says where it came from",
    body: "Anything marked live was fetched from the open web while you waited. If a source couldn't be reached it says so — nothing is invented to fill a gap.",
  },
];

export function Tour() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const close = useCallback(() => {
    setIndex(null);
    store.set(SEEN_KEY, "1");
  }, []);

  // Only ever on the home page: that's where the targets live, and it's where
  // a first visit starts. Navigating away is handled by returning null from
  // render rather than clearing state here, so there's no write to make.
  useEffect(() => {
    if (pathname !== "/") return;
    const forced = searchParams.get("tour") === "1";
    // Read storage in an effect, never during render — reading it while
    // rendering is a hydration mismatch waiting to happen.
    if (!forced && store.get(SEEN_KEY)) return;
    // Let the page paint first so the targets exist to measure.
    const id = setTimeout(() => setIndex(0), 600);
    return () => clearTimeout(id);
  }, [pathname, searchParams]);

  // Track the current target's position, and skip any step whose target isn't
  // on the page.
  useEffect(() => {
    if (index === null) return;
    const step = STEPS[index];
    if (!step) return;

    // Measuring the DOM can only happen after render, so writing the result
    // to state here is the purpose of the effect, not an accidental cascade.
    const measure = () => {
      const el = document.querySelector(step.target);
      if (!el) {
        setRect(null);
        return;
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setRect(el.getBoundingClientRect());
    };
    measure();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "Enter") setIndex((i) => (i === null ? i : Math.min(i + 1, STEPS.length - 1)));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [index, close]);

  if (index === null || pathname !== "/") return null;
  const step = STEPS[index];
  if (!step) return null;

  const isLast = index === STEPS.length - 1;
  // Place the card below the target unless that would fall off-screen.
  const below = !rect || rect.bottom + 190 < window.innerHeight;
  const cardTop = rect ? (below ? rect.bottom + 14 : rect.top - 178) : window.innerHeight / 2 - 89;
  const cardLeft = rect
    ? Math.min(Math.max(12, rect.left + rect.width / 2 - 170), window.innerWidth - 352)
    : window.innerWidth / 2 - 170;

  return (
    <AnimatePresence>
      <motion.div key="tour" {...fade} transition={{ duration: DUR.fast }} className="fixed inset-0 z-[60]">
        {/* The spotlight: a transparent box with an enormous shadow, which dims
            everything except the target. */}
        {rect ? (
          <motion.div
            layout
            className="absolute rounded-xl pointer-events-none"
            style={{
              top: rect.top - 6,
              left: rect.left - 6,
              width: rect.width + 12,
              height: rect.height + 12,
              boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-slate-900/55 pointer-events-none" />
        )}

        {/* Click-off layer */}
        <button
          type="button"
          aria-label="Close walkthrough"
          onClick={close}
          className="absolute inset-0 cursor-default"
        />

        <motion.div
          key={index}
          {...popIn}
          transition={{ duration: DUR.fast }}
          role="dialog"
          aria-modal="true"
          aria-label={step.title}
          className="absolute w-[340px] rounded-2xl border border-border bg-panel p-4 shadow-xl"
          style={{ top: cardTop, left: cardLeft }}
        >
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-3 right-3 text-muted hover:text-foreground transition cursor-pointer"
          >
            <X className="size-4" />
          </button>

          <div className="text-[10px] mono uppercase tracking-wider text-accent mb-1.5">
            {index + 1} of {STEPS.length}
          </div>
          <div className="text-sm font-semibold pr-6">{step.title}</div>
          <p className="text-[12px] text-muted mt-1.5 leading-relaxed">{step.body}</p>

          <div className="flex items-center justify-between mt-4">
            <button
              type="button"
              onClick={close}
              className="text-[11px] mono text-muted hover:text-foreground transition cursor-pointer"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => (isLast ? close() : setIndex(index + 1))}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:brightness-110 transition cursor-pointer"
            >
              {isLast ? "Got it" : "Next"} <ArrowRight className="size-3.5" />
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
