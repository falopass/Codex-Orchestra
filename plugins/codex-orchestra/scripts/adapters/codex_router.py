"""Adapter over the external Codex Router engine. No proxy reimplementation."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import re
from pathlib import Path
from typing import Any

from core.paths import router_root, router_state_root
from core.redact import redact

ROUTER_REPOSITORY = "https://github.com/duolahypercho/codex-router"
ROUTER_PINNED_TAG = "v0.4.0-beta.3"
ROUTER_PINNED_COMMIT = "a1be46aa02426d87a9e24e114ce8c22619c63c7a"
ROUTER_PORTS = (4200, 4201, 4202, 4203)
IDENTITY_PORT = 4202
READ_OPS = {"doctor", "status", "providers", "models", "update-check"}
MUTATING_OPS = {"refresh-catalog", "update", "rollback", "support-bundle", "install"}

PROVIDER_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")

# First-party providers the pinned Router ships in its config/. A user provider
# must never override these; the Router overlay rejects the same set.
FIRST_PARTY_PROVIDER_IDS = {
    "openrouter",
    "zai-coding",
    "deepseek",
    "groq",
    "together",
    "fireworks",
    "siliconflow",
    "grok-oauth",
    "grok-api",
    "qwen-plan",
    "kimi-api",
    "opencode-go",
    "opencode-go-messages",
    "openai",
    "codex",
}

PROTOCOLS = {"openai", "anthropic", "openai-responses"}

# A keyless OpenAI-compatible provider must talk to this machine only. HTTP is
# accepted for a loopback endpoint (Ollama/llama.cpp); HTTPS stays mandatory
# for any remote endpoint because Orchestra never stores keys in metadata.
LOOPBACK_BASE_URL_RE = re.compile(r"^https?://(127\.0\.0\.1|\[::1\]|localhost)([:/]|$)")
HTTPS_BASE_URL_RE = re.compile(r"^https://")

_SECRET_PREFIXES = (
    "sk-",
    "sk_",
    "sess-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xapp-",
    "pk_live_",
    "sk_live_",
    "sk_test_",
    "rk_live_",
    "rk_test_",
)

_SECRET_MARKERS = (
    "key=",
    "token=",
    "secret=",
    "apikey=",
    "api_key=",
    "access_token=",
    "password=",
    "passwd=",
    "auth=",
    "bearer ",
)


def is_safe_provider_id(provider: str) -> bool:
    """Safe Router helper id. First-party defaults are documented, not exclusive."""
    if not PROVIDER_ID_RE.fullmatch(provider):
        return False
    if provider in {"openai", "codex"}:
        return False
    return True


def _looks_like_secret(value: str) -> bool:
    """Best-effort rejection of credential values stored in metadata fields."""
    text = value.strip()
    if not text:
        return False
    if "://" in text:
        return False
    lowered = text.lower()
    if lowered.startswith("bearer "):
        return True
    if any(lowered.startswith(prefix) for prefix in _SECRET_PREFIXES):
        return True
    if any(marker in lowered for marker in _SECRET_MARKERS):
        return True
    if len(text) >= 32 and " " not in text:
        if any(char.isdigit() for char in text) and any(char.isalpha() for char in text):
            return True
    return False


def _launcher() -> tuple[Path, bool] | None:
    root = router_root()
    target = root / "model-router.ps1"
    if target.is_file():
        return target, True
    direct = root / "codex-router.ps1"
    if direct.is_file():
        return direct, False
    return None


def _grok_cli() -> str | None:
    return shutil.which("grok")


def _spawn_visible(command: list[str], cwd: str | None = None) -> None:
    """Launch an interactive helper without reading its stdin/stdout."""
    # Inherit the new console's stdio. Redirecting to DEVNULL would hide the
    # Router helper prompt (Read-Host -AsSecureString / grok login).
    kwargs: dict[str, Any] = {}
    if cwd:
        kwargs["cwd"] = cwd
    if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_CONSOLE"):
        kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE
    subprocess.Popen(command, **kwargs)


def connect_provider(provider: str) -> dict[str, Any]:
    if not is_safe_provider_id(provider):
        raise ValueError(
            "Provider id must be a lowercase slug the Router helper can own, "
            "for example openrouter or zenmux. openai stays on native Codex login."
        )
    if provider == "grok-oauth":
        executable = _grok_cli()
        if executable is None:
            raise RuntimeError(
                "Official Grok CLI was not found. Install it with "
                "`npm install -g @xai-official/grok`, then try OAuth again."
            )
        if os.name == "nt":
            quoted = executable.replace("'", "''")
            command = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                f"& '{quoted}' login --oauth",
            ]
        else:
            command = [executable, "login", "--oauth"]
        _spawn_visible(command)
        return {
            "ok": True,
            "interactive": True,
            "credentialValuesReadByOrchestra": False,
            "provider": provider,
            "command": "grok login --oauth",
            "overlay": {
                "ok": True,
                "status": "not-applicable",
                "detail": "OAuth login does not use the user-provider overlay.",
            },
            "next": "Finish the browser login in the opened terminal, then run refresh-catalog and Doctor.",
        }
    launcher = _launcher()
    if launcher is None:
        raise RuntimeError("Managed Router checkout was not detected")
    script, target_wrapper = launcher
    # Apply the overlay before opening the helper. The helper can start the
    # Router and load the registry on its first invocation, so a custom provider
    # must already be resolvable from user-providers.json at that point.
    overlay = apply_overlay()
    custom = provider not in first_party_provider_ids()
    if custom and not overlay.get("ok"):
        raise RuntimeError(
            f"Custom provider '{provider}' requires the Router overlay, but it could not be "
            f"applied (overlay.status={overlay.get('status')!r}). No key was requested."
        )
    args = (
        ["codex", "provider-key", provider, "set"]
        if target_wrapper
        else ["provider-key", provider, "set"]
    )
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
        *args,
    ]
    _spawn_visible(command)
    if target_wrapper:
        label = f"{script.name} codex provider-key {provider} set"
    else:
        label = f"{script.name} provider-key {provider} set"
    return {
        "ok": True,
        "interactive": True,
        "credentialValuesReadByOrchestra": False,
        "provider": provider,
        "command": label,
        "overlay": overlay,
        "next": (
            "Paste the key in the opened helper, then run refresh-catalog and Doctor. "
            "For a custom reseller the overlay must be applied (see overlay.status) or the Router will not resolve it."
        ),
    }


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.is_file():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return data if isinstance(data, dict) else default


def overlay_apply_script() -> Path | None:
    """Locate the overlay helper that ships inside the published plugin package.

    A marketplace install copies only ``plugins/codex-orchestra``, so the helper
    must resolve relative to the plugin directory rather than a repo ``engine/``
    tree that does not exist on the target machine.
    """
    package_root = Path(__file__).resolve().parents[2]
    packaged = package_root / "scripts" / "router-overlay" / "apply.mjs"
    if packaged.is_file():
        return packaged
    # Monorepo development fallback: before packaging the helper also lives in
    # engine/overlays. It is never reached from a published install.
    cursor = Path(__file__).resolve().parent
    for _ in range(8):
        candidate = cursor / "engine" / "overlays" / "apply.mjs"
        if candidate.is_file():
            return candidate
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    return None


def apply_overlay() -> dict[str, Any]:
    """Apply the packaged Router overlay onto the managed checkout."""
    script = overlay_apply_script()
    if script is None:
        return {
            "ok": False,
            "status": "no-overlay",
            "detail": "plugins/codex-orchestra/scripts/router-overlay/apply.mjs was not found.",
        }
    checkout = router_root()
    if not (checkout / "src").is_dir():
        return {"ok": False, "status": "missing-src", "detail": "Managed Router src/ directory was not detected."}
    completed = subprocess.run(
        ["node", str(script), str(checkout)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        return {
            "ok": False,
            "status": "failed",
            "detail": redact(completed.stderr or completed.stdout or "overlay apply failed"),
        }
    try:
        detail = json.loads(completed.stdout)
    except json.JSONDecodeError:
        detail = {"raw": redact(completed.stdout)}
    return {"ok": True, "status": "applied", "checkout": str(checkout), **detail}


def _config_provider_ids() -> set[str]:
    config = router_root() / "config"
    if not config.is_dir():
        return set()
    ids: set[str] = set()
    for path in config.rglob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            if isinstance(data.get("id"), str):
                ids.add(data["id"])
            providers = data.get("providers")
            if isinstance(providers, list):
                for entry in providers:
                    if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                        ids.add(entry["id"])
    return ids


def first_party_provider_ids() -> set[str]:
    return FIRST_PARTY_PROVIDER_IDS | _config_provider_ids()


def disconnect_provider(provider: str) -> dict[str, Any]:
    if not is_safe_provider_id(provider):
        raise ValueError("Provider id must be a lowercase slug the Router helper can own.")
    launcher = _launcher()
    if launcher is None:
        raise RuntimeError("Managed Router checkout was not detected")
    script, target_wrapper = launcher
    args = ["codex", "provider-key", provider, "remove"] if target_wrapper else ["provider-key", provider, "remove"]
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), *args]
    _spawn_visible(command)
    return {
        "ok": True,
        "interactive": True,
        "credentialValuesReadByOrchestra": False,
        "provider": provider,
        "command": f"{script.name} provider-key {provider} remove",
        "next": "Confirm removal in the opened helper. Orchestra never reads or deletes the value.",
    }


def _gateway_safe(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", value.lower())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned or "model"


def _single_path_segment(value: str) -> bool:
    return bool(value) and "/" not in value and "\\" not in value and value not in {".", ".."}


def upsert_user_provider(meta: dict[str, Any]) -> dict[str, Any]:
    provider_id = meta.get("provider") or meta.get("id")
    if not provider_id or not is_safe_provider_id(provider_id):
        raise ValueError("Provider id must be a lowercase slug the Router helper can own.")
    if provider_id in first_party_provider_ids():
        raise ValueError(f"{provider_id} is a first-party Router provider and cannot be overridden by a user provider.")
    raw_keyless = meta.get("keyless")
    if raw_keyless is None:
        keyless = False
    elif isinstance(raw_keyless, bool):
        keyless = raw_keyless
    else:
        raise ValueError("keyless must be a boolean.")
    for field in ("displayName", "baseUrl", "ownedBy", "credentialFile"):
        value = meta.get(field)
        if isinstance(value, str) and _looks_like_secret(value):
            raise ValueError(f"Refusing to store a credential value in {field}.")
    display_name = meta.get("displayName")
    owned_by = meta.get("ownedBy")
    base_url = meta.get("baseUrl")
    credential_file = meta.get("credentialFile")
    if not isinstance(display_name, str) or not display_name.strip():
        raise ValueError("displayName is required metadata.")
    if not isinstance(owned_by, str) or not owned_by.strip():
        raise ValueError("ownedBy is required metadata.")
    cleaned_env: list[str] = []
    if keyless:
        if meta.get("credentialFile") or meta.get("credentialEnvironment"):
            raise ValueError("keyless provider must not declare a credential.")
        if not isinstance(base_url, str) or not LOOPBACK_BASE_URL_RE.match(base_url.strip()):
            raise ValueError(
                "keyless provider baseUrl must be a loopback HTTP(S) URL "
                "(127.0.0.1, localhost, or [::1])."
            )
    else:
        if not isinstance(base_url, str) or not HTTPS_BASE_URL_RE.match(base_url.strip()):
            raise ValueError("baseUrl must be an HTTPS URL. Orchestra does not store keys.")
        credential_file = meta.get("credentialFile")
        if (
            not isinstance(credential_file, str)
            or not _single_path_segment(credential_file)
            or not credential_file.endswith(".secret")
        ):
            raise ValueError("credentialFile must be a filename ending in .secret, not a path or value.")
        env_names = meta.get("credentialEnvironment") or []
        if not isinstance(env_names, list) or not env_names:
            raise ValueError("credentialEnvironment must be an array of environment variable names.")
        for name in env_names:
            if not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name.strip()):
                raise ValueError("credentialEnvironment entries must be ENV_NAMES.")
            if _looks_like_secret(name):
                raise ValueError("Refusing to store a credential value in credentialEnvironment.")
            cleaned_env.append(name.strip())
    protocol = meta.get("protocol")
    if protocol is not None and protocol not in PROTOCOLS:
        raise ValueError("protocol must be openai, anthropic, or openai-responses.")
    entry: dict[str, Any] = {
        "id": provider_id,
        "displayName": display_name.strip(),
        "kind": "openai-compatible",
        "ownedBy": owned_by.strip(),
        "baseUrl": base_url.strip(),
    }
    if keyless:
        entry["keyless"] = True
    else:
        entry["credential"] = {"environment": cleaned_env, "file": credential_file}
    if protocol is not None:
        entry["protocol"] = protocol
    path = router_state_root() / "user-providers.json"
    payload = _read_json(path, {"version": 1, "providers": []})
    providers = payload.get("providers")
    if not isinstance(providers, list):
        providers = []
    replaced = False
    for index, existing in enumerate(providers):
        if isinstance(existing, dict) and existing.get("id") == provider_id:
            providers[index] = entry
            replaced = True
            break
    if not replaced:
        providers.append(entry)
    _atomic_write(path, {"version": 1, "providers": providers})
    overlay = apply_overlay()
    return {"ok": True, "provider": entry, "path": str(path), "overlay": overlay, "redacted": True}


def _normalize_user_model(item: dict[str, Any]) -> dict[str, Any]:
    slug = item.get("slug") or item.get("model")
    upstream = item.get("upstreamModel")
    if slug:
        provider, separator, tail = slug.partition("/")
        if not separator or not tail:
            raise ValueError(f"Model slug must be 'provider/upstream': {slug}")
        upstream = upstream or tail
    elif upstream and item.get("provider"):
        provider = str(item["provider"])
        slug = f"{provider}/{upstream}"
    else:
        raise ValueError("Each model entry requires a slug in provider/upstream form.")
    if not is_safe_provider_id(provider):
        raise ValueError("Model provider must be a lowercase Router slug.")
    gateway = _gateway_safe(provider) + "-" + _gateway_safe(str(upstream))
    context = item.get("contextWindow") if isinstance(item.get("contextWindow"), int) and item["contextWindow"] > 0 else 131072
    auto_compact = item.get("autoCompact") if isinstance(item.get("autoCompact"), int) and item["autoCompact"] > 0 else min(110000, context)
    if auto_compact > context:
        auto_compact = context
    modalities = item.get("inputModalities") if isinstance(item.get("inputModalities"), list) and item.get("inputModalities") else ["text"]
    if any(value not in {"text", "image"} for value in modalities):
        raise ValueError("inputModalities must be text and/or image.")
    display_name = item.get("displayName") if isinstance(item.get("displayName"), str) and item.get("displayName") else f"{upstream} (curated)"
    entry: dict[str, Any] = {
        "slug": slug,
        "gatewayModel": gateway,
        "upstreamModel": str(upstream),
        "provider": provider,
        "listed": True,
        "displayName": display_name,
        "description": item.get("description") if isinstance(item.get("description"), str) and item.get("description") else f"User-curated {provider} model; conservative default metadata.",
        "priority": item.get("priority") if isinstance(item.get("priority"), int) else 10,
        "defaultEffort": item.get("defaultEffort") if isinstance(item.get("defaultEffort"), str) and item.get("defaultEffort") else "high",
        "reasoningLevels": item.get("reasoningLevels") if isinstance(item.get("reasoningLevels"), list) and item.get("reasoningLevels") else [{"effort": "high", "description": "Adaptive reasoning"}],
        "contextWindow": context,
        "autoCompact": auto_compact,
        "inputModalities": modalities,
        "compHash": f"{gateway}-user-v1",
    }
    profile = item.get("requestProfile")
    if isinstance(profile, str) and profile:
        entry["requestProfile"] = profile
    elif profile is not None:
        raise ValueError("requestProfile must be an optional string.")
    return entry


def upsert_user_models(models: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(models, list) or not models:
        raise ValueError("models must be a non-empty array.")
    entries = [_normalize_user_model(item) for item in models]
    path = router_state_root() / "user-models.json"
    payload = _read_json(path, {"version": 1, "models": []})
    existing = payload.get("models")
    if not isinstance(existing, list):
        existing = []
    index_by_slug = {
        entry.get("slug"): index
        for index, entry in enumerate(existing)
        if isinstance(entry, dict) and isinstance(entry.get("slug"), str)
    }
    for entry in entries:
        slug = entry["slug"]
        if slug in index_by_slug:
            existing[index_by_slug[slug]] = entry
        else:
            existing.append(entry)
            index_by_slug[slug] = len(existing) - 1
    _atomic_write(path, {"version": 1, "models": existing})
    return {"ok": True, "models": entries, "path": str(path), "redacted": True}


def read_hidden_slugs() -> list[str]:
    path = router_state_root() / "model-picker.json"
    payload = _read_json(path, {"version": 1, "hidden": []})
    hidden = payload.get("hidden") or []
    return [str(slug) for slug in hidden if isinstance(slug, str)]


def set_model_visible(slug: str, visible: bool) -> dict[str, Any]:
    if not isinstance(slug, str) or not slug or len(slug) > 160:
        raise ValueError("slug must be a non-empty model slug.")
    path = router_state_root() / "model-picker.json"
    payload = _read_json(path, {"version": 1, "hidden": []})
    hidden = {str(item) for item in (payload.get("hidden") or []) if isinstance(item, str)}
    if visible:
        hidden.discard(slug)
    else:
        hidden.add(slug)
    _atomic_write(path, {"version": 1, "hidden": sorted(hidden)})
    return {"ok": True, "slug": slug, "visible": bool(visible), "hidden": sorted(hidden), "redacted": True}


def curate_models(provider: str) -> dict[str, Any]:
    if not is_safe_provider_id(provider):
        raise ValueError("Provider id must be a lowercase slug the Router helper can own.")
    root = router_root()
    script = root / "src" / "curate-models.mjs"
    if not script.is_file():
        return {"ok": False, "status": "missing", "detail": "Router curation script was not detected.", "redacted": True}
    _spawn_visible(["node", str(script), provider], cwd=str(root))
    return {
        "ok": True,
        "interactive": True,
        "provider": provider,
        "command": f"node src/curate-models.mjs {provider}",
        "redacted": True,
    }


def _normalize_providers(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        entries = data.get("providers")
    elif isinstance(data, list):
        entries = data
    else:
        entries = []
    if not isinstance(entries, list):
        return []
    output: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        provider_id = entry.get("id")
        if not isinstance(provider_id, str) or not provider_id:
            continue
        if entry.get("configured") is True:
            credential = "configured"
        elif entry.get("configured") is False:
            credential = "missing"
        elif entry.get("credential") in {"configured", "missing", "invalid", "expired", "unknown"}:
            credential = entry.get("credential")
        else:
            credential = "unknown"
        if "visible" in entry:
            enabled = bool(entry.get("visible"))
        elif "enabled" in entry:
            enabled = bool(entry.get("enabled"))
        else:
            enabled = True
        output.append(
            {
                "id": provider_id,
                "name": entry.get("name") or entry.get("displayName") or provider_id,
                "enabled": enabled,
                "credential": credential,
                "kind": entry.get("kind"),
                "needsCuration": bool(entry.get("needsCuration")),
                "protocol": entry.get("protocol"),
            }
        )
    return output


def _providers_from_state() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    path = router_state_root() / "user-providers.json"
    payload = _read_json(path, {"version": 1, "providers": []})
    providers = payload.get("providers")
    if isinstance(providers, list):
        for entry in providers:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            output.append(
                {
                    "id": entry["id"],
                    "name": entry.get("displayName") or entry["id"],
                    "enabled": bool(entry.get("enabled", True)),
                    "credential": "unknown",
                    "kind": entry.get("kind"),
                    "protocol": entry.get("protocol"),
                }
            )
    for provider_id in sorted(FIRST_PARTY_PROVIDER_IDS - {"openai", "codex"}):
        if any(item["id"] == provider_id for item in output):
            continue
        output.append({"id": provider_id, "name": provider_id, "enabled": True, "credential": "unknown"})
    return output


def list_providers() -> dict[str, Any]:
    launcher = _launcher()
    providers: list[dict[str, Any]] = []
    if launcher is not None:
        script, target_wrapper = launcher
        args = ["codex", "providers", "list", "--json"] if target_wrapper else ["providers", "list", "--json"]
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), *args]
        env = os.environ.copy()
        env.update(
            {
                "MODEL_ROUTER_TARGET": "codex",
                "MODEL_ROUTER_STATE_DIR": str(router_state_root()),
                "MODEL_ROUTER_QUIET": "1",
                "PYTHONIOENCODING": "utf-8",
            }
        )
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=20,
                env=env,
                cwd=str(router_root()),
            )
            if completed.returncode == 0:
                providers = _normalize_providers(json.loads(completed.stdout))
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            providers = []
    if not providers:
        providers = _providers_from_state()
    return {"ok": True, "providers": providers, "redacted": True}


def _provider_toggle(provider: str, enabled: bool) -> dict[str, Any]:
    if not is_safe_provider_id(provider):
        raise ValueError("Provider id must be a lowercase slug the Router helper can own.")
    launcher = _launcher()
    if launcher is None:
        return {"ok": False, "status": "missing", "detail": "Managed Router checkout was not detected.", "redacted": True}
    script, target_wrapper = launcher
    action = "enable" if enabled else "disable"
    args = ["codex", "providers", action, provider] if target_wrapper else ["providers", action, provider]
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), *args]
    env = os.environ.copy()
    env.update(
        {
            "MODEL_ROUTER_TARGET": "codex",
            "MODEL_ROUTER_STATE_DIR": str(router_state_root()),
            "MODEL_ROUTER_QUIET": "1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=20,
        env=env,
        cwd=str(router_root()),
    )
    return {
        "ok": completed.returncode == 0,
        "provider": provider,
        "enabled": enabled,
        "status": completed.returncode,
        "stdout": redact(completed.stdout or "", 1200),
        "stderr": redact(completed.stderr or "", 400),
        "redacted": True,
    }


def enable_provider(provider: str) -> dict[str, Any]:
    return _provider_toggle(provider, True)


def disable_provider(provider: str) -> dict[str, Any]:
    return _provider_toggle(provider, False)


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.15)
        try:
            return sock.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False


def observed_ports() -> list[int]:
    return [port for port in ROUTER_PORTS if _port_open(port)]


def runtime_files_present() -> bool:
    state = router_state_root()
    names = (
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
        "install-manifest.json",
        "merged-models.json",
        "router.err.log",
        "router.out.log",
    )
    return any((state / name).is_file() for name in names)


def start_script() -> Path | None:
    state = router_state_root()
    for name in (
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
    ):
        path = state / name
        if path.is_file():
            return path
    return None


def detect() -> dict[str, Any]:
    root = router_root()
    launcher = _launcher()
    detected = launcher is not None or (root / "package.json").is_file()
    ports = observed_ports()
    version = None
    package = root / "package.json"
    if package.is_file():
        try:
            version = json.loads(package.read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError):
            version = None
    identity_ok = False
    if IDENTITY_PORT in ports:
        try:
            with socket.create_connection(("127.0.0.1", IDENTITY_PORT), timeout=0.4) as sock:
                sock.sendall(b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                payload = sock.recv(2048).decode("utf-8", "ignore").lower()
                identity_ok = "codex-router" in payload or "ok" in payload
        except OSError:
            identity_ok = False
    service = "running" if identity_ok or ports else ("stopped" if detected or runtime_files_present() else "unknown")
    healthy = identity_ok
    issue = None if healthy else ("connection-refused" if detected else "missing-runtime")
    return {
        "detected": detected,
        "rootPresent": detected,
        "version": version,
        "pinnedTag": ROUTER_PINNED_TAG,
        "targetRef": ROUTER_PINNED_COMMIT,
        "ports": ports,
        "service": service,
        "healthy": healthy,
        "identityOk": identity_ok,
        "issue": issue,
        "canRestart": True,
        "redacted": True,
    }


def _args(operation: str, target_wrapper: bool) -> list[str]:
    namespaced = {
        "install": ["codex", "install"],
        "doctor": ["codex", "doctor"],
        "status": ["codex", "status"],
        "providers": ["codex", "providers"],
        "refresh-catalog": ["codex", "refresh-catalog"],
        "support-bundle": ["codex", "support-bundle"],
    }
    args = namespaced.get(operation, [])
    return args if target_wrapper else args[1:]


def run_operation(operation: str, confirm: bool = False) -> dict[str, Any]:
    if operation in MUTATING_OPS and not confirm:
        raise PermissionError(f"{operation} requires confirm=true")
    if operation == "models":
        return read_catalog()
    if operation == "update-check":
        info = detect()
        current = _git_head()
        status = "current" if current == ROUTER_PINNED_COMMIT else ("available" if info["detected"] else "blocked")
        return {
            "ok": True,
            "operation": operation,
            "currentRef": current,
            "targetRef": ROUTER_PINNED_COMMIT,
            "targetVersion": ROUTER_PINNED_TAG,
            "status": status,
            "redacted": True,
        }
    if operation == "install":
        return install(confirm=confirm)
    if operation == "update":
        return update(confirm=confirm)
    launcher = _launcher()
    if launcher is None:
        return {"ok": False, "status": "missing", "operation": operation, "detail": "Managed Router checkout was not detected."}
    script, target_wrapper = launcher
    args = _args(operation, target_wrapper)
    if not args and operation not in {"models", "update-check"}:
        return {"ok": False, "status": "unsupported", "operation": operation}
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
        *args,
    ]
    env = os.environ.copy()
    env.update(
        {
            "MODEL_ROUTER_TARGET": "codex",
            "MODEL_ROUTER_STATE_DIR": str(router_state_root()),
            "MODEL_ROUTER_QUIET": "1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=20,
        env=env,
        cwd=str(router_root()),
    )
    return {
        "ok": completed.returncode == 0,
        "operation": operation,
        "status": completed.returncode,
        "stdout": redact(completed.stdout or "", 1200),
        "stderr": redact(completed.stderr or "", 400),
        "redacted": True,
    }


def read_catalog() -> dict[str, Any]:
    path = router_state_root() / "merged-models.json"
    if not path.is_file():
        return {"ok": False, "operation": "models", "status": "missing", "models": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "operation": "models", "status": "invalid", "models": []}
    models = []
    raw = payload.get("models") if isinstance(payload, dict) else payload
    if isinstance(raw, dict):
        iterable = raw.values()
    elif isinstance(raw, list):
        iterable = raw
    else:
        iterable = []
    for entry in iterable:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model") or entry.get("slug")
        if not model_id:
            continue
        models.append(
            {
                "id": model_id,
                "label": entry.get("displayName") or entry.get("label") or model_id,
                "providerId": entry.get("providerId") or entry.get("provider"),
                "available": bool(entry.get("available", True)),
                "upstreamModel": entry.get("upstreamModel"),
                "source": "catalog",
            }
        )
    return {"ok": True, "operation": "models", "models": models, "redacted": True}


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.codex-orchestra-tmp")
    temp.write_text(json.dumps(payload) + "\n", encoding="utf-8", newline="\n")
    temp.replace(path)


def logs(limit: int = 20) -> dict[str, Any]:
    state = router_state_root()
    lines: list[dict[str, str]] = []
    for name, source in (
        ("router.out.log", "router.out"),
        ("router.out", "router.out"),
        ("router.err.log", "router.err"),
        ("router.err", "router.err"),
    ):
        path = state / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for raw in [line.strip() for line in text.splitlines() if line.strip()][-limit:]:
            lines.append({"source": source, "text": redact(raw)})
    return {
        "ok": True,
        "available": bool(lines),
        "lines": lines[-40:],
        "message": "Latest redacted Router process lines." if lines else "No Router process log lines were available.",
        "redacted": True,
    }


def start(confirm: bool, force: bool = False) -> dict[str, Any]:
    if not confirm:
        raise PermissionError("Router start/restart requires confirm=true")
    current = detect()
    if current["healthy"] and not force:
        return {"ok": True, "restarted": False, "phase": "healthy", "health": current, "redacted": True}
    script = start_script()
    if script is None:
        entry = router_root() / "src" / "start.mjs"
        if not entry.is_file():
            return {"ok": False, "restarted": False, "phase": "failed", "message": "Managed Router start mechanism was not detected.", "health": current, "redacted": True}
        command = ["node", str(entry)]
        cwd = str(router_root())
    else:
        suffix = script.suffix.lower()
        if suffix == ".ps1":
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(script)]
        elif suffix == ".cmd":
            command = ["cmd.exe", "/D", "/C", str(script)]
        else:
            command = ["wscript.exe", str(script)]
        cwd = str(router_state_root())
    subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "restarted": True, "phase": "starting", "health": detect(), "redacted": True}


def install(confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise PermissionError("Router installation requires confirm=true")
    root = router_root()
    if _launcher() is not None:
        overlay = apply_overlay()
        return {
            "ok": True,
            "status": "already-detected",
            "detail": "Managed Router checkout already present.",
            "overlay": overlay,
            "redacted": True,
        }
    if root.exists():
        return {"ok": False, "status": "blocked", "detail": "Destination exists without a recognized checkout.", "redacted": True}
    root.parent.mkdir(parents=True, exist_ok=True)
    init = subprocess.run(["git", "init", str(root)], capture_output=True, text=True)
    if init.returncode != 0:
        return {"ok": False, "status": "failed", "detail": redact(init.stderr or init.stdout or "git init failed"), "redacted": True}
    subprocess.run(["git", "-C", str(root), "remote", "add", "origin", ROUTER_REPOSITORY], capture_output=True, text=True)
    fetch = subprocess.run(
        ["git", "-C", str(root), "fetch", "--depth", "1", "origin", ROUTER_PINNED_COMMIT],
        capture_output=True,
        text=True,
    )
    if fetch.returncode != 0:
        return {"ok": False, "status": "failed", "detail": redact(fetch.stderr or "fetch failed"), "redacted": True}
    checkout = subprocess.run(["git", "-C", str(root), "checkout", "--detach", "FETCH_HEAD"], capture_output=True, text=True)
    if checkout.returncode != 0 or _launcher() is None:
        return {"ok": False, "status": "failed", "detail": "Pinned checkout did not produce a Router wrapper.", "redacted": True}
    overlay = apply_overlay()
    return {"ok": True, "status": "installed", "pinnedCommit": ROUTER_PINNED_COMMIT, "pinnedTag": ROUTER_PINNED_TAG, "overlay": overlay, "redacted": True}


def update(confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise PermissionError("Router update requires confirm=true")
    root = router_root()
    if not (root / ".git").is_dir():
        return {"ok": False, "status": "missing", "detail": "No managed Router git checkout to update.", "redacted": True}
    fetch = subprocess.run(
        ["git", "-C", str(root), "fetch", "--depth", "1", "origin", ROUTER_PINNED_COMMIT],
        capture_output=True,
        text=True,
    )
    if fetch.returncode != 0:
        return {"ok": False, "status": "failed", "detail": redact(fetch.stderr or "fetch failed"), "redacted": True}
    checkout = subprocess.run(["git", "-C", str(root), "checkout", "--detach", "FETCH_HEAD"], capture_output=True, text=True)
    if checkout.returncode != 0 or _launcher() is None:
        return {"ok": False, "status": "failed", "detail": "Pinned update did not produce a Router wrapper.", "redacted": True}
    overlay = apply_overlay()
    return {"ok": True, "status": "updated", "pinnedCommit": ROUTER_PINNED_COMMIT, "pinnedTag": ROUTER_PINNED_TAG, "overlay": overlay, "redacted": True}


def _git_head() -> str | None:
    root = router_root()
    if not (root / ".git").exists():
        return None
    completed = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True)
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None
