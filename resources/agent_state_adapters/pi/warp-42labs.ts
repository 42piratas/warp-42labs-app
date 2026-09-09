// Pi 0.85.1 extension: https://github.com/badlogic/pi-mono
const OSC = "\x1b]777;notify;warp://cli-agent;";
const BEL = "\x07";

function enabled() {
  return process.env.WARP_CLI_AGENT_PROTOCOL_VERSION === "1" &&
    Boolean(process.env.WARP_CLIENT_VERSION);
}

function emit(event: string) {
  if (enabled()) process.stdout.write(OSC + JSON.stringify({ v: 1, agent: "pi", event }) + BEL);
}

export default function (pi: any) {
  pi.on("session_start", () => emit("session_start"));
  pi.on("agent_start", () => emit("prompt_submit"));
  pi.on("ui_prompt_start", () => emit("permission_request"));
  pi.on("ui_prompt_end", () => emit("permission_replied"));
  pi.on("agent_settled", (_event: any, ctx: any) => {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const message = [...branch].reverse().find((item: any) => item?.role === "assistant");
    const reason = message?.stopReason;
    if (reason === "stop" || reason === "length") emit("stop");
    else if (reason === "error") emit("stop_failure");
  });
}
