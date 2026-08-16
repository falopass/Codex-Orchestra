# Brand asset sources

Retrieved on 2026-08-14. Third-party names and marks belong to their respective owners and are used only to identify the services represented in Codex Orchestra.

| Local asset           | Source                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen.svg`            | [Qwen Code official repository](https://github.com/QwenLM/qwen-code/blob/main/packages/desktop-shell/bootstrap/qwen-code-logo.svg)                                                                                  |
| `kimi.png`            | [Codex Router provider asset](https://github.com/duolahypercho/codex-router/blob/main/apps/macos/ModelRouterTray/Sources/Resources/ProviderIcons/kimi.png), representing the Kimi service integrated by this app    |
| `opencode.svg`        | [OpenCode official repository](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/asset/brand/opencode-logo-dark-square.svg)                                                                   |
| `grok.png`            | [Codex Router provider asset](https://github.com/duolahypercho/codex-router/blob/main/apps/macos/ModelRouterTray/Sources/Resources/ProviderIcons/grok.png), representing the Grok/xAI routes integrated by this app |
| `openai.svg`          | [OpenAI official Cookbook repository](https://github.com/openai/openai-cookbook/blob/main/examples/voice_solutions/realtime_translation_guide/livekit-translation-demo/public/brand/chatgpt-blossom-white.svg)      |
| `codex-router.svg`    | [Codex Router official repository](https://github.com/duolahypercho/codex-router/blob/main/apps/desktop/src-tauri/icons/source.svg)                                                                                 |
| `codex-orchestra.svg` | Legacy project icon copied from `apps/desktop/src-tauri/icons/icon.svg`; retained as source history but no longer used by the renderer                                                                              |

## Original Codex Orchestra marks

The following transparent PNG assets were created with the built-in `imagegen` tool and are original to this project. Their exact prompt specifications are recorded in [`IMAGEGEN_PROMPTS.md`](./IMAGEGEN_PROMPTS.md).

- `codex-orchestra-generated.png`: primary application and Root-agent mark.
- `role-frontend.png`: Frontend-agent mark.
- `role-engineer.png`: Engineer-agent mark.
- `provider-generic.png`: neutral fallback for future providers without an official mark.

## Warm-light revisions

These versioned assets were edited from the original owned marks with the
built-in `imagegen` tool, then alpha-verified and normalized locally. The
complete prompt specification is recorded in [`IMAGEGEN_PROMPTS.md`](./IMAGEGEN_PROMPTS.md).

- `codex-orchestra-light-v2.png`: primary in-app mark for warm paper surfaces.
- `role-frontend-light-v2.png`: Frontend role mark for warm paper surfaces.
- `role-engineer-light-v2.png`: Engineer role mark for warm paper surfaces.
- `provider-generic-light-v2.png`: generic provider fallback for warm paper surfaces.
- `app-icon-light-v2.png`: 512 px native application icon master used to generate `src-tauri/icons/*`.

`openai.svg` retains the official blossom path and now uses the official dark
presentation (`#1B1D22`) required by the light renderer. Other third-party
marks retain their original artwork; the renderer supplies a contrasting
container when an upstream asset is white-only.
