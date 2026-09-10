"use client";

import { useEffect, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { DUR } from "@/lib/motion";

/**
 * Counts once from zero to `value`.
 *
 * Used for exactly one number in the app — the headline risk score. One
 * count-up is a focal point; five is a slot machine.
 *
 * This needs `useReducedMotion()` rather than relying on the global
 * MotionConfig, because what's animating is a number rather than a transform,
 * and MotionConfig's reduced-motion handling only strips the latter.
 */
export function CountUp({
  value,
  className,
  style,
}: {
  value: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();
  const [animated, setAnimated] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const controls = animate(0, value, {
      duration: DUR.count,
      ease: "easeOut",
      onUpdate: (v) => setAnimated(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduced]);

  // Derived rather than set in the effect, so the reduced-motion path needs no
  // state write at all and simply renders the final figure.
  const shown = reduced ? value : animated;

  return (
    <span className={className} style={style}>
      {shown}
    </span>
  );
}
