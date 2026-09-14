"""Hermes hooks for Warp's protocol-v1 CLI-agent notifications."""
import json
import os


def _emit(event):
    if os.environ.get("WARP_CLI_AGENT_PROTOCOL_VERSION") != "1" or not os.environ.get("WARP_CLIENT_VERSION"):
        return
    payload = "\033]777;notify;warp://cli-agent;" + json.dumps(
        {"v": 1, "agent": "hermes", "event": event}, separators=(",", ":")
    ) + "\007"
    try:
        os.write(2, payload.encode())
    except OSError:
        pass


def pre_llm_call(*args, **kwargs):
    _emit("prompt_submit")


def on_session_start(**kwargs):
    _emit("session_start")


def on_session_end(**kwargs):
    _emit("stop_failure" if kwargs.get("failed") else "stop")


def pre_approval_request(*args, **kwargs):
    _emit("permission_request")


def post_approval_response(*args, **kwargs):
    _emit("permission_replied")


def register(ctx):
    """Register only lifecycle observers; payloads are intentionally ignored."""
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("pre_approval_request", pre_approval_request)
    ctx.register_hook("post_approval_response", post_approval_response)
