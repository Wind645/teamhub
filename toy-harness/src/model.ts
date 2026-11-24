export type Args = Record<string, unknown>;
export type ToolSpec = { name: string; description: string; schema: Args };
export type Call = { id: string; name: string; args: unknown };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; calls?: Call[] }
  | { role: "tool"; content: string; id: string };
export type Reply = { text: string; calls?: Call[] };
export type OutputUpdate =
  | { type: "delta"; kind: "reasoning" | "text"; id: string; text: string }
  | { type: "end"; id?: string };
type Display = (update: OutputUpdate) => void;
export type Model = {
  next(messages: Message[], tools: ToolSpec[], signal: AbortSignal, display?: Display): Promise<Reply>;
};
export type ModelConfig = {
  endpoint: string; name: string; keyEnv: string; protocol?: "chat" | "responses";
};

function argumentsOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type ChatCall = { index: number; id?: string; function?: { name?: string; arguments?: string } };
type ChatResponse = {
  choices?: Array<{
    message?: { content: string | null; tool_calls?: ChatCall[] };
    delta?: { content?: string | null; refusal?: string | null; tool_calls?: ChatCall[] };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
};
type ResponsePart = { type: string; text?: string; refusal?: string };
type ResponseItem = {
  type: string; id?: string; call_id: string; name: string; arguments: string;
  content?: ResponsePart[]; summary?: ResponsePart[];
};
type ResponsesResult = { output?: ResponseItem[]; error?: { message?: string } };
type ResponsesEvent = {
  type: string; item_id?: string; output_index?: number; content_index?: number; summary_index?: number;
  delta?: string; text?: string; refusal?: string; item?: ResponseItem;
  response?: ResponsesResult; message?: string;
};

async function* sse(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("Missing model response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (done && buffer.trim()) buffer += "\n\n";
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const data = buffer.slice(0, boundary.index).split(/\r?\n/)
          .filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function chatCalls(calls?: ChatCall[]): Call[] | undefined {
  return calls?.map(call => ({
    id: call.id ?? "", name: call.function?.name ?? "", args: argumentsOf(call.function?.arguments ?? ""),
  }));
}

async function chatStream(response: Response, display?: Display): Promise<Reply> {
  let text = "";
  let finished = false;
  const calls = new Map<number, ChatCall>();
  for await (const data of sse(response)) {
    if (data === "[DONE]") { finished = true; break; }
    const event = JSON.parse(data) as ChatResponse;
    if (event.error) throw new Error(event.error.message ?? "Chat Completions stream failed");
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    if (choice?.finish_reason) finished = true;
    for (const fragment of [delta?.content, delta?.refusal]) {
      if (!fragment) continue;
      text += fragment;
      display?.({ type: "delta", kind: "text", id: "chat", text: fragment });
    }
    for (const piece of delta?.tool_calls ?? []) {
      const previous = calls.get(piece.index);
      calls.set(piece.index, {
        index: piece.index, id: piece.id ?? previous?.id,
        function: {
          name: (previous?.function?.name ?? "") + (piece.function?.name ?? ""),
          arguments: (previous?.function?.arguments ?? "") + (piece.function?.arguments ?? ""),
        },
      });
    }
  }
  if (!finished) throw new Error("Chat Completions stream ended before completion");
  return { text, calls: chatCalls([...calls.values()].sort((a, b) => a.index - b.index)) };
}

function responsesReply(result: ResponsesResult): Reply {
  if (!Array.isArray(result.output)) throw new Error("Missing Responses output");
  return {
    text: result.output.filter(item => item.type === "message")
      .flatMap(item => item.content ?? []).map(part => part.text ?? part.refusal ?? "").join("\n"),
    calls: result.output.filter(item => item.type === "function_call").map(item => ({
      id: item.call_id, name: item.name, args: argumentsOf(item.arguments),
    })),
  };
}

function responsesOutput(display?: Display) {
  const received = new Map<string, number>();
  const ended = new Set<string>();
  const delta = (kind: "reasoning" | "text", id: string, text?: string, complete = false) => {
    if (!text) return;
    const length = received.get(id) ?? 0;
    const fragment = complete ? text.slice(length) : text;
    if (!fragment) return;
    received.set(id, length + fragment.length);
    display?.({ type: "delta", kind, id, text: fragment });
  };
  const end = (id: string) => {
    if (!received.has(id) || ended.has(id)) return;
    ended.add(id);
    display?.({ type: "end", id });
  };
  const itemDone = (item: ResponseItem, key: string) => {
    if (item.type === "reasoning") {
      item.content?.forEach((part, index) => {
        if (part.type !== "reasoning_text") return;
        const id = `${key}:reasoning-content:${index}`;
        delta("reasoning", id, part.text, true);
        end(id);
      });
      item.summary?.forEach((part, index) => {
        if (part.type !== "summary_text") return;
        const id = `${key}:reasoning:${index}`;
        delta("reasoning", id, part.text, true);
        end(id);
      });
    } else if (item.type === "message") {
      item.content?.forEach((part, index) => delta("text", `${key}:text:${index}`, part.text ?? part.refusal, true));
    }
  };
  return { delta, end, itemDone };
}

async function responsesStream(response: Response, display?: Display): Promise<Reply> {
  const output = responsesOutput(display);
  const reasoningItems = new Set<string>();
  for await (const data of sse(response)) {
    if (data === "[DONE]") break;
    const event = JSON.parse(data) as ResponsesEvent;
    const key = event.item_id ?? event.item?.id ?? String(event.output_index);
    switch (event.type) {
      case "response.output_item.added":
        if (event.item?.type === "reasoning") reasoningItems.add(key);
        break;
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done": {
        if (!reasoningItems.has(key)) break;
        const id = `${key}:reasoning-content:${event.content_index ?? 0}`;
        output.delta("reasoning", id, event.delta ?? event.text, event.type.endsWith(".done"));
        if (event.type.endsWith(".done")) output.end(id);
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done": {
        const id = `${key}:reasoning:${event.summary_index ?? 0}`;
        output.delta("reasoning", id, event.delta ?? event.text, event.type.endsWith(".done"));
        if (event.type.endsWith(".done")) output.end(id);
        break;
      }
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.refusal.delta":
      case "response.refusal.done":
        output.delta("text", `${key}:text:${event.content_index ?? 0}`, event.delta ?? event.text ?? event.refusal, event.type.endsWith(".done"));
        break;
      case "response.output_item.done":
        if (event.item) output.itemDone(event.item, key);
        break;
      case "response.completed": {
        const reply = responsesReply(event.response ?? {});
        event.response?.output?.forEach((item, index) => output.itemDone(item, item.id ?? String(index)));
        return reply;
      }
      case "response.failed":
      case "response.incomplete":
      case "error":
        throw new Error(`Model stream: ${event.message ?? event.response?.error?.message ?? event.type}`);
    }
  }
  throw new Error("Responses stream ended before completion");
}

export class ScriptModel implements Model {
  private index = 0;

  constructor(private readonly steps: Array<Reply | ((messages: Message[]) => Reply)>) {}

  async next(messages: Message[], _tools: ToolSpec[], signal: AbortSignal): Promise<Reply> {
    signal.throwIfAborted();
    const step = this.steps[this.index++];
    if (!step) throw new Error("Offline model script exhausted");
    return typeof step === "function" ? step(messages) : step;
  }
}

export class HttpModel implements Model {
  constructor(private readonly config: ModelConfig, private readonly credential?: () => string | undefined) {}

  async next(messages: Message[], tools: ToolSpec[], signal: AbortSignal, display?: Display): Promise<Reply> {
    const { endpoint, name, keyEnv, protocol } = this.config;
    const credential = this.credential?.() ?? process.env[keyEnv];
    if (!credential) throw new Error(`Set the model credential environment variable ${keyEnv}`);
    const functions = tools.map(({ name, description, schema }) => ({
      name, description, parameters: schema,
    }));
    const chat = protocol !== "responses";
    const body = chat ? {
      model: name,
      messages: messages.map(message => {
        if (message.role === "tool") {
          return { role: "tool", content: message.content, tool_call_id: message.id };
        }
        if (message.role === "assistant" && message.calls?.length) {
          return {
            role: "assistant", content: message.content || null,
            tool_calls: message.calls.map(call => ({
              id: call.id, type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          };
        }
        return { role: message.role, content: message.content };
      }),
      tools: functions.map(fn => ({ type: "function", function: fn })),
    } : {
      model: name,
      store: false,
      input: messages.flatMap((message): object[] => {
        if (message.role === "tool") {
          return [{ type: "function_call_output", call_id: message.id, output: message.content }];
        }
        const text = message.content ? [{ role: message.role, content: message.content }] : [];
        if (message.role !== "assistant") return text;
        return [...text, ...(message.calls ?? []).map(call => ({
          type: "function_call", call_id: call.id, name: call.name,
          arguments: JSON.stringify(call.args),
        }))];
      }),
      tools: functions.map(fn => ({ type: "function", ...fn, strict: false })),
    };
    const request = (payload: object) => fetch(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify(payload),
    });
    const streaming = display ? { stream: true } : {};
    const summary = display && !chat ? { reasoning: { summary: "auto" } } : {};
    let response = await request({ ...body, ...streaming, ...summary });
    if (response.status === 400 && summary.reasoning) {
      const problem = await response.json().catch(() => undefined) as { error?: { param?: string } } | undefined;
      if (typeof problem?.error?.param === "string" && /^reasoning(?:\.|$)/.test(problem.error.param)) {
        response = await request({ ...body, ...streaming });
      }
    }
    if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return chat ? chatStream(response, display) : responsesStream(response, display);
    }
    if (chat) {
      const data = await response.json() as ChatResponse;
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("Missing Chat Completions message");
      return {
        text: message.content ?? "",
        calls: chatCalls(message.tool_calls),
      };
    }
    const data = await response.json() as ResponsesResult;
    const reply = responsesReply(data);
    const output = responsesOutput(display);
    data.output?.forEach((item, index) => output.itemDone(item, item.id ?? String(index)));
    return reply;
  }
}
