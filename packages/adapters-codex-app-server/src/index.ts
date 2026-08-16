export const APP_SERVER_TRANSPORT = "stdio";
export const APP_SERVER_LISTEN = "stdio://";
export const CODEX_CONTROL_PLUGIN = "codex-control";

export const APP_SERVER_READ_METHODS = [
  "thread/list",
  "thread/search",
  "thread/read",
  "thread/loaded/list",
] as const;

export const APP_SERVER_WRITE_METHODS = [
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
] as const;

export interface AppServerAdapterContract {
  transport: typeof APP_SERVER_TRANSPORT;
  publicPorts: false;
  persistPrompts: false;
  preferExistingPlugin: typeof CODEX_CONTROL_PLUGIN;
}

export const APP_SERVER_ADAPTER_CONTRACT: AppServerAdapterContract = {
  transport: APP_SERVER_TRANSPORT,
  publicPorts: false,
  persistPrompts: false,
  preferExistingPlugin: CODEX_CONTROL_PLUGIN,
};

export function shouldDelegateThreadControl(installedPlugins: string[]) {
  return installedPlugins.includes(CODEX_CONTROL_PLUGIN);
}
