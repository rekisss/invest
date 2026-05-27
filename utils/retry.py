from __future__ import annotations

import time
from typing import Callable, TypeVar

F = TypeVar("F", bound=Callable)


def _make_retry(max_attempts: int = 4, base_wait: float = 2.0, max_wait: float = 30.0):
    """Return a decorator that retries on any exception with exponential backoff."""
    try:
        from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
        import requests

        return retry(
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential(multiplier=base_wait, min=base_wait, max=max_wait),
            retry=retry_if_exception_type((requests.RequestException, OSError)),
            reraise=True,
        )
    except ImportError:
        # tenacity not installed — implement minimal fallback
        def decorator(fn: F) -> F:
            def wrapper(*args, **kwargs):
                last_exc: Exception | None = None
                for attempt in range(max_attempts):
                    try:
                        return fn(*args, **kwargs)
                    except Exception as exc:
                        last_exc = exc
                        wait = min(base_wait * (2 ** attempt), max_wait)
                        time.sleep(wait)
                raise last_exc  # type: ignore[misc]
            wrapper.__wrapped__ = fn  # type: ignore[attr-defined]
            return wrapper  # type: ignore[return-value]
        return decorator


# Pre-built decorators for common use cases
finmind_retry = _make_retry(max_attempts=4, base_wait=2.0, max_wait=30.0)
http_retry = _make_retry(max_attempts=3, base_wait=1.0, max_wait=10.0)
