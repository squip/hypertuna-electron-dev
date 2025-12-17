#!/usr/bin/env node
// Find a free port, start Vite there, then launch Electron pointed at it.
const { spawn } = require('node:child_process')
const path = require('node:path')

const HOST = process.env.HOST || 'localhost'
const START_PORT = Number(process.env.PORT) || 5173

async function main() {
  let resolvedRendererUrl = null
  let electronStarted = false

  const vite = spawn('npm', ['run', 'dev:web', '--', '--host', '--port', String(START_PORT)], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(START_PORT) }
  })

  vite.stdout.on('data', (data) => {
    const text = data.toString()
    process.stdout.write(text)
    const match = text.match(/http:\/\/[^:]+:(\d+)\//)
    if (match && !electronStarted) {
      const port = match[1]
      resolvedRendererUrl = `http://${HOST}:${port}`
      startElectron(resolvedRendererUrl)
      electronStarted = true
    }
  })

  vite.on('exit', (code) => {
    if (!electronStarted) {
      console.error('[dev-electron] Vite exited before Electron started.')
    }
    if (code !== 0) {
      console.error('[dev-electron] Vite exited with code', code)
      process.exit(code || 1)
    }
  })

  function startElectron(rendererUrl) {
    const electronDir = path.join(__dirname, '..', '..', 'hypertuna-desktop')
    const electron = spawn('npm', ['run', 'dev'], {
      cwd: electronDir,
      stdio: 'inherit',
      env: { ...process.env, RENDERER_URL: rendererUrl }
    })

    electron.on('exit', (code) => {
      vite.kill()
      if (code !== 0) {
        console.error('[dev-electron] Electron exited with code', code)
        process.exit(code || 1)
      }
    })
  }
}

main().catch((err) => {
  console.error('[dev-electron] Failed:', err)
  process.exit(1)
})
