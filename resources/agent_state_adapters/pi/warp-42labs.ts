// Pi 0.85.1 extension: https://github.com/badlogic/pi-mono
const OSC = "\x1b]777;notify;warp://cli-agent;";
const BEL = "\x07";
const PAYLOAD_TEXT_LIMIT = 200;

function enabled() {
  return process.env.WARP_CLI_AGENT_PROTOCOL_VERSION === "1" &&
    Boolean(process.env.WARP_CLIENT_VERSION);
}

function emit(event: string, payload: Record<string, string> = {}) {
  if (enabled()) {
    process.stdout.write(OSC + JSON.stringify({ v: 1, agent: "pi", event, ...payload }) + BEL);
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function summarizeSkillBlock(text: string): string {
  const match = text.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return text;
  const input = match[2];
  return input ? `/skill:${match[1]} ${input}` : `/skill:${match[1]}`;
}

function payloadText(content: unknown): string {
  const text = summarizeSkillBlock(textContent(content));
  const characters = Array.from(text);
  return characters.length <= PAYLOAD_TEXT_LIMIT
    ? text
    : `${characters.slice(0, PAYLOAD_TEXT_LIMIT - 3).join("")}...`;
}

function previousUserText(branch: any[], before: number): string | undefined {
  for (let index = before - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "assistant") {
      if (["toolUse", "error", "length"].includes(entry.message.stopReason)) continue;
      return;
    }
    if (entry.message?.role === "user") return payloadText(entry.message.content) || undefined;
  }
}

export default function (pi: any) {
  pi.on("session_start", () => emit("session_start"));
  pi.on("agent_start", () => emit("prompt_submit"));
  pi.on("ui_prompt_start", () => emit("permission_request"));
  pi.on("ui_prompt_end", () => emit("permission_replied"));
  pi.on("agent_settled", (_event: any, ctx: any) => {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const assistantIndex = branch.findLastIndex(
      (item: any) => item?.type === "message" && item.message?.role === "assistant",
    );
    const entry = branch[assistantIndex];
    const reason = entry?.message?.stopReason;
    const query = assistantIndex >= 0 ? previousUserText(branch, assistantIndex) : undefined;
    const response = entry ? payloadText(entry.message.content) : undefined;
    const payload = {
      ...(query ? { query } : {}),
      ...(response ? { response } : {}),
    };
    if (reason === "stop" || reason === "length" || reason === "aborted") emit("stop", payload);
    else if (reason === "error") emit("stop_failure", payload);
  });
}
