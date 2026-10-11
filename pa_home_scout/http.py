"""Shared HTTP session with a small on-disk JSON cache."""

import hashlib
import json
import time
from typing import Any

import requests

from . import config

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT, "Accept": "application/json"})


class SourceError(RuntimeError):
    """A data source failed or returned something unusable."""


def _cache_path(key: str):
    digest = hashlib.sha256(key.encode()).hexdigest()[:32]
    return config.CACHE_DIR / f"{digest}.json"


def _cache_get(key: str, ttl: float):
    path = _cache_path(key)
    try:
        if time.time() - path.stat().st_mtime < ttl:
            return json.loads(path.read_text())
    except (OSError, ValueError):
        pass
    return None


def _cache_put(key: str, value: Any) -> None:
    try:
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(key).write_text(json.dumps(value))
    except OSError:
        pass  # caching is best-effort


def get_json(
    url: str,
    params: dict | None = None,
    headers: dict | None = None,
    ttl: float = 24 * 3600,
    method: str = "GET",
    data: Any = None,
    cache_key_extra: str = "",
) -> Any:
    """Fetch JSON, caching successful responses for ``ttl`` seconds.

    API keys in headers are deliberately excluded from the cache key.
    """
    key = json.dumps([method, url, sorted((params or {}).items()), data, cache_key_extra], default=str)
    if ttl > 0:
        cached = _cache_get(key, ttl)
        if cached is not None:
            return cached
    try:
        resp = _session.request(
            method, url, params=params, headers=headers, data=data, timeout=config.HTTP_TIMEOUT
        )
    except requests.RequestException as exc:
        raise SourceError(f"request to {url} failed: {exc}") from exc
    if resp.status_code >= 400:
        raise SourceError(f"{url} returned HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        value = resp.json()
    except ValueError as exc:
        raise SourceError(f"{url} did not return JSON") from exc
    if ttl > 0:
        _cache_put(key, value)
    return value


def stream_lines(url: str, timeout: float | None = None):
    """Stream a large text response line by line (used for the Zillow CSV)."""
    try:
        resp = _session.get(url, stream=True, timeout=timeout or config.HTTP_TIMEOUT * 4)
    except requests.RequestException as exc:
        raise SourceError(f"request to {url} failed: {exc}") from exc
    if resp.status_code >= 400:
        raise SourceError(f"{url} returned HTTP {resp.status_code}")
    resp.encoding = resp.encoding or "utf-8"
    return resp.iter_lines(decode_unicode=True)
