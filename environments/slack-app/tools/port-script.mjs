// The model side of ctl.sh port: a dashboard turn the model proxy answers
// itself, so it reaches the Slack app connection's port through the agent's own
// execute_action tool with no model choosing anything. Test only, and only in
// the isolated environment: model-proxy.mjs loads it when MODEL_PROXY_CONTROL_PORT
// is set, which the live stack never sets, so its model path is unchanged.
//
// A port call registers a job (POST /_port on the control port) and sends the
// message "slackenv-port:<nonce>" in a new dashboard chat. Every model request
// whose messages hold that marker is answered here and never forwarded:
// - the agent turn's request that offers execute_action gets exactly one call
//   to it, with the job's action and arguments as given;
// - the request that carries that call's result is answered with a short text
//   that ends the turn, and the result is kept, verbatim, for GET /_port/<nonce>;
// - any other request with the marker gets the same short text and leaves the
//   job as it was. Rome asks for the new chat's title at the same time as the
//   turn, with the same tools but its own system prompt and a structured
//   answer; that request is told apart from the turn (sideRequest) and never
//   gets the call, whichever arrives first.
// Each request the job saw, and what it was given, is kept in its `seen`.
// A marker naming no job, or a turn that offers no execute_action, fails the
// request and the job loudly; nothing falls through to a real model.

const MARKER = /slackenv-port:([a-z0-9]+)/;
const DONE_TEXT = "slackenv port call made.";

export function createPortScript({ model }) {
  const jobs = new Map();
  let seq = 0;

  function register(body) {
    const { nonce, action_name: actionName, json_args: jsonArgs } = body ?? {};
    if (typeof nonce !== "string" || !/^[a-z0-9]{8,}$/.test(nonce))
      return { status: 400, body: { error: "nonce must be 8 or more of a-z0-9" } };
    if (typeof actionName !== "string" || !jsonArgs || typeof jsonArgs !== "object")
      return { status: 400, body: { error: "action_name and json_args are required" } };
    if (jobs.has(nonce)) return { status: 409, body: { error: `job ${nonce} exists` } };
    jobs.set(nonce, {
      nonce,
      action_name: actionName,
      json_args: jsonArgs,
      state: "waiting",
      requests: 0,
      seen: [],
      created_at: new Date().toISOString(),
    });
    return { status: 201, body: jobs.get(nonce) };
  }

  /** Null when the request holds no marker and goes on to the real model. */
  function answer(request) {
    const text = JSON.stringify(request?.messages ?? []);
    const nonce = text.match(MARKER)?.[1];
    if (!nonce) return null;
    const job = jobs.get(nonce);
    if (!job) return failure(`slackenv-port: no job ${nonce} is registered`);
    job.requests += 1;
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const tool = tools.find(
      (t) => t?.name === "execute_action" || String(t?.name).endsWith("__execute_action"),
    );
    const side = sideRequest(request);
    const seen = {
      n: job.requests,
      tools: tools.length,
      execute_action: Boolean(tool),
      ...(side ? { side } : {}),
    };
    job.seen.push(seen);
    const given = (what, answer) => {
      seen.given = what;
      return answer;
    };

    const result = toolResultOf(request.messages, job.tool_use_id);
    if (result) {
      if (job.state === "called") {
        job.state = "done";
        job.result = result;
      }
      return given("text after the result", reply(request, { text: DONE_TEXT }));
    }
    if (!tools.length || side) {
      // Not the agent's turn: a title, say. It leaves the job as it was.
      return given("text", reply(request, { text: DONE_TEXT }));
    }
    if (job.state !== "waiting") {
      // The call already went out: never a second one.
      return given("text, the call already made", reply(request, { text: DONE_TEXT }));
    }
    if (!tool) {
      job.state = "failed";
      job.error = `the turn offered no execute_action tool (offered: ${tools.map((t) => t?.name).join(", ")})`;
      return given("error", failure(`slackenv-port: ${job.error}`));
    }
    seen.given = "the execute_action call";
    job.state = "called";
    job.tool_name = tool.name;
    job.tool_use_id = `toolu_slackenv${nonce}${(seq += 1)}`;
    return reply(request, {
      toolUse: {
        id: job.tool_use_id,
        name: tool.name,
        input: { action_name: job.action_name, json_args: job.json_args },
      },
    });
  }

  function reply(request, content) {
    const id = `msg_slackenv${(seq += 1)}`;
    const block = content.toolUse
      ? { type: "tool_use", ...content.toolUse }
      : { type: "text", text: content.text };
    const stopReason = content.toolUse ? "tool_use" : "end_turn";
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (!request.stream) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          type: "message",
          role: "assistant",
          model,
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        }),
      };
    }
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: content.toolUse ? { ...block, input: {} } : { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: content.toolUse
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            : { type: "text_delta", text: block.text },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
    };
  }

  function failure(message) {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    };
  }

  return {
    register,
    answer,
    job: (nonce) => jobs.get(nonce) ?? null,
    remove: (nonce) => jobs.delete(nonce),
  };
}

/** Why a request is not an agent's turn, or null when it may be one: it asks
 *  for a structured answer, as Rome's conversation title does, or its system
 *  prompt is the title's. */
function sideRequest(request) {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (request.output_format || tools.some((t) => t?.name === "StructuredOutput"))
    return "structured answer";
  const system =
    typeof request.system === "string"
      ? request.system
      : (Array.isArray(request.system) ? request.system : []).map((b) => b?.text ?? "").join("\n");
  if (/short names for chat conversations/i.test(system)) return "conversation title";
  return null;
}

/** The result of the call `toolUseId`, as Rome sent it: its text and whether
 *  it is an error. Null when the messages carry none. */
function toolResultOf(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return null;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.tool_use_id !== toolUseId) continue;
      const text =
        typeof b.content === "string"
          ? b.content
          : (b.content ?? [])
              .filter((c) => c?.type === "text")
              .map((c) => c.text)
              .join("");
      return { text, is_error: b.is_error === true };
    }
  }
  return null;
}
