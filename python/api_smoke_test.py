import json
import sys
import urllib.error
import urllib.request


def request_json(url: str, method: str = "GET", body: dict | None = None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"raw": text}
        return error.code, payload


def main():
    base_url = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
    checks = [
        ("team_info", f"{base_url}/api/team_info", "GET", None),
        ("agent_info", f"{base_url}/api/agent_info", "GET", None),
        (
            "execute_scope_guard",
            f"{base_url}/api/execute",
            "POST",
            {"prompt": "Selected listing id: 45855270\nFind me car tires in Lisbon."},
        ),
        (
            "execute_listing_edit",
            f"{base_url}/api/execute",
            "POST",
            {
                "prompt": (
                    "Selected listing id: 176153\n"
                    "Handle this listing end to end and explain what changed."
                )
            },
        ),
    ]

    failures = 0
    for name, url, method, body in checks:
        status, payload = request_json(url, method, body)
        ok = status < 500 and payload.get("status", "ok") != "error"
        if name == "execute_scope_guard":
            ok = ok and len(payload.get("steps", [])) == 1

        print(json.dumps({
            "check": name,
            "http_status": status,
            "ok": ok,
            "response_preview": str(payload.get("response") or payload.get("error") or "")[:160],
        }, ensure_ascii=False))
        failures += 0 if ok else 1

    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
