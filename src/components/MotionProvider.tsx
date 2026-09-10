"use client";

import { MotionConfig } from "framer-motion";
import { T } from "@/lib/motion";

/**
 * App-wide motion configuration.
 *
 * `reducedMotion="user"` is the important part: for anyone whose OS asks for
 * reduced motion it strips transform animations while keeping opacity fades,
 * which is the correct behaviour rather than a blunt kill switch. Doing it here
 * covers every `motion.*` element in the app, including ones not written yet,
 * so no component has to remember.
 *
 * Setting the default transition here too means components rarely pass one.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={T}>
      {children}
    </MotionConfig>
  );
}
