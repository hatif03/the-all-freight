/**
 * Motion tokens.
 *
 * Four durations, one easing curve, three variants. Anything a component wants
 * beyond this is usually a sign the motion isn't earning its place — the point
 * of animation here is to show state changing, not to decorate.
 *
 * Reduced motion is handled globally by `MotionProvider` (`reducedMotion:
 * "user"` strips transforms while keeping opacity) plus a media query in
 * globals.css for the hand-written CSS keyframes that MotionConfig can't
 * reach. Individual components only need `useReducedMotion()` when they
 * animate something that isn't a transform — a counting number, say.
 */

export const DUR = {
  fast: 0.15,
  base: 0.24,
  slow: 0.45,
  count: 0.8,
} as const;

// One curve everywhere: a gentle decelerate that doesn't overshoot.
export const EASE = [0.22, 1, 0.36, 1] as const;

export const T = { duration: DUR.base, ease: EASE } as const;

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

export const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
} as const;

export const popIn = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
} as const;

/** Container variants that stagger direct children. */
export const list = (stagger = 0.05) =>
  ({
    animate: { transition: { staggerChildren: stagger } },
  }) as const;
