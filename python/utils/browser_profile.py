"""One browser identity for every request the web pipeline makes.

Upstream reads two things that have to agree: the User-Agent and the client
hints (sec-ch-ua*) that go with it.  They used to disagree — the image and
text workers said Windows Edge 143, the login worker and sentinel said
Windows Chrome 145 — so the same account looked like two browsers depending
on which part of the pipeline touched it.  Everything now says Windows
Chrome 145.

Why the TLS profile stays at chrome110
--------------------------------------
The obvious next step would be to move the impersonate profile up to match,
and it does not work: measured against chatgpt.com from the magpie host
(2026-11-19), every profile from chrome131 up is refused by Cloudflare while
chrome110 is served.

    chrome110 + win edge 143      -> 200
    chrome110 + win chrome 145    -> 200
    chrome110 + mac chrome 145    -> 200
    chrome131 + win chrome 145    -> 403
    chrome142 + win chrome 145    -> 403
    chrome145 + win chrome 145    -> 403

So the TLS/HTTP2 fingerprint stays where it demonstrably passes, and the UA
and client hints move to Chrome 145 — which is what the login worker and
sentinel already sent, and what g2a sends.  The UA naming a newer build than
the fingerprint is a real gap (g2a's internal/service/browser_fingerprint.go
argues against exactly that), but it is the one Cloudflare lets through;
revisit it when a newer curl_cffi profile answers 200.

One place to change: anything adding a header of its own imports these
rather than writing the strings again.
"""

# Pinned, not resolved: chrome110 is the newest profile chatgpt.com serves
# (see the matrix above).  Moving it means re-running that matrix.
IMPERSONATE = "chrome110"

# What the pipeline says it is.  Windows Chrome 145 — the login flow and
# sentinel already said this; the image and text workers said Edge 143.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
VERSION = "145"

# curl_cffi's impersonate sets the TLS fingerprint only — it sends no
# sec-ch-ua at all — so these are ours to keep in step with the UA above.
SEC_CH_UA = f'"Chromium";v="{VERSION}", "Google Chrome";v="{VERSION}", "Not/A)Brand";v="99"'
SEC_CH_UA_PLATFORM = '"Windows"'
SEC_CH_UA_MOBILE = "?0"
