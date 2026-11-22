import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

export interface TestMcpServer {
  port: number
  /** 供断言用的已执行调用记录 */
  calls: Array<{ name: string; args: Record<string, unknown> }>
  close: () => Promise<void>
}

/**
 * 测试专用 MCP 服务器（Streamable HTTP）：提供 echo 工具。
 * 每个客户端会话用 SDK 的 Server + StreamableHTTPServerTransport，
 * 走的是和线上一致的 MCP 协议握手。
 */
export function startTestMcpServer(): Promise<TestMcpServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  const makeSession = (): StreamableHTTPServerTransport => {
    const server = new Server({ name: 'test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo',
          description: '回显工具：把 message 原样加前缀返回',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string', description: '要回显的文本' } },
            required: ['message'],
          },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      calls.push({ name, args: (args ?? {}) as Record<string, unknown> })
      if (name === 'echo') {
        return { content: [{ type: 'text', text: `echo:${String((args as { message?: string }).message ?? '')}` }] }
      }
      return { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true }
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport)
      },
      onclose: () => {
        for (const [id, t] of sessions) {
          if (t === transport) sessions.delete(id)
        }
      },
    })
    void server.connect(transport)
    return transport
  }

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : undefined
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req)
    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (existing) {
      await existing.handleRequest(req, res, body)
      return
    }
    if (body !== undefined && !Array.isArray(body) && isInitializeRequest(body)) {
      // 新会话：transport 在握手回调里注册进 sessions
      const transport = makeSession()
      await transport.handleRequest(req, res, body)
      return
    }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }))
  }

  const httpServer: HttpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.writeHead(500).end()
      } catch {
        /* 已响应过的流忽略 */
      }
    })
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as { port: number }).port
      resolve({
        port,
        calls,
        close: () => new Promise<void>((done) => httpServer.close(() => done())),
      })
    })
  })
}
