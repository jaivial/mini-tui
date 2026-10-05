#!/usr/bin/env python3
"""Why does `cliproxy/...` fail in mini-tui? Check the whole path in one command.

cli-proxy is a local gateway, so a `cliproxy/` model has more moving parts than a hosted
provider: the gateway process, its config, the OAuth file it reads and the API key both
sides agree on. Any one of them failing looks identical in the TUI ("Connection refused"
or a 401), so this walks them in order and names the first one that is wrong.

Checks, in the order they break a run:
  1. is anything listening on CLIPROXY_API_BASE?
  2. does that process answer /v1/models with the key mini-tui sends?
  3. is `claude-opus-5-5` in the answer?          (the id must be advertised)
  4. does a one-token completion actually work?    (the upstream subscription must be live)

Usage: cliproxy-doctor.py [-m MODEL] [--base URL] [--key KEY] [--json]
Environment: CLIPROXY_API_BASE, CLIPROXY_API_KEY (mini's own defaults apply).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:8317/v1"
DEFAULT_KEY = "sk-cliproxy-local-2026"
DEFAULT_MODEL = "claude-opus-5-5"
CLIPROXY_PREFIX = "cliproxy/"


def get(url: str, key: str, timeout: float = 20.0) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "x-api-key": key})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:  # URLError, timeout, refused connect
        return 0, str(error)


def post_json(url: str, key: str, payload: dict, timeout: float = 60.0) -> tuple[int, str]:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "x-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:
        return 0, str(error)


def host_of(base: str) -> tuple[str, str]:
    """`http://127.0.0.1:8317/v1` -> `("127.0.0.1", "8317")` (path and scheme dropped)."""
    from urllib.parse import urlsplit
    parts = urlsplit(base if "//" in base else "//" + base)
    return parts.hostname or "127.0.0.1", str(parts.port or (443 if parts.scheme == "https" else 80))


def socket_check(base: str) -> tuple[bool, str]:
    """Is anything listening? A refused connect is the failure the TUI shows most often."""
    import socket
    host, port = host_of(base)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        return False, f"cannot resolve {host}: {error}"
    last = ""
    for info in infos:
        family, _, _, _, address = info
        try:
            with socket.create_connection(address, timeout=3):
                return True, ""
        except OSError as error:
            last = str(error)
    return False, f"nothing is listening on {host}:{port} ({last or 'no address worked'})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"model id to check (default {DEFAULT_MODEL})")
    parser.add_argument("--base", default=os.getenv("CLIPROXY_API_BASE") or DEFAULT_BASE)
    parser.add_argument("--key", default=os.getenv("CLIPROXY_API_KEY") or DEFAULT_KEY)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--skip-completion", action="store_true", help="only check /v1/models (no tokens spent)")
    args = parser.parse_args()

    base = args.base.rstrip("/")
    # mini's model name carries the routing prefix; the gateway only knows the bare id.
    bare = args.model[len(CLIPROXY_PREFIX):] if args.model.lower().startswith(CLIPROXY_PREFIX) else args.model
    checks: list[dict] = []
    ok = True

    def record(name: str, passed: bool, detail: str, fix: str = "") -> None:
        nonlocal ok
        ok = ok and passed
        checks.append({"check": name, "ok": passed, "detail": detail, **({"fix": fix} if fix else {})})

    listening, why = socket_check(base)
    record("gateway listening", listening, why or f"{base} accepts connections",
           "start cli-proxy-api (systemctl --user start cli-proxy-api), or point CLIPROXY_API_BASE where it runs" if not listening else "")
    if not listening:
        if args.json:
            print(json.dumps({"base": base, "model": args.model, "ok": False, "checks": checks}, indent=2))
            return 1
        print(f"FAIL  gateway listening       {why}")
        print("      fix: start cli-proxy-api (systemctl --user start cli-proxy-api),")
        print("           or point CLIPROXY_API_BASE where it runs")
        return 1

    status, text = get(f"{base}/models", args.key)
    models: list[str] = []
    auth_ok = status == 200
    if auth_ok:
        try:
            models = [row.get("id", "") for row in json.loads(text).get("data", [])]
        except Exception:
            auth_ok = False
    record("api key accepted", auth_ok,
           f"HTTP {status} from {base}/models" if auth_ok else f"HTTP {status}: {text.strip()[:200] or '(no body)'}",
           "CLIPROXY_API_KEY does not match the gateway's api-keys list; set it to a key the gateway accepts"
           if not auth_ok else f"{len(models)} models advertised")

    known = bare in models
    record("model advertised", known, f"{bare} {'is' if known else 'is NOT'} in /v1/models",
           f"the gateway does not expose {bare}: check its config (claude-code / openai-compatibility) and the upstream subscription"
           if not known else "")

    if args.skip_completion:
        if args.json:
            print(json.dumps({"base": base, "model": args.model, "ok": ok, "checks": checks}, indent=2))
            return 0 if ok else 1
        width = max((len(c["check"]) for c in checks), default=0)
        for c in checks:
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {c['check']:<{width}}  {c['detail']}")
            if c.get("fix"):
                print(f"      fix: {c['fix']}")
        print(f"\n{'all checks passed (completion not tried)' if ok else 'broken at the first FAIL above'}")
        return 0 if ok else 1

    status, text = post_json(f"{base}/chat/completions", args.key,
                             {"model": bare, "max_tokens": 16,
                              "messages": [{"role": "user", "content": "Reply with exactly: OK"}]})
    answered = status == 200
    record("completion succeeds", answered,
           f"HTTP {status}" + ("" if answered else f": {text.strip()[:200]}"),
           ("the gateway has no usable login for this model: re-run its OAuth login"
            " (`cli-proxy-api -claude-login`) and check /v0/management/auth-files")
           if not answered else "the model answered end to end")

    if args.json:
        print(json.dumps({"base": base, "model": args.model, "ok": ok, "checks": checks}, indent=2))
    else:
        width = max(len(c["check"]) for c in checks)
        for c in checks:
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {c['check']:<{width}}  {c['detail']}")
            if c.get("fix"):
                print(f"      fix: {c['fix']}")
        print(f"\n{'cliproxy is healthy' if ok else 'cliproxy is broken at the first FAIL above'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
