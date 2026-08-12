# Codex Orchestra — build status

Updated: 2026-08-12

## Estado real

- Porcentaje aproximado: 82% de la especificación implementable sin credenciales de proveedores ni validación nativa del toolchain.
- Fase/gate: Fase 7 selectiva / cierre de verificación local completado con una limitación nativa explícita.
- Fuente canónica leída: `D:\Códigos\Codex Orchestra\CODEX_ORCHESTRA_MASTER_BUILD_PLAN.html`, 900 líneas, 44,559 bytes.
- Repositorio de trabajo al inicio: vacío; el checkout ya fue trasladado a esta ruta y queda listo para inicializar Git.

## Completado

- Fase 0: skeleton, contratos, ADRs, investigación y límites.
- Fase 1: shell React/Vite preparada para Tauri, dashboard, detección read-only modelada y logging redacted.
- Fase 2: RouterEngine central, parsing de salidas, catálogo, pin/version/update/rollback y fixtures.
- Fase 3: Team Builder, model bindings, agentes TOML, skill `orchestra-routing`, managed block con preview.
- Fase 4: diagnostics, capability-check contract, health history, support bundle redacted y live-check confirmation gate.
- Fase 5: usage events, CostEngine versionado, filtros y budget warnings.
- Fase 6: ownership scopes, conflicto → secuencial y worktree plan experimental.
- Fase 7: boundaries documentados para App Server stdio/MCP; no se añadió una segunda orquestación ni WebSocket crítico.

## En progreso / pendiente externo

- Compilación y tests Tauri nativos pendientes: Cargo/Rust ya están instalados, pero falta `link.exe` de Visual C++ Build Tools; el instalador oficial terminó con código `1602` en esta sesión.
- Ejecución del Codex instalado pendiente: `codex.exe` existe como Windows App, pero el sandbox recibe acceso denegado.
- Instalación/doctor real de Codex Router y resolución real de Kimi/xAI requieren ejecución local del usuario y credenciales elegidas por él.
- Live checks pagados y verificación Sol → Kimi/Grok no forman parte del test suite; la UI deja el preview y confirmación listos.
- El upstream observado en la investigación publica `codex-model-router` versión `0.4.0-beta.2` y documenta Kimi K3 API y Grok 4.5 API; Grok 4.6 queda como binding lógico objetivo y debe curarse/verificarse desde el catálogo local cuando exista.

## Decisiones

- Tauri 2 + React/TypeScript, con Rust para procesos/configuración sensibles.
- Codex Router se envuelve como engine externo y no se reimplementa el proxy.
- Secrets quedan en Router/OS; Orchestra sólo muestra estado de credencial.
- `frontend` y `engineer` son bindings lógicos; los slugs activos se resuelven contra el catálogo.
- La UI tiene una dirección “instrument panel editorial”: superficies oscuras sobrias, cyan como señal de actividad, ámbar para atención, números monoespaciados y una columna de contexto persistente.

## Checks ejecutados

- `npm run typecheck` — PASS.
- `npm test` — PASS, 6/6 tests de contratos.
- `npm run check:secrets` — PASS; no encontró valores con forma de secreto.
- `npm run build` — PASS; Vite produjo `apps/desktop/dist`.
- `npm run format:check` — PASS.
- Smoke HTTP del shell Vite en `http://127.0.0.1:1420/` — PASS, HTTP 200 y título `Codex Orchestra`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — BLOCKED por `link.exe` ausente; Cargo 1.97.1/Rustc 1.97.1 sí están disponibles.
- QA visual/interactiva en el navegador integrado — BLOCKED por el permiso de navegación local rechazado por la aplicación.

## Riesgos

- APIs, CLI y catálogo de Codex Router cambian; el adapter tiene version/commit pin y operaciones explícitas, no asume `main` como contrato eterno.
- Una UI “healthy” local no prueba autenticación ni capacidad real del proveedor; esos estados se mantienen honestamente como pendientes hasta el live check.
- El bundle redacted excluye prompts/respuestas por defecto; si el router devuelve contenido sensible en stdout, Rust debe conservar la redacción antes de exportar.

## Próximo paso concreto

Completar Visual C++ Build Tools/Tauri prerequisites en Windows, ejecutar `cargo test` y `npm run tauri:build`; después ejecutar Setup desde la app con las credenciales introducidas en el helper local del Router.
