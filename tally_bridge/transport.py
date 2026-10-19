"""Bounded HTTP, with no redirects or credential-bearing error logs."""
import json
import re
import urllib.error
import urllib.parse
import urllib.request


class ConnectionProblem(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ConnectionProblem("Unexpected redirect; check the configured endpoint")


def post(opener, url, body, headers, limit=8_000_000, timeout=35):
    try:
        with opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=timeout) as r:
            data = r.read(limit + 1)
            if len(data) > limit:
                raise ConnectionProblem("Response too large; reduce the report period")
            return data
    except urllib.error.HTTPError as e:
        # Do not log server bodies, URLs, passwords or financial XML.
        raise ConnectionProblem(f"Server returned HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ConnectionProblem("Connection unavailable or timed out") from None


class Cloud:
    def __init__(self, url, public_key, token=None, instance=None):
        if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.co", url):
            raise ValueError("Use the dedicated project's https://…supabase.co URL")
        self.url, self.key, self.token, self.instance = url, public_key, token, instance
        self.opener = urllib.request.build_opener(NoRedirect())  # retain system proxy and TLS trust

    def rpc(self, name, **args):
        if not re.fullmatch(r"tally_bridge_[a-z_]+", name):
            raise ValueError("Unknown bridge RPC")
        if self.token and name != "tally_bridge_pair":
            args = dict(p_token=self.token, p_instance=self.instance, **args)
        raw = post(self.opener, self.url + "/rest/v1/rpc/" + name,
                   json.dumps(args, ensure_ascii=False).encode(),
                   {"apikey": self.key, "Authorization": "Bearer " + self.key,
                    "Content-Type": "application/json"})
        try:
            return json.loads(raw) if raw else None
        except (ValueError, UnicodeError):
            raise ConnectionProblem("Invalid cloud response") from None


class LocalTally:
    def __init__(self, port=9000):
        port = int(port)
        if not 1024 <= port <= 65535:
            raise ValueError("Tally port must be between 1024 and 65535")
        self.url = f"http://127.0.0.1:{port}"
        # Only loopback bypasses the HTTP proxy. Tally never listens for the cloud.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def post(self, xml):
        return post(self.opener, self.url, xml.encode("utf-8"),
                    {"Content-Type": "text/xml; charset=utf-8"})
