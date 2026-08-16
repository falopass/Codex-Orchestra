"""Shared redaction helpers. Never log credential values."""

from __future__ import annotations

import re

_PATTERNS = (
    (re.compile(r"(authorization\s*[:=]\s*bearer\s+)\S+", re.I), r"\g<1>[REDACTED]"),
    (re.compile(r"((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[\"']?)\S+", re.I), r"\g<1>[REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"(capability(?:_|-)url\s*[:=]\s*)\S+", re.I), r"\g<1>[REDACTED]"),
)


def redact(text: str, limit: int = 400) -> str:
    output = text or ""
    for pattern, replacement in _PATTERNS:
        output = pattern.sub(replacement, output)
    output = output.replace("\r", " ").replace("\n", " ").strip()
    if len(output) > limit:
        return output[:limit] + "..."
    return output
