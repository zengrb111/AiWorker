import type { OpenClawApi } from "../preload/preload";

declare global {
  interface Window {
    openclaw: OpenClawApi;
  }
}

export {};
