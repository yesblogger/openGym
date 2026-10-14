#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.
   Reads a local data folder, or accesses a self-hosted OpenGym instance over HTTPS. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { init, getUser, withRemoteState } from './state.js'
import { createRemoteClient } from './remote.js'
import { searchTool, WRITE_TOOLS } from './write-tools.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

const remote = createRemoteClient()
let writable = false
if (remote) {
  try {
    const snapshot = await remote.snapshot()
    writable = snapshot.scopes.includes('write')
    console.error(`[opengym-mcp] serving remote profile ${snapshot.user.name} (${writable ? 'read/write' : 'read only'})`)
  } catch (e) {
    console.error(`[opengym-mcp] ${e.code || 'ERROR'}: ${e.message}`)
    process.exit(1)
  }
} else {
  try { init(); console.error(`[opengym-mcp] serving profile ${getUser().name}`) }
  catch (e) { console.error(`[opengym-mcp] ${e.message}`) }
}

for (const t of [...TOOLS, searchTool, ...(writable ? WRITE_TOOLS : [])]) {
  const writes = WRITE_TOOLS.includes(t)
  server.registerTool(t.name, {
    description: t.description, inputSchema: t.schema,
    annotations: { readOnlyHint: !writes, destructiveHint: writes, idempotentHint: true, openWorldHint: false }
  }, async (params) => {
    try {
      const result = writes ? await remote.mutate(t.name, params)
        : remote ? withRemoteState(await remote.snapshot(), () => t.handler(params || {})) : t.handler(params || {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `${e.code || 'ERROR'}: ${e.message}` }] }
    }
  })
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
