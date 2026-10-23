# A mitmproxy add-on that measures every model request from the benchmark's containers, whichever harness made it, and
# keeps everything else out. One JSON line per request, or per WebSocket message that carries a request or a result:
#
#   {"t": 1.7e9, "ip": "172.20.0.5", "host": "chatgpt.com", "kind": "http" | "ws", "event": "request" | "response" |
#    "denied", "path": "/backend-api/codex/responses", "status": 200, "model": "gpt-6-luna", "effort": "high",
#    "tier": ..., "items": 12, "body_bytes": 40123, "usage": {"input": ..., "cached": ..., "output": ..., "reasoning": ...},
#    "id": "resp_..."}
#
# The harnesses count tokens in their own ways and some leave out requests, such as the ones that compact. This is the
# one count that is the same for all of them.
import json
import os
import time

ALLOW = [host.strip().lower() for host in os.environ.get("METER_ALLOW", "chatgpt.com").split(",") if host.strip()]
OUT = os.environ.get("METER_OUT", "/meter/meter.jsonl")
DONE = {"response.completed", "response.done", "response.incomplete", "response.failed"}


def allowed(host: str) -> bool:
    host = host.lower()
    return any(host == pattern or host.endswith("." + pattern) for pattern in ALLOW)


def emit(entry: dict) -> None:
    entry["t"] = time.time()
    with open(OUT, "a") as file:
        file.write(json.dumps(entry, separators=(",", ":")) + "\n")


def usage_of(response: dict) -> dict | None:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        "input": usage.get("input_tokens"),
        "cached": (usage.get("input_tokens_details") or {}).get("cached_tokens"),
        "output": usage.get("output_tokens"),
        "reasoning": (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
    }


def describe_request(body: dict) -> dict:
    reasoning = body.get("reasoning") if isinstance(body.get("reasoning"), dict) else {}
    items = body.get("input")
    return {
        "model": body.get("model"),
        "effort": reasoning.get("effort"),
        "tier": body.get("service_tier"),
        "items": len(items) if isinstance(items, list) else None,
        "tools": len(body.get("tools") or []),
        "instructions_chars": len(body.get("instructions") or ""),
    }


def describe_result(response: dict) -> dict:
    reasoning = response.get("reasoning") if isinstance(response.get("reasoning"), dict) else {}
    return {
        "id": response.get("id"),
        "model": response.get("model"),
        "effort": reasoning.get("effort"),
        "tier": response.get("service_tier"),
        "state": response.get("status"),
        "usage": usage_of(response),
    }


def results_in(text: str):
    """Responses API results in an SSE body or a plain JSON body."""
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                event = json.loads(line[5:].strip())
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") in DONE and isinstance(event.get("response"), dict):
                yield event["response"]
    if not text.lstrip().startswith("event:") and "data:" not in text[:20]:
        try:
            body = json.loads(text)
        except ValueError:
            return
        if isinstance(body, dict) and (body.get("usage") or body.get("object") == "response"):
            yield body


SECRET = {"authorization", "cookie", "chatgpt-account-id", "x-openai-fedramp"}


def headers_of(flow) -> dict:
    """The request's headers, with the values of credentials left out."""
    return {name.lower(): ("<redacted>" if name.lower() in SECRET else value[:200]) for name, value in flow.request.headers.items()}


def ip_of(flow) -> str:
    peer = flow.client_conn.peername
    return peer[0] if peer else ""


class Meter:
    def request(self, flow):
        host = flow.request.pretty_host
        if not allowed(host):
            emit({"ip": ip_of(flow), "host": host, "kind": "http", "event": "denied", "path": flow.request.path[:200]})
            from mitmproxy import http

            flow.response = http.Response.make(403, b"blocked by the benchmark's proxy", {"content-type": "text/plain"})

    def response(self, flow):
        if flow.response is None or flow.response.status_code == 403 and b"benchmark's proxy" in (flow.response.content or b""):
            return
        entry = {
            "ip": ip_of(flow),
            "host": flow.request.pretty_host,
            "kind": "http",
            "event": "response",
            "method": flow.request.method,
            "path": flow.request.path.split("?")[0][:200],
            "status": flow.response.status_code,
            "body_bytes": len(flow.request.content or b""),
            "resp_bytes": len(flow.response.content or b""),
            "seconds": round((flow.response.timestamp_end or 0) - (flow.request.timestamp_start or 0), 3),
        }
        entry["headers"] = headers_of(flow)
        try:
            body = json.loads(flow.request.get_text(strict=False) or "null")
            if isinstance(body, dict):
                entry.update(describe_request(body))
        except Exception:
            pass
        try:
            for result in results_in(flow.response.get_text(strict=False) or ""):
                emit({**entry, **{key: value for key, value in describe_result(result).items() if value is not None}})
                entry = None
                break
        except Exception:
            pass
        if entry is not None:
            emit(entry)

    def websocket_message(self, flow):
        message = flow.websocket.messages[-1]
        try:
            body = json.loads(message.text if message.is_text else message.content.decode("utf-8", "replace"))
        except Exception:
            return
        if not isinstance(body, dict):
            return
        entry = {"ip": ip_of(flow), "host": flow.request.pretty_host, "kind": "ws", "path": flow.request.path.split("?")[0][:200]}
        if message.from_client and body.get("type") == "response.create":
            emit({**entry, "event": "request", **describe_request(body), "body_bytes": len(message.content)})
        elif not message.from_client and body.get("type") in DONE and isinstance(body.get("response"), dict):
            emit({**entry, "event": "response", **{k: v for k, v in describe_result(body["response"]).items() if v is not None}})


addons = [Meter()]
