import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolHandle, ToolResult, ToolSet } from "./tools.ts";

export interface ConnectOptions {
  /** Ім'я сервера → URL його /mcp. Ім'я — перша частина ToolRef ("relocation" у "relocation.get_search"). */
  servers: Record<string, string>;
  /** Інструменти зі специфікації агента, формат "server.tool". */
  allowlist: readonly string[];
  /**
   * Заголовки автентифікації для сервера — на КОЖЕН HTTP-запит, а не раз при підключенні:
   * делегований токен живе 5 хвилин, має aud саме цього сервера і run_id поточного ходу.
   * Етап 4: `Authorization: Bearer <JWT від STS>`; тести — x-debug-*.
   */
  authHeaders: (server: string) => Promise<Record<string, string>>;
  /** Підміна fetch для тестів (запити йдуть у Hono-застосунки в пам'яті). */
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Крапки в іменах інструментів Anthropic не приймає (^[a-zA-Z0-9_-]+$), тож "server.tool" → "server__tool". */
export const toModelName = (ref: string) => ref.replace(".", "__");

/**
 * Підключитися до MCP-серверів і зібрати набір інструментів агента.
 *
 * Перетин прав, половина runtime: модель бачить ЛИШЕ інструменти з allowlist специфікації.
 * Друга половина — на сервері: authorize перевіряє, що КОРИСТУВАЧ має право на дію.
 * Агент отримує перетин: що дозволено агенту І що дозволено людині.
 */
export async function connectTools(opts: ConnectOptions): Promise<ToolSet> {
  // Групуємо allowlist за сервером: {"relocation": Set{"get_search", ...}}.
  const wanted = new Map<string, Set<string>>();
  for (const ref of opts.allowlist) {
    const [server, tool] = ref.split(".") as [string, string];
    if (!(server in opts.servers)) throw new Error(`Специфікація агента посилається на невідомий сервер «${server}» (${ref})`);
    wanted.set(server, (wanted.get(server) ?? new Set()).add(tool));
  }

  const clients: Client[] = [];
  const handles = new Map<string, ToolHandle>();
  try {
    for (const [server, tools] of wanted) {
      const baseFetch = opts.fetch ?? fetch;
      const transport = new StreamableHTTPClientTransport(new URL(opts.servers[server]!), {
        // Обгортка fetch: SDK кличе її на кожен запит, ми додаємо свіжі заголовки.
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          for (const [k, v] of Object.entries(await opts.authHeaders(server))) headers.set(k, v);
          return baseFetch(url, { ...init, headers });
        },
      });
      const client = new Client({ name: "reloc-runtime", version: "0.1.0" });
      await client.connect(transport);
      clients.push(client);

      const { tools: listed } = await client.listTools();
      for (const name of tools) {
        const t = listed.find((x) => x.name === name);
        // Краще впасти на старті, ніж дізнатися посеред розмови, що інструмента немає.
        if (!t) throw new Error(`Інструмента ${server}.${name} немає на сервері ${server}. Є: ${listed.map((x) => x.name).join(", ")}`);
        const ref = `${server}.${name}`;
        const modelName = toModelName(ref);
        handles.set(modelName, {
          ref,
          modelName,
          def: { type: "function", function: { name: modelName, ...(t.description && { description: t.description }), parameters: t.inputSchema } },
          call: async (args, meta) => {
            // _meta — службовий канал MCP: модель його не бачить і не формує. Тут їде ключ ідемпотентності.
            const r = await client.callTool({ name, arguments: args as Record<string, unknown>, _meta: { idempotencyKey: meta.idempotencyKey } });
            return toResult(r);
          },
        });
      }
    }
  } catch (e) {
    await Promise.all(clients.map((c) => c.close()));
    throw e;
  }

  return {
    defs: [...handles.values()].map((h) => h.def),
    get: (modelName) => handles.get(modelName),
    close: async () => {
      await Promise.all(clients.map((c) => c.close()));
    },
  };
}

/** Результат MCP → текст для моделі. Обидва наші сервери кладуть JSON у перший текстовий блок. */
function toResult(r: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
  const content = (r.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return { isError: r.isError === true, text };
}
