"""Application configuration loaded from environment variables and .env files."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SSO_ENV_VAR_NAMES: tuple[str, ...] = (
    "SSO_ENABLED",
    "SSO_PROVIDER",
    "SSO_ENFORCE",
    "SSO_ALLOWED_DOMAINS",
    "SSO_ADMIN_EMAILS",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_API_KEY",
    "FIREBASE_APP_ID",
    "FIREBASE_TENANT_ID",
    "FIREBASE_SIGN_IN_METHODS",
    "ENTRA_TENANT_ID",
    "ENTRA_CLIENT_ID",
    "ENTRA_CLIENT_SECRET",
    "ENTRA_AUTHORITY_HOST",
    "ENTRA_REDIRECT_URI",
    "ENTRA_SCOPES",
)

ALL_AUTH_ENV_VAR_NAMES: tuple[str, ...] = (*SSO_ENV_VAR_NAMES, "BCA_API_KEYS", "ENV_FILE")

_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FIREBASE_ALLOWED_METHODS = frozenset({"google", "microsoft", "email_password", "saml", "oidc"})


def _parse_cors_origins(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return ["http://localhost:5173", "http://127.0.0.1:5173"]
    stripped = raw.strip()
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in stripped.split(",") if part.strip()]


def parse_dotenv_line(line: str) -> tuple[str, str] | None:
    """Parse a single .env assignment line, supporting quotes, export prefix, and comments."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export ") and len(stripped) > 7:
        stripped = stripped[7:].lstrip()
    if "=" not in stripped:
        return None

    key, raw_val = stripped.split("=", 1)
    key = key.strip()
    if not key or not _ENV_KEY_RE.match(key):
        return None

    val = raw_val.lstrip()
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        inner = val[1:-1]
        inner = (
            inner.replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
        )
        return key, inner

    if len(val) >= 2 and val[0] == "'" and val[-1] == "'":
        return key, val[1:-1]

    # Strip unquoted inline comments only when preceded by whitespace.
    for idx, ch in enumerate(val):
        if ch == "#" and idx > 0 and val[idx - 1].isspace():
            val = val[:idx]
            break

    return key, val.strip()


def load_dotenv_file(path: Path, *, override: bool = False) -> list[str]:
    """Load key=value assignments from a .env file into os.environ."""
    if not path.is_file():
        return []
    applied: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parsed = parse_dotenv_line(line)
        if parsed is None:
            continue
        key, value = parsed
        if override or key not in os.environ:
            os.environ[key] = value
            applied.append(key)
    return applied


def load_dotenv_files() -> list[Path]:
    """Load ENV_FILE (if specified) or default backend/.env and repo-root .env files."""
    explicit = os.getenv("ENV_FILE", "").strip()
    if explicit:
        explicit_path = Path(explicit).expanduser()
        if explicit_path.is_file():
            load_dotenv_file(explicit_path, override=False)
            return [explicit_path]
        return []

    backend_root = Path(__file__).resolve().parent.parent
    candidates = [backend_root / ".env", backend_root.parent / ".env"]
    loaded: list[Path] = []
    for candidate in candidates:
        if candidate.is_file():
            load_dotenv_file(candidate, override=False)
            loaded.append(candidate)
    return loaded


def _parse_env_bool(raw: str) -> bool | None:
    norm = raw.strip().lower()
    if norm in {"1", "true", "yes", "on"}:
        return True
    if norm in {"0", "false", "no", "off"}:
        return False
    return None


def _parse_env_list(raw: str) -> list[str]:
    stripped = raw.strip()
    if not stripped:
        return []
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in stripped.split(",") if part.strip()]


def _valid_https_host(raw: str) -> str:
    cleaned = raw.strip().rstrip("/")
    if not cleaned:
        return "https://login.microsoftonline.com"
    parsed = urlparse(cleaned)
    if parsed.scheme == "https" and parsed.netloc:
        return cleaned
    return "https://login.microsoftonline.com"


