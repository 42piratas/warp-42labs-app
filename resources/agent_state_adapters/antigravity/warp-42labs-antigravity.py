#!/usr/bin/env python3
"""Antigravity hooks for Warp's protocol-v1 CLI-agent notifications."""
import json
import os
import sys

OSC = "\033]777;notify;warp://cli-agent;"
BEL = "\007"


def compatible():
    return bool(os.environ.get("WARP_CLI_AGENT_PROTOCOL_VERSION")) and bool(
        os.environ.get("WARP_CLIENT_VERSION")
    ) and os.environ.get("WARP_CLI_AGENT_PROTOCOL_VERSION") == "1"


def emit(event):
    if not compatible():
        return
    try:
        with open("/dev/tty", "w", encoding="utf-8") as tty:
            tty.write(OSC + json.dumps({"v": 1, "agent": "agy", "event": event}, separators=(",", ":")) + BEL)
            tty.flush()
    except OSError:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        payload = {}
    event = os.environ.get("ANTIGRAVITY_HOOK_EVENT", "")
    if event == "PreInvocation":
        emit("prompt_submit")
        print("{}")
    elif event == "Stop":
        if payload.get("fullyIdle") is False:
            print(json.dumps({"decision": "continue", "reason": "Background work is still active."}))
        else:
            reason = payload.get("terminationReason")
            if reason == "model_stop":
                emit("stop")
            elif reason in ("error", "max_steps_exceeded") or not reason:
                emit("stop_failure")
            elif reason not in ("model_stop",):
                emit("stop_failure")
            print("{}")
    else:
        print("{}")


if __name__ == "__main__":
    main()
