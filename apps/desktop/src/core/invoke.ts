import { mockInvoke } from "./mockBackend";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";

type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
) {
  const tauriInvoke = (
    window as Window & { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } }
  ).__TAURI_INTERNALS__?.invoke;
  if (tauriInvoke) return tauriInvoke<T>(command, args);
  if (
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  )
    return nativeInvoke<T>(command, args);
  return mockInvoke<T>(command, args);
}