def _dedupe_preserve(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def get_sso_env_config() -> tuple[dict[str, Any] | None, list[str]]:
    """Resolve SSO settings from environment variables if any non-empty SSO env var is set."""
    active_vars: dict[str, str] = {}
    for name in SSO_ENV_VAR_NAMES:
        raw = os.environ.get(name)
        if raw is not None and raw.strip():
            active_vars[name] = raw.strip()

    if not active_vars:
        return None, []

    raw_provider = active_vars.get("SSO_PROVIDER", "firebase").lower()
    provider = "entra" if raw_provider == "entra" else "firebase"

    enabled_parsed = _parse_env_bool(active_vars.get("SSO_ENABLED", ""))
    enabled = bool(enabled_parsed) if enabled_parsed is not None else False

    enforce_parsed = _parse_env_bool(active_vars.get("SSO_ENFORCE", ""))
    enforce_sso = bool(enforce_parsed) if enforce_parsed is not None else False
    if not enabled:
        enforce_sso = False

    allowed_domains = _dedupe_preserve(
        [
            item.lower().lstrip("@")
            for item in _parse_env_list(active_vars.get("SSO_ALLOWED_DOMAINS", ""))
            if item.lstrip("@")
        ]
    )
    admin_emails = _dedupe_preserve(
        [
            item.lower()
            for item in _parse_env_list(active_vars.get("SSO_ADMIN_EMAILS", ""))
            if item
        ]
    )
    fb_methods = _dedupe_preserve(
        [
            item.lower()
            for item in _parse_env_list(active_vars.get("FIREBASE_SIGN_IN_METHODS", ""))
            if item.lower() in _FIREBASE_ALLOWED_METHODS
        ]
    ) or ["google"]

    entra_authority_host = _valid_https_host(
        active_vars.get("ENTRA_AUTHORITY_HOST", "https://login.microsoftonline.com")
    )
    entra_scopes = active_vars.get("ENTRA_SCOPES", "openid profile email") or "openid profile email"

    config: dict[str, Any] = {
        "enabled": enabled,
        "provider": provider,
        "enforce_sso": enforce_sso,
        "allowed_domains": allowed_domains,
        "admin_emails": admin_emails,
        "firebase_project_id": active_vars.get("FIREBASE_PROJECT_ID", ""),
        "firebase_auth_domain": active_vars.get("FIREBASE_AUTH_DOMAIN", ""),
        "firebase_api_key": active_vars.get("FIREBASE_API_KEY", ""),
        "firebase_app_id": active_vars.get("FIREBASE_APP_ID", ""),
        "firebase_tenant_id": active_vars.get("FIREBASE_TENANT_ID", ""),
        "firebase_sign_in_methods": fb_methods,
        "entra_tenant_id": active_vars.get("ENTRA_TENANT_ID", ""),
        "entra_client_id": active_vars.get("ENTRA_CLIENT_ID", ""),
        "entra_client_secret": active_vars.get("ENTRA_CLIENT_SECRET", ""),
        "entra_authority_host": entra_authority_host,
        "entra_redirect_uri": active_vars.get("ENTRA_REDIRECT_URI", ""),
        "entra_scopes": entra_scopes,
        "updated_at": None,
    }
    return config, sorted(active_vars.keys())


def is_sso_env_managed() -> bool:
    """Return True when SSO is controlled by environment variables."""
    _, active_vars = get_sso_env_config()
    return bool(active_vars)


def get_env_api_keys() -> list[str]:
    """Parse static inbound API keys from BCA_API_KEYS, preserving order and uniqueness."""
    raw = os.getenv("BCA_API_KEYS", "").strip()
    if not raw:
        return []
    return _dedupe_preserve([k for k in _parse_env_list(raw) if k])


def is_api_keys_env_managed() -> bool:
    """Return True when inbound API keys are controlled by BCA_API_KEYS."""
    return len(get_env_api_keys()) > 0


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the local-first BCA platform."""

    database_path: Path
    cors_origins: list[str]
    max_simulations: int = 50_000
    default_simulations: int = 10_000


def get_settings() -> Settings:
    """Resolve runtime settings from the environment with safe local defaults."""
    backend_root = Path(__file__).resolve().parent.parent
    default_db = backend_root / "data" / "bca.db"
    raw_db = os.getenv("DATABASE_PATH", "").strip()
    db_path = Path(raw_db).expanduser() if raw_db else default_db
    cors_origins = _parse_cors_origins(os.getenv("CORS_ORIGINS"))
    return Settings(database_path=db_path, cors_origins=cors_origins)
