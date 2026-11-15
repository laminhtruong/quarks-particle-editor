import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { Group, MeshBasicMaterial } from 'three'
import { ParticleSystem } from 'three.quarks'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

// Real layout is not exercised by the editor's DOM stubs. Opt in with CHROME_PATH.
it.skipIf(!process.env.CHROME_PATH)(
  'keeps preview layout independent of unfiltered project size in Chromium',
  async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? tmpdir(), 'particle-preview-test-'))
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
    const chrome = spawn(
      process.env.CHROME_PATH!,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        `--user-data-dir=${directory}`,
        '--no-first-run',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    )
    const input = chrome.stdio[3] as Writable
    const output = chrome.stdio[4] as Readable
    let id = 0
    let sessionId: string | undefined
    let buffer = ''
    let loaded: (() => void) | undefined
    const pending = new Map<
      number,
      { resolve: (result: any) => void; reject: (error: Error) => void }
    >()
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.method === 'Page.loadEventFired') loaded?.()
        const request = pending.get(message.id)
        if (!request) continue
        pending.delete(message.id)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      }
    })
    const send = (method: string, params = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject })
        input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
      })
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    try {
      await server.listen()
      const target = await send('Target.createTarget', { url: 'about:blank' })
      sessionId = (
        await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      ).sessionId
      await send('Page.enable')
      await send('Performance.enable')
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const pageLoaded = new Promise<void>((resolve) => {
        loaded = resolve
      })
      await send('Page.navigate', { url: server.resolvedUrls!.local[0] })
      await pageLoaded
      const group = new Group()
      group.add(
        new ParticleSystem({
          material: new MeshBasicMaterial(),
          duration: 60,
          looping: true,
          autoDestroy: false,
        }).emitter,
      )
      await evaluate(`(async () => {
        window.dispatchEvent(new Event('pagehide'));
        window.createEditor = (await import('/src/index.ts')).createParticleEditor;
        window.fixture = ${JSON.stringify(group.toJSON())};
      })()`)
      // Compare the same live simulation with full vs filtered lists, not different effects/GPUs.
      const measure = async () => {
        const metrics = async () =>
          new Map<string, number>(
            (await send('Performance.getMetrics')).metrics.map(
              (m: { name: string; value: number }) => [m.name, m.value],
            ),
          )
        await evaluate(
          `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        )
        const before = await metrics()
        await evaluate(
          `new Promise(resolve => { let frames = 0; const tick = () => ++frames === 40 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick) })`,
        )
        const after = await metrics()
        return (
          (after.get('LayoutDuration')! - before.get('LayoutDuration')!) /
          Math.max(1, after.get('LayoutCount')! - before.get('LayoutCount')!)
        )
      }
      for (const [effects, textures] of [
        [1325, 239],
        [4, 500],
      ]) {
        await evaluate(`(async () => {
          window.testEditor?.destroy();
          window.testEditor = createEditor(document.querySelector('#editor'), {
            listEffects: async () => Array.from({length:${effects}}, (_,i) => ({id:'effect-'+i,json:fixture})),
            listTextures: async () => Array.from({length:${textures}}, (_,i) => ({id:'texture-'+i,url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}))
          });
          await testEditor.ready;
          window.root = document.querySelector('#editor > div').shadowRoot;
          window.search = root.querySelector('[data-search]');
        })()`)
        const full = await measure()
        await evaluate(
          `search.value='effect-0'; search.dispatchEvent(new Event('input',{bubbles:true})); root.querySelector('[data-texture-list]').hidden=true`,
        )
        const filtered = await measure()
        expect(
          full,
          `${effects} effects / ${textures} textures: layout seconds per update`,
        ).toBeLessThan(filtered * 3 + 0.001)
        await evaluate(
          `search.value=''; search.dispatchEvent(new Event('input',{bubbles:true})); root.querySelector('[data-texture-list]').hidden=false`,
        )
        expect(await evaluate(`root.querySelectorAll('[data-effect]').length`)).toBe(effects)
        const restored = await measure()
        expect(restored).toBeLessThan(filtered * 3 + 0.001)
        expect(await evaluate(`root.querySelector('[data-time]').textContent !== '0.00'`)).toBe(
          true,
        )
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width: 700,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      expect(
        await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
        const panes = [...root.querySelectorAll('.project-columns > section')];
        const columns = root.querySelector('.project-columns');
        resolve(panes.every(p => p.getBoundingClientRect().height > 0) && columns.scrollHeight > columns.clientHeight);
      }))`),
      ).toBe(true)
    } finally {
      chrome.kill()
      await server.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60000,
)
