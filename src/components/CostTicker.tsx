"use client";

import { useEffect, useState } from "react";

/**
 * Demurrage/detention accruing since an incident was detected.
 *
 * A leaf component on purpose. This used to be `useState` at the top of the
 * 890-line ops console updating every 100ms, so the entire page — stepper, map
 * wrapper, options table, room feed, importer list — re-rendered ten times a
 * second. That was the single biggest reason the ops half felt heavier than the
 * rest of the app. Now only these digits re-render, and once a second, which is
 * also more legible than a blur.
 */
export function CostTicker({
  detectedAt,
  ratePerSecond,
  className,
}: {
  detectedAt: string;
  ratePerSecond: number;
  className?: string;
}) {
  const [amount, setAmount] = useState(0);

  useEffect(() => {
    const detected = new Date(detectedAt).getTime();
    if (Number.isNaN(detected)) return;

    // Derive from elapsed wall-clock rather than accumulating, so a backgrounded
    // tab (where timers are throttled) doesn't drift low.
    const compute = () => {
      const elapsed = Math.max(0, (Date.now() - detected) / 1000);
      setAmount(elapsed * ratePerSecond);
    };
    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [detectedAt, ratePerSecond]);

  return (
    <span className={className}>
      ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
