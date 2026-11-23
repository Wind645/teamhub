export type Args = Record<string, unknown>;
export type ToolSpec = { name: string; description: string; schema: Args };
export type Call = { id: string; name: string; args: unknown };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; calls?: Call[] }
  | { role: "tool"; content: string; id: string };
export type Reply = { text: string; calls?: Call[] };
export type Model = {
  next(messages: Message[], tools: ToolSpec[], signal: AbortSignal): Promise<Reply>;
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
  constructor(private readonly config: ModelConfig) {}

  async next(messages: Message[], tools: ToolSpec[], signal: AbortSignal): Promise<Reply> {
    const { endpoint, name, keyEnv, protocol } = this.config;
    const credential = process.env[keyEnv];
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
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
    if (chat) {
      const data = await response.json() as { choices?: Array<{
        message: { content: string | null; tool_calls?: Array<{
          id: string; function: { name: string; arguments: string };
        }> };
      }> };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("Missing Chat Completions message");
      return {
        text: message.content ?? "",
        calls: message.tool_calls?.map(call => ({
          id: call.id, name: call.function.name, args: argumentsOf(call.function.arguments),
        })),
      };
    }
    const data = await response.json() as { output?: Array<{
      type: string; call_id: string; name: string; arguments: string;
      content?: Array<{ type: string; text?: string; refusal?: string }>;
    }> };
    if (!Array.isArray(data.output)) throw new Error("Missing Responses output");
    return {
      text: data.output.flatMap(item => item.content ?? []).map(part => part.text ?? part.refusal ?? "").join("\n"),
      calls: data.output.filter(item => item.type === "function_call").map(item => ({
        id: item.call_id, name: item.name, args: argumentsOf(item.arguments),
      })),
    };
  }
}
