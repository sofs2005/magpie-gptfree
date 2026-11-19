"""One browser identity for every request the web pipeline makes.

Upstream reads three things that have to name the same browser: the
User-Agent, the client hints (sec-ch-ua*) and the TLS/HTTP2 fingerprint
curl_cffi's impersonate profile presents.  They used to disagree three
ways — the image and text workers said Windows Edge 143, the login worker
and sentinel said Windows Chrome 145, and the TLS profile underneath both
was chrome110, which presents Windows Chrome 110.  g2a learned the same
lesson on the other side of the fence (internal/service/browser_fingerprint.go):
a UA that names a browser the fingerprint isn't is a signal no real client
produces.

Every chrome profile from chrome131 up presents macOS, and there is no
Windows profile newer than chrome110 — so the identity is macOS Chrome,
picked from the newest profile the installed curl_cffi actually offers.
requirements.txt allows curl_cffi>=0.11, whose newest profile is chrome124
(Windows); rather than silently contradict itself on such an install, the
version below is resolved once, at import, and all three strings follow it.

One place to change: anything adding a header of its own imports these
rather than writing the strings again.
"""

from __future__ import annotations

# Newest first.  All of these present macOS Chrome with the version in the
# name; that is what lets the UA and the client hints follow whichever one
# is picked.
_PREFERRED_CHROME = ("145", "142", "136", "131")

# The fallback when curl_cffi offers none of them: chrome110, the last
# Windows profile, which presents Chrome 110 on Windows.
_FALLBACK = "110"
_FALLBACK_PLATFORM = '"Windows"'
_FALLBACK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36"
)
_MAC_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36"
)


def _supported(profile: str) -> bool:
    """Whether the installed curl_cffi knows this impersonate profile.

    A curl_cffi that can't be imported or introspected is taken at its word:
    the session then either works or says so loudly.
    """
    try:
        from curl_cffi.requests.impersonate import BrowserType
    except Exception:
        return True
    try:
        return profile in {b.value for b in BrowserType}
    except Exception:
        return True


def _resolve() -> tuple[str, str, str]:
    """(impersonate, user agent, sec-ch-ua-platform) for the installed curl_cffi."""
    for version in _PREFERRED_CHROME:
        profile = "chrome" + version
        if _supported(profile):
            return profile, _MAC_UA.format(v=version), '"macOS"'
    return "chrome" + _FALLBACK, _FALLBACK_UA.format(v=_FALLBACK), _FALLBACK_PLATFORM


IMPERSONATE, USER_AGENT, SEC_CH_UA_PLATFORM = _resolve()

# The version the UA and the client hints both carry, so they cannot drift.
VERSION = IMPERSONATE[len("chrome"):]

# curl_cffi's impersonate sets the TLS fingerprint only — it sends no
# sec-ch-ua at all — so these are ours to keep in step with the UA above.
SEC_CH_UA = f'"Chromium";v="{VERSION}", "Google Chrome";v="{VERSION}", "Not/A)Brand";v="99"'
SEC_CH_UA_MOBILE = "?0"
