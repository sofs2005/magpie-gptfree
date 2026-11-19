"""The web pipeline's browser identity: one browser, named the same way.

Two things upstream can compare — the User-Agent and the client hints
(sec-ch-ua*) — used to name different browsers (Windows Edge 143 in the image
and text workers, Windows Chrome 145 in login and sentinel).  These tests
hold them together, keep the TLS profile at the one chatgpt.com actually
serves, and hold the build-number headers to the page they came from.
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

PY_DIR = Path(__file__).resolve().parent
if str(PY_DIR) not in sys.path:
    sys.path.insert(0, str(PY_DIR))

import image_worker
from utils import browser_profile
from utils.web_pow import parse_web_build_number


def _version(text: str) -> str:
    match = re.search(r"(\d+)\.\d+\.\d+\.\d+", text)
    return match.group(1) if match else ""


class BrowserProfileTest(unittest.TestCase):
    def test_user_agent_and_client_hints_name_one_browser(self):
        ua_version = _version(browser_profile.USER_AGENT)
        self.assertTrue(ua_version, "USER_AGENT carries no version")
        self.assertIn('v="%s"' % ua_version, browser_profile.SEC_CH_UA)
        self.assertEqual(browser_profile.VERSION, ua_version)

    def test_no_second_identity_in_the_headers(self):
        # The Edge spelling must not come back.
        self.assertNotIn("Edg/", browser_profile.USER_AGENT)
        self.assertNotIn("Edge", browser_profile.SEC_CH_UA)
        self.assertNotIn("Firefox", browser_profile.USER_AGENT)

    def test_platform_is_the_one_the_ua_names(self):
        ua = browser_profile.USER_AGENT
        if "Macintosh" in ua:
            self.assertEqual(browser_profile.SEC_CH_UA_PLATFORM, '"macOS"')
        else:
            self.assertEqual(browser_profile.SEC_CH_UA_PLATFORM, '"Windows"')
            self.assertIn("Windows NT 10.0", ua)

    def test_tls_profile_is_one_cloudflare_serves(self):
        # Measured 2026-11-19 from the magpie host: chrome151 and chrome150
        # answer 200 (five out of five), chrome110 always has.  Every entry
        # here presents the browser it names, so the UA and the client hints
        # follow whichever one the installed curl_cffi offers.  Changing this
        # without re-running that matrix breaks image and text generation.
        self.assertIn(
            browser_profile.IMPERSONATE, {"chrome151", "chrome150", "chrome110"}
        )
        self.assertEqual(browser_profile.IMPERSONATE, "chrome" + browser_profile.VERSION)

    def test_workers_use_the_shared_identity(self):
        self.assertIs(image_worker.DEFAULT_USER_AGENT, browser_profile.USER_AGENT)
        self.assertIs(image_worker.DEFAULT_SEC_CH_UA, browser_profile.SEC_CH_UA)


class WebBuildNumberTest(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_web_build_number('{"web_build_number":6708908}'), "6708908")

    def test_escaped_inside_an_inline_script(self):
        html = '<script>window.__STATSIG__ = {"web_build_number\\":6708908,"other":1}</script>'
        self.assertEqual(parse_web_build_number(html), "6708908")

    def test_quoted_number(self):
        self.assertEqual(parse_web_build_number('web_build_number: "1234"'), "1234")

    def test_missing_leaves_nothing(self):
        self.assertEqual(parse_web_build_number("<html></html>"), "")
        self.assertEqual(parse_web_build_number(""), "")


class BuildIdentityTest(unittest.TestCase):
    def _client(self) -> image_worker.OpenAIWebImageClient:
        # No session is opened: the header bookkeeping is what's under test.
        return image_worker.OpenAIWebImageClient("token", session=object())

    def test_bootstrap_aligns_both_headers_with_the_page(self):
        client = self._client()
        client.pow_data_build = ""
        client._align_build_identity(
            '<html data-build="prod-abc"><script>{"web_build_number":777}</script></html>'
        )
        # The page named no data-build, so the compiled-in version stays.
        self.assertEqual(client.client_version, image_worker.DEFAULT_CLIENT_VERSION)
        self.assertEqual(client.client_build_number, "777")
        self.assertEqual(client._base_headers["OAI-Client-Build-Number"], "777")
        self.assertEqual(client._base_headers["OAI-Client-Version"], image_worker.DEFAULT_CLIENT_VERSION)

    def test_data_build_becomes_the_client_version(self):
        client = self._client()
        client.pow_data_build = "prod-abc123"
        client._align_build_identity("<html></html>")
        self.assertEqual(client.client_version, "prod-abc123")
        self.assertEqual(client._base_headers["OAI-Client-Version"], "prod-abc123")
        # Nothing said about the build number: the previous one stays.
        self.assertEqual(client.client_build_number, image_worker.DEFAULT_CLIENT_BUILD_NUMBER)

    def test_a_page_without_either_changes_nothing(self):
        client = self._client()
        before = dict(client._base_headers)
        client._align_build_identity("<html><body>maintenance</body></html>")
        self.assertEqual(client._base_headers["OAI-Client-Version"], before["OAI-Client-Version"])
        self.assertEqual(client._base_headers["OAI-Client-Build-Number"], before["OAI-Client-Build-Number"])

    def test_headers_carry_the_shared_identity(self):
        headers = self._client()._base_headers
        self.assertEqual(headers["User-Agent"], browser_profile.USER_AGENT)
        self.assertEqual(headers["Sec-Ch-Ua"], browser_profile.SEC_CH_UA)
        self.assertEqual(headers["Sec-Ch-Ua-Platform"], browser_profile.SEC_CH_UA_PLATFORM)


if __name__ == "__main__":
    unittest.main()
