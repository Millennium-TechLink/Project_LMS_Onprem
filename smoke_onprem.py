"""
Smoke test for a running on-prem LMS backend (standard library only).

    python onprem/smoke_onprem.py                          # checks that need no login
    python onprem/smoke_onprem.py --user admin@x.com --password ...   # plus logged-in checks

Start the app first, for example with .\onprem\run_onprem.ps1 (http://127.0.0.1:8001).
Exits 0 when every check passes, 1 otherwise, so it can gate a release or run in CI.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


# Readable by any logged-in user, including one without a lab. Add lab-scoped paths (e.g. /api/v1/sops) with --path.
DEFAULT_PATHS = ["/api/v1/auth/me", "/api/v1/auth/users", "/api/v1/customers", "/api/v1/rfqs",
                 "/api/v1/projects", "/api/v1/samples", "/api/v1/estimations"]


def call(base, path, method="GET", body=None, token=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # connection refused, timeout
        return 0, str(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:8001")
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--path", action="append", default=[], help="extra authenticated GET path to check (repeatable)")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    failures = []

    def check(name, ok, detail=""):
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" ({detail})" if detail and not ok else ""))
        if not ok:
            failures.append(name)

    print(f"Smoke test against {base}")
    code, body = call(base, "/health")
    check("backend answers /health", code == 200, f"HTTP {code}")
    if code == 0:
        print("\nThe backend is not reachable. Start it first (.\\run_onprem.ps1).")
        return 1

    code, body = call(base, "/")
    check("the app is served at / as HTML", code == 200 and "<div id=\"root\"" in body, f"HTTP {code}")
    code, _ = call(base, "/lab/management/dashboard")
    check("a deep link returns the app, not 404", code == 200, f"HTTP {code}")
    code, _ = call(base, "/api/v1/deployment/info")
    check("deployment info requires login", code in (401, 403), f"HTTP {code}")
    code, _ = call(base, "/api/v1/auth/quick-login", "POST",
                   {"email": "smoke@example.com", "password": "x", "bypass_key": "x"})
    check("quick-login is disabled (404 in on-prem)", code == 404, f"HTTP {code}")

    if args.user and args.password:
        code, body = call(base, "/api/v1/auth/login", "POST", {"email": args.user, "password": args.password})
        token = None
        if code == 200:
            try:
                token = json.loads(body).get("access_token")
            except ValueError:
                pass
        check("password-only login returns a token", bool(token), f"HTTP {code}")
        if token:
            code, body = call(base, "/api/v1/deployment/info", token=token)
            info = json.loads(body) if code == 200 else {}
            check("running in on-prem mode", info.get("mode") == "onprem", body[:80])
            for path in DEFAULT_PATHS + args.path:
                code, _ = call(base, path, token=token)
                check(f"GET {path}", code == 200, f"HTTP {code}")
    else:
        print("  (no --user/--password given: logged-in checks skipped)")

    print(f"\n{'PASSED' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
