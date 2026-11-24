import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom gaps used by Radix, react-dropzone and the portal.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
URL.createObjectURL ??= () => "blob:test";
URL.revokeObjectURL ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// input-otp probes for password-manager badges.
document.elementFromPoint ??= () => null;
