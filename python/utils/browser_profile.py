"""One browser identity for every request the web pipeline makes.

Upstream reads three things that have to name the same browser: the
User-Agent, the client hints (sec-ch-ua*) and the TLS/HTTP2 fingerprint
curl_cffi's impersonate profile presents.  They used to disagree — the image
and text workers sent a Windows Edge 143 UA, the login worker and sentinel
sent Windows Chrome 145, and both sat on curl_cffi's chrome110 profile —
so one account looked like different browsers depending on which part of
the pipeline touched it.  g2a argues the same point from the other side
(internal/service/browser_fingerprint.go): a UA naming a browser the
fingerprint isn't is a signal no real client produces.

Which profile, and why these
----------------------------
Not every profile curl_cffi offers is served.  Measured 2026-11-19 against
chatgpt.com from the magpie host, with the headers below:

    chrome99..chrome131   -> 200  (chrome123 tripped 403 once, not twice)
    chrome133a,136,142    -> 403
    chrome145,146         -> 403
    chrome150             -> 200
    chrome151             -> 200
    chrome152             -> 403

chrome150 and chrome151 are the newest profiles Cloudflare serves, and both
present the browser they name — chrome151 as Windows Chrome 151, chrome150
as macOS Chrome 150 — so the UA, the client hints and the TLS/HTTP2
fingerprint can be one browser with nothing to contradict.  chrome110 is
the long-standing fallback: older, but served on every run of the matrix.

An earlier reason to stay on chrome110 came from a single matrix run that
had tripped a temporary block; five repeats of chrome110/150/151/151_macos
all answered 200, and the matrix has since been re-run twice.

The list below is tried in order against the installed curl_cffi, so an old
venv (requirements allow >=0.11, which has neither 150 nor 151) still gets a
profile it knows rather than a session that throws.  Re-run the matrix
before adding to it: a profile that answers 403 here means image and text
generation answers 403 to the end user.

One place to change: anything adding a header of its own imports these
rather than writing the strings again.
"""

from __future__ import annotations

_WIN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36"
)
_MAC_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36"
)

# (version, platform the profile presents, UA template), best first.  Each
# entry answered 200 on the matrix above; each UA is the one that profile
# presents on its own.
_PROFILES = (
    ("151", '"Windows"', _WIN_UA),
    ("150", '"macOS"', _MAC_UA),
    ("110", '"Windows"', _WIN_UA),
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
    for version, platform, template in _PROFILES:
        profile = "chrome" + version
        if _supported(profile):
            return profile, template.format(v=version), platform
    version, platform, template = _PROFILES[-1]
    return "chrome" + version, template.format(v=version), platform


IMPERSONATE, USER_AGENT, SEC_CH_UA_PLATFORM = _resolve()

# The version the UA and the client hints both carry, so they cannot drift.
VERSION = IMPERSONATE[len("chrome"):]

# curl_cffi's impersonate sets the TLS fingerprint only — it sends no
# sec-ch-ua at all — so these are ours to keep in step with the UA above.
SEC_CH_UA = f'"Chromium";v="{VERSION}", "Google Chrome";v="{VERSION}", "Not/A)Brand";v="99"'
SEC_CH_UA_MOBILE = "?0"
