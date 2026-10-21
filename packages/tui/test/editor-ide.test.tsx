/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { EditorContextProvider, useEditorContext, type EditorMention } from "../src/context/editor"
import { TuiAppProvider } from "../src/context/runtime"
import { tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

// End-to-end check of the Claude Code IDE integration: a fake IDE publishes a lock file under
// CLAUDE_CONFIG_DIR/ide and serves the WebSocket protocol, and the real EditorContextProvider
// discovers it, authenticates, announces its version and receives the selection.

const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT,
  OPENCODE_EDITOR_SSE_PORT: process.env.OPENCODE_EDITOR_SSE_PORT,
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("connects to an IDE found through its lock file and receives its selection", async () => {
  await using ide = await fakeIde({ token: "secret-token" })
  const editor = await mountEditor(ide.workspace)
  try {
    await until(() => editor.context.server()?.serverInfo?.version === "9.9.9")
    expect(ide.authorizations).toEqual(["secret-token"])
    expect(ide.initialize).toMatchObject({
      protocolVersion: "2025-11-25",
      clientInfo: { name: "opencode", version: "1.2.3" },
    })
    expect(editor.context.connected()).toBe(true)

    await until(() => ide.initialized)
    ide.send("selection_changed", {
      text: "const answer = 42",
      filePath: path.join(ide.workspace, "src/index.ts"),
      selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 17 } },
    })
    await until(() => editor.context.selection() !== undefined)
    expect(editor.context.selection()).toEqual({
      filePath: path.join(ide.workspace, "src/index.ts"),
      source: "websocket",
      ranges: [
        {
          text: "const answer = 42",
          selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 17 } },
        },
      ],
    })
    expect(editor.context.labelState()).toBe("pending")

    ide.send("at_mentioned", { filePath: path.join(ide.workspace, "README.md"), lineStart: 1, lineEnd: 4 })
    await until(() => editor.mentions.length > 0)
    expect(editor.mentions).toEqual([{ filePath: path.join(ide.workspace, "README.md"), lineStart: 1, lineEnd: 4 }])
  } finally {
    editor.dispose()
  }
})

test("stays disconnected when the IDE rejects the auth token", async () => {
  await using ide = await fakeIde({ token: "secret-token", lockToken: "wrong-token" })
  const editor = await mountEditor(ide.workspace)
  try {
    await until(() => ide.authorizations.length > 0)
    expect(ide.authorizations).toEqual(["wrong-token"])
    expect(ide.initialize).toBeUndefined()
    expect(editor.context.connected()).toBe(false)
    expect(editor.context.server()).toBeUndefined()
  } finally {
    editor.dispose()
  }
})

async function fakeIde(input: { token: string; lockToken?: string }) {
  const root = await tmpdir()
  const workspace = path.join(root.path, "workspace")
  await mkdir(workspace)
  const state = {
    workspace,
    authorizations: [] as string[],
    initialize: undefined as unknown,
    initialized: false,
    socket: undefined as Bun.ServerWebSocket<unknown> | undefined,
    send(method: string, params: unknown) {
      state.socket?.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
    },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const token = request.headers.get("x-claude-code-ide-authorization") ?? ""
      state.authorizations.push(token)
      if (token !== input.token) return new Response("Unauthorized", { status: 401 })
      if (server.upgrade(request)) return
      return new Response("Upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        state.socket = socket
      },
      message(socket, data) {
        const message = JSON.parse(String(data))
        if (message.method === "initialize") {
          state.initialize = message.params
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2025-11-25", serverInfo: { name: "fake-ide", version: "9.9.9" } },
            }),
          )
        }
        if (message.method === "notifications/initialized") state.initialized = true
      },
    },
  })

  const config = path.join(root.path, "claude")
  await mkdir(path.join(config, "ide"), { recursive: true })
  await writeFile(
    path.join(config, "ide", `${server.port}.lock`),
    JSON.stringify({
      pid: process.pid,
      workspaceFolders: [workspace],
      ideName: "Fake IDE",
      transport: "ws",
      authToken: input.lockToken ?? input.token,
    }),
  )
  process.env.CLAUDE_CONFIG_DIR = config
  delete process.env.CLAUDE_CODE_SSE_PORT
  delete process.env.OPENCODE_EDITOR_SSE_PORT

  return Object.assign(state, {
    async [Symbol.asyncDispose]() {
      server.stop(true)
      await root[Symbol.asyncDispose]()
    },
  })
}

async function mountEditor(workspace: string) {
  const mentions: EditorMention[] = []
  let context: ReturnType<typeof useEditorContext> | undefined
  function Probe() {
    context = useEditorContext()
    context.onMention((mention) => mentions.push(mention))
    return <text>editor</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts cwd={workspace}>
        <TuiAppProvider value={{ name: "opencode", version: "1.2.3", channel: "test" }}>
          <EditorContextProvider>
            <Probe />
          </EditorContextProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 5 },
  )
  await app.renderOnce()
  if (!context) throw new Error("EditorContextProvider did not mount")
  return { context, mentions, dispose: () => app.renderer.destroy() }
}

// Waits on connection state, which no frame reflects, with a wall-clock deadline.
async function until(predicate: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the IDE connection")
    await Bun.sleep(10)
  }
}
