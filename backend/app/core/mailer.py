"""SMTP email settings, delivery, and outbound notification log."""

from __future__ import annotations

import json
import smtplib
import ssl
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.db.database import get_connection
from app.models import EmailLogOut, EmailSettingsOut, EmailSettingsUpdate, EmailTestResponse

SMTP_TIMEOUT_SECONDS = 15.0
EMAIL_LOG_RETENTION = 500


@dataclass
class OutboundEmail:
    """A notification queued by the workflow engine, delivered after the DB commit."""

    recipients: list[str]
    subject: str
    body: str
    initiative_id: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mask(secret: str) -> str:
    if not secret:
        return ""
    return "••••" + secret[-2:] if len(secret) > 6 else "••••"


def _row_to_raw(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "enabled": False,
            "host": "",
            "port": 587,
            "security": "starttls",
            "username": "",
            "password": "",
            "from_address": "",
            "from_name": "ValueStream BCA",
            "app_base_url": "",
            "updated_at": None,
        }
    return {
        "enabled": bool(row["enabled"]),
        "host": str(row["host"] or ""),
        "port": int(row["port"] or 587),
        "security": str(row["security"] or "starttls"),
        "username": str(row["username"] or ""),
        "password": str(row["password"] or ""),
        "from_address": str(row["from_address"] or ""),
        "from_name": str(row["from_name"] or ""),
        "app_base_url": str(row["app_base_url"] or ""),
        "updated_at": row["updated_at"],
    }


def get_email_settings_raw(db_path: Path) -> dict[str, Any]:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM email_settings WHERE id = 1").fetchone()
    return _row_to_raw(row)


def _raw_to_out(raw: dict[str, Any]) -> EmailSettingsOut:
    return EmailSettingsOut(
        enabled=raw["enabled"],
        host=raw["host"],
        port=raw["port"],
        security=raw["security"],
        username=raw["username"],
        password_set=bool(raw["password"]),
        password_masked=_mask(raw["password"]),
        from_address=raw["from_address"],
        from_name=raw["from_name"],
        app_base_url=raw["app_base_url"],
        configured=bool(raw["host"] and raw["from_address"]),
        updated_at=raw["updated_at"],
    )


def get_email_settings(db_path: Path) -> EmailSettingsOut:
    return _raw_to_out(get_email_settings_raw(db_path))


def update_email_settings(db_path: Path, payload: EmailSettingsUpdate) -> EmailSettingsOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        current = _row_to_raw(conn.execute("SELECT * FROM email_settings WHERE id = 1").fetchone())
        password = current["password"] if payload.password is None else payload.password
        # Never send a stored SMTP password to a different server than it was saved for.
        if payload.password is None and password and payload.host.lower() != current["host"].lower():
            password = ""
        conn.execute(
            """
            INSERT INTO email_settings (
                id, enabled, host, port, security, username, password, from_address, from_name,
                app_base_url, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                host = excluded.host,
                port = excluded.port,
                security = excluded.security,
                username = excluded.username,
                password = excluded.password,
                from_address = excluded.from_address,
                from_name = excluded.from_name,
                app_base_url = excluded.app_base_url,
                updated_at = excluded.updated_at
            """,
            (
                1 if payload.enabled else 0,
                payload.host,
                payload.port,
                payload.security,
                payload.username,
                password,
                payload.from_address,
                payload.from_name,
                payload.app_base_url,
                now,
            ),
        )
    return get_email_settings(db_path)


def _log(
    db_path: Path,
    *,
    recipients: list[str],
    subject: str,
    status: str,
    error: str = "",
    initiative_id: str | None = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO email_log (id, recipients_json, subject, status, error, initiative_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (str(uuid4()), json.dumps(recipients), subject[:300], status, error[:1000], initiative_id, _now_iso()),
        )
        conn.execute(
            """
            DELETE FROM email_log WHERE id NOT IN (
                SELECT id FROM email_log ORDER BY created_at DESC LIMIT ?
            )
            """,
            (EMAIL_LOG_RETENTION,),
        )


def list_email_log(db_path: Path, limit: int = 50) -> list[EmailLogOut]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM email_log ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),)
        ).fetchall()
    return [
        EmailLogOut(
            id=r["id"],
            recipients=json.loads(r["recipients_json"] or "[]"),
            subject=r["subject"],
            status=r["status"],
            error=r["error"] or "",
            initiative_id=r["initiative_id"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


def _smtp_send(raw: dict[str, Any], recipients: list[str], subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((raw["from_name"] or "", raw["from_address"]))
    # Recipients go in Bcc-style envelope only, so approvers do not see each other's addresses.
    msg["To"] = formataddr((raw["from_name"] or "", raw["from_address"]))
    msg.set_content(body)

    context = ssl.create_default_context()
    if raw["security"] == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            raw["host"], raw["port"], timeout=SMTP_TIMEOUT_SECONDS, context=context
        )
    else:
        server = smtplib.SMTP(raw["host"], raw["port"], timeout=SMTP_TIMEOUT_SECONDS)
    try:
        server.ehlo()
        if raw["security"] == "starttls":
            server.starttls(context=context)
            server.ehlo()
        if raw["username"]:
            server.login(raw["username"], raw["password"])
        server.send_message(msg, from_addr=raw["from_address"], to_addrs=recipients)
    finally:
        try:
            server.quit()
        except Exception:
            pass


def deliver(db_path: Path, emails: list[OutboundEmail]) -> None:
    """Send queued notifications and record each outcome. Never raises."""
    if not emails:
        return
    raw = get_email_settings_raw(db_path)
    ready = raw["enabled"] and raw["host"] and raw["from_address"]
    for email in emails:
        recipients = sorted({r.strip().lower() for r in email.recipients if r and "@" in r})
        if not recipients:
            _log(
                db_path,
                recipients=[],
                subject=email.subject,
                status="skipped",
                error="No recipients resolved for this notification.",
                initiative_id=email.initiative_id,
            )
            continue
        if not ready:
            _log(
                db_path,
                recipients=recipients,
                subject=email.subject,
                status="skipped",
                error="Email notifications are disabled or SMTP is not configured.",
                initiative_id=email.initiative_id,
            )
            continue
        try:
            _smtp_send(raw, recipients, email.subject, email.body)
        except Exception as exc:  # network / auth / protocol errors are logged, not raised
            _log(
                db_path,
                recipients=recipients,
                subject=email.subject,
                status="failed",
                error=f"{type(exc).__name__}: {exc}",
                initiative_id=email.initiative_id,
            )
        else:
            _log(
                db_path,
                recipients=recipients,
                subject=email.subject,
                status="sent",
                initiative_id=email.initiative_id,
            )


def send_test_email(db_path: Path, to: str) -> EmailTestResponse:
    raw = get_email_settings_raw(db_path)
    if not (raw["host"] and raw["from_address"]):
        return EmailTestResponse(ok=False, message="Set an SMTP host and From address first.")
    subject = "ValueStream BCA test email"
    body = (
        "This is a test message from ValueStream BCA.\n\n"
        "If you received it, approval notifications are configured correctly."
    )
    try:
        _smtp_send(raw, [to], subject, body)
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        _log(db_path, recipients=[to], subject=subject, status="failed", error=message)
        return EmailTestResponse(ok=False, message=message)
    _log(db_path, recipients=[to], subject=subject, status="sent")
    note = "" if raw["enabled"] else " Notifications are still turned off; enable them to send approval emails."
    return EmailTestResponse(ok=True, message=f"Test email sent to {to}.{note}")
