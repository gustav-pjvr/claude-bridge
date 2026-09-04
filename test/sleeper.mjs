// Minimal stdio MCP server with one tool that sleeps, used to measure where Claude Code's
// MCP tool-call timeout actually fires.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'sleeper', version: '1.0.0' })

server.registerTool(
  'sleep',
  {
    title: 'Sleep',
    description: 'Sleep for the given number of seconds, then report how long it actually slept.',
    inputSchema: {
      seconds: z.number().int().min(1).max(3600),
      progress: z.boolean().optional().describe('Emit a progress notification every 30s while sleeping.'),
    },
  },
  async ({ seconds, progress }, extra) => {
    const started = Date.now()
    const token = extra?._meta?.progressToken

    let ticker = null
    if (progress && token !== undefined) {
      ticker = setInterval(() => {
        extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: Math.round((Date.now() - started) / 1000),
            total: seconds,
          },
        }).catch(() => {})
      }, 30_000)
    }

    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    if (ticker) clearInterval(ticker)

    const elapsed = Math.round((Date.now() - started) / 1000)
    return { content: [{ type: 'text', text: `SLEPT_OK for ${elapsed}s (requested ${seconds}s)` }] }
  },
)

await server.connect(new StdioServerTransport())
