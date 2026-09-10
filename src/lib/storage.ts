/**
 * localStorage that can't throw.
 *
 * Access itself throws in a private window or with site data blocked, not just
 * on write — so every call is guarded. A failed read means "not seen yet",
 * which for the tour means it shows again. Harmless.
 */

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* nothing we can do, and nothing that matters */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* as above */
    }
  },
};
