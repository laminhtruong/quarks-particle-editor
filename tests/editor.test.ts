import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTexture, Group, MeshBasicMaterial } from 'three'
import type { Object3D } from 'three'
import { BatchedRenderer, ParticleSystem, QuarksLoader } from 'three.quarks'
import { createParticleEditor } from '../src/index'
import type { ParticleEditor, ParticleEditorOptions } from '../src/index'
import { parseQuarksDocument } from '../src/document'
import type { QuarksDocument } from '../src/document'
import * as localFiles from '../src/local-files'

const gpu = vi.hoisted(() => ({ dispose: vi.fn(), controlsDispose: vi.fn(), setSize: vi.fn() }))
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    setPixelRatio() {}
    setSize = gpu.setSize
    render() {}
    dispose = gpu.dispose
  },
}))
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = { set: vi.fn() }
    update() {}
    dispose = gpu.controlsDispose
  },
}))

class ElementStub {
  innerHTML = ''
  textContent = ''
  value = ''
  inert = false
  children: ElementStub[] = []
  parent?: ElementStub
  shadowRoot?: ElementStub
  classList = { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }
  listeners = new Map<string, (event: unknown) => void>()
  elements = new Map<string, ElementStub>()
  querySelector(selector: string): ElementStub {
    let element = this.elements.get(selector)
    if (!element) {
      element = new ElementStub()
      this.elements.set(selector, element)
    }
    return element
  }
  querySelectorAll() {
    return []
  }
  setAttribute() {}
  append(...children: ElementStub[]) {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  attachShadow() {
    return (this.shadowRoot = new ElementStub())
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
  }
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: AddEventListenerOptions,
  ) {
    this.listeners.set(type, listener)
    options?.signal?.addEventListener('abort', () => this.listeners.delete(type))
  }
}

const instances: ParticleEditor[] = []
let browser: ElementStub
let disconnect: ReturnType<typeof vi.fn>
let onResize: () => void

beforeEach(() => {
  vi.useFakeTimers()
  gpu.dispose.mockClear()
  gpu.controlsDispose.mockClear()
  gpu.setSize.mockClear()
  const document = Object.assign(new ElementStub(), {
    baseURI: 'https://example.com/project/',
    createElement: () => new ElementStub(),
  })
  browser = Object.assign(new ElementStub(), {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    confirm: vi.fn(() => true),
  })
  disconnect = vi.fn()
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', browser)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        onResize = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Editor must not fetch project APIs')
    }),
  )
})

afterEach(() => {
  for (const editor of instances.splice(0)) editor.destroy()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function effect(id = 'project-effect', material = new MeshBasicMaterial()) {
  const group = new Group()
  group.name = id
  group.add(new ParticleSystem({ material, autoDestroy: false }).emitter)
  return { id, json: parseQuarksDocument(group.toJSON()) }
}

function mount(options?: ParticleEditorOptions) {
  const container = new ElementStub()
  const editor = createParticleEditor(container as unknown as HTMLElement, options)
  instances.push(editor)
  const root = container.children[0]!.shadowRoot!.children[1]!
  const click = (action: string) =>
    root.listeners.get('click')?.({
      target: { closest: () => ({ dataset: { action } }) },
    })
  const select = (id: string) =>
    root.listeners.get('click')?.({
      target: { closest: () => ({ dataset: { effect: id } }) },
    })
  return { editor, container, root, click, select }
}

describe('project-independent particle editor', () => {
  it('resolves textures imported after JSON without losing edits or inactive effects', async () => {
    const pixel = new DataTexture(new Uint8Array([255, 128, 0, 255]), 1, 1)
    const first = effect('first', new MeshBasicMaterial({ map: pixel }))
    const second = effect('second', new MeshBasicMaterial({ map: pixel }))
    const imageData = structuredClone(first.json.images![0]!.url)
    first.json.images![0]!.url = 'textures/smoke.png'
    second.json.images![0]!.url = 'textures/smoke.png'
    const parse = QuarksLoader.prototype.parse
    // Decode-free native scene loading; retain browser-like absolute image src values.
    const load = vi.spyOn(QuarksLoader.prototype, 'parse').mockImplementation(function <
      T extends Object3D,
    >(json: QuarksDocument): T {
      const copy = structuredClone(json)
      for (const image of copy.images ?? []) image.url = imageData
      const group = parse.call(new QuarksLoader(), copy) as T
      group.traverse((object) => {
        if (object.type === 'ParticleEmitter' && 'system' in object) {
          const material = (object.system as ParticleSystem).material as MeshBasicMaterial
          ;(material.map!.image as { src: string }).src = new URL(
            String(json.images![0]!.url),
            document.baseURI,
          ).href
        }
      })
      return group
    })
    const embedded = 'data:image/png;base64,aGVsbG8='
    vi.spyOn(localFiles, 'readTextureFile').mockResolvedValue(embedded)
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click, select } = mount({
      listEffects: async () => [first, second],
      saveEffect,
    })
    await editor.ready
    root.listeners.get('change')?.({
      target: { dataset: { nativePath: '["ps","duration"]', nativeKind: 'number' }, value: '7' },
    })
    root.querySelector('[data-texture-input]').listeners.get('change')?.({
      target: { files: [{ name: 'smoke.png' }] },
    })
    await vi.waitFor(() => expect(load.mock.calls.at(-1)![0].images![0]!.url).toBe(embedded))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('value="7"')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    expect(saveEffect.mock.calls[0]![1].images![0]!.url).toBe(embedded)
    select('second')
    expect(load.mock.calls.at(-1)![0].images![0]!.url).toBe(embedded)
    expect(first.json.images![0]!.url).toBe('textures/smoke.png')
  })

  it('keeps the inspector usable when a native simulation throws', async () => {
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    vi.spyOn(BatchedRenderer.prototype, 'update').mockImplementationOnce(() => {
      throw new Error('Native behavior failed')
    })
    vi.mocked(window.requestAnimationFrame).mock.calls[0]![0](performance.now() + 16)
    expect(root.querySelector('.toast').textContent).toContain(
      'Preview paused: Native behavior failed',
    )
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)
    click('duplicate-system')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
  })
  it('commits a native generator edit with undo and rejects invalid edits without data loss', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: unknown) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    const change = (dataset: Record<string, string>, value: string) =>
      root.listeners.get('change')?.({ target: { dataset, value } })
    change({ nativeAction: 'generator', nativePath: '["ps","startSize"]' }, 'Vector3Function')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(saveEffect.mock.calls[0]![1])).toContain('Vector3Function')
    click('undo')
    expect(root.querySelector('[data-inspector]').innerHTML).not.toContain(
      'value="Vector3Function" selected',
    )
    change({ nativePath: '["ps","duration"]', nativeKind: 'number' }, '-1')
    expect(root.querySelector('.toast').textContent).toContain('must be positive')
  })

  it('adds, disables, and restores a registered behavior through the inspector', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: unknown) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    root.listeners.get('change')?.({ target: { dataset: { addBehavior: '' }, value: 'Noise' } })
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Frequency')
    root.listeners.get('change')?.({
      target: { dataset: { nativeAction: 'behavior-toggle', slot: '0' }, checked: false },
    })
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const saved = saveEffect.mock.calls[0]![1] as {
      object: { children: { ps: { behaviors: unknown[] }; userData: Record<string, unknown> }[] }
    }
    expect(saved.object.children[0]!.ps.behaviors).toHaveLength(0)
    expect(saved.object.children[0]!.userData.quarksEditorDisabled).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ type: 'Noise' }) }),
    ])
    root.listeners.get('change')?.({
      target: { dataset: { nativeAction: 'behavior-toggle', slot: '0' }, checked: true },
    })
    expect(root.querySelector('[data-inspector]').innerHTML).not.toContain('<fieldset disabled>')
  })

  it('defers canvas size writes until the animation frame to avoid resize observer loops', async () => {
    const { editor, root } = mount()
    await editor.ready
    Object.assign(root.querySelector('.viewport'), {
      getBoundingClientRect: () => ({ width: 420.8, height: 300.5 }),
    })
    onResize()
    expect(gpu.setSize).not.toHaveBeenCalled()
    const frame = vi.mocked(window.requestAnimationFrame).mock.calls[0]![0]
    frame(0)
    expect(gpu.setSize).toHaveBeenCalledWith(420, 300, false)
    frame(0)
    expect(gpu.setSize).toHaveBeenCalledTimes(1)
  })
  it('starts empty without assets, project API requests, or a save backend', async () => {
    const { editor, root } = mount()
    await editor.ready
    expect(root.querySelector('[data-effect-count]').textContent).toBe('00')
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Select or create')
    expect(editor.hasUnsavedChanges()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('browses only host effects and textures and does not mutate host documents', async () => {
    const source = effect()
    const original = structuredClone(source)
    const { editor, root, click } = mount({
      listEffects: async () => [source],
      listTextures: async () => [{ id: 'custom texture', url: '../sprites/smoke.webp?v=2' }],
    })
    await editor.ready
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('custom texture')
    click('duplicate-system')
    expect(source).toEqual(original)
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps new edits dirty while an earlier save is in flight', async () => {
    let finishSave!: () => void
    const saveEffect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    const { editor, click, root } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    click('save')
    click('duplicate-system')
    click('save')
    expect(saveEffect).toHaveBeenCalledTimes(1)
    finishSave()
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Saved native'),
    )
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('shows the inspector after importing the first effect into an empty project', async () => {
    const { editor, root } = mount()
    await editor.ready
    root.querySelector('[data-file-input]').listeners.get('change')?.({
      target: {
        files: [{ name: 'imported.json', text: async () => JSON.stringify(effect().json) }],
      },
    })
    await vi.waitFor(() =>
      expect(root.querySelector('[data-inspector]').innerHTML).toContain('inspector-head'),
    )
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('uses Unity-style module foldouts and remembers collapsed modules after updates', async () => {
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('data-module="Main" open')
    root.listeners.get('toggle')?.({ target: { dataset: { module: 'Main' }, open: false } })
    click('duplicate-system')
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('data-module="Main" >')
    expect(root.querySelector('[data-inspector]').innerHTML).toContain(
      'data-module="Emission" open',
    )
  })

  it('rejects oversized JSON without reading or replacing the current document', async () => {
    const { editor, root } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    const text = vi.fn()
    root.querySelector('[data-file-input]').listeners.get('change')?.({
      target: { files: [{ name: 'huge.json', size: 64 * 1024 * 1024 + 1, text }] },
    })
    expect(text).not.toHaveBeenCalled()
    expect(root.querySelector('.toast').textContent).toContain('64 MB')
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
  })

  it('retains the current effect after invalid runtime JSON is opened', async () => {
    const { editor, root } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    const json = {
      metadata: { type: 'Object', version: 4.7 },
      object: {
        type: 'Group',
        name: 'broken',
        children: [{ type: 'ParticleEmitter' }],
      },
    }
    root.querySelector('[data-file-input]').listeners.get('change')?.({
      target: { files: [{ name: 'broken.json', text: async () => JSON.stringify(json) }] },
    })
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).not.toBe(''))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('project-effect')
    expect(editor.hasUnsavedChanges()).toBe(false)
  })

  it('downloads JSON without a backend and keeps a discard snapshot', async () => {
    const download = vi.fn()
    vi.stubGlobal(
      'document',
      Object.assign(new ElementStub(), {
        baseURI: 'https://example.com/',
        createElement: () => Object.assign(new ElementStub(), { click: download }),
      }),
    )
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { editor, root, click, select } = mount({
      listEffects: async () => [effect('first'), effect('second')],
    })
    await editor.ready
    click('duplicate-system')
    click('save')
    expect(download).toHaveBeenCalledTimes(1)
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(revoke).toHaveBeenCalledWith('blob:download')
    expect(root.querySelector('.toast').textContent).toContain('original file unchanged')
    expect(editor.hasUnsavedChanges()).toBe(false)
    click('duplicate-system')
    select('second')
    select('first')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
  })

  it('restores the last saved custom effect, not a bundled preset, on discard', async () => {
    const { editor, click, select, root } = mount({
      listEffects: async () => [effect('first'), effect('second')],
      saveEffect: async () => {},
    })
    await editor.ready
    click('duplicate-system')
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    click('duplicate-system')
    select('second')
    select('first')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
  })

  it('retains the document when project deletion fails', async () => {
    const { editor, click, root } = mount({
      listEffects: async () => [effect()],
      deleteEffect: async () => {
        throw new Error('Permission denied')
      },
    })
    await editor.ready
    click('delete-effect')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toBe('Permission denied'),
    )
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('project-effect')
  })

  it('reports save errors without clearing unsaved changes', async () => {
    const { editor, click, root } = mount({
      listEffects: async () => [effect()],
      saveEffect: async () => {
        throw new Error('Disk full')
      },
    })
    await editor.ready
    click('duplicate-system')
    click('save')
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Disk full'))
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('protects project defaults from deletion and resets overrides through the host', async () => {
    const source = effect()
    const deleteEffect = vi.fn(async () => {})
    const { editor, click, root } = mount({
      listEffects: async () => [{ ...source, defaultJson: source.json }],
      deleteEffect,
    })
    await editor.ready
    click('delete-effect')
    expect(deleteEffect).not.toHaveBeenCalled()
    click('duplicate-system')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    click('reset-effect')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toBe('Project default restored'),
    )
    expect(deleteEffect).toHaveBeenCalledWith('project-effect')
    expect(root.querySelector('[data-system-count]').textContent).toBe('01')
    expect(editor.hasUnsavedChanges()).toBe(false)
  })

  it('preserves an embedded texture and authored material settings when changing blending', async () => {
    class SelectStub extends ElementStub {
      dataset = { bind: 'additive' }
    }
    vi.stubGlobal('HTMLSelectElement', SelectStub)
    vi.stubGlobal('HTMLInputElement', class {})
    const map = new DataTexture(new Uint8Array([255, 128, 0, 255]), 1, 1)
    const source = effect(
      'embedded',
      new MeshBasicMaterial({ map, opacity: 0.35, transparent: true }),
    )
    const saveEffect = vi.fn(async () => {})
    const { editor, root, click } = mount({ listEffects: async () => [source], saveEffect })
    await editor.ready
    const select = new SelectStub()
    select.value = 'false'
    root.listeners.get('input')?.({ target: select })
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const saved = (saveEffect.mock.calls[0] as unknown as [string, typeof source.json])[1]
    expect(saved.images?.map((image) => image.url)).toEqual(
      source.json.images?.map((image) => image.url),
    )
    expect(saved.materials).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0.35, map: expect.any(String) })]),
    )
  })

  it('keeps the edited document when a reset fails', async () => {
    const source = effect()
    const { editor, click, root } = mount({
      listEffects: async () => [{ ...source, defaultJson: source.json }],
      deleteEffect: async () => {
        throw new Error('Reset refused')
      },
    })
    await editor.ready
    click('duplicate-system')
    click('reset-effect')
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Reset refused'))
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect(root.inert).toBe(false)
  })

  it('removes a saved effect only after the host confirms deletion', async () => {
    let finish!: () => void
    const { editor, click, root } = mount({
      listEffects: async () => [effect()],
      deleteEffect: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await editor.ready
    click('delete-effect')
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
    finish()
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('00'))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Select or create')
  })

  it('rejects unsafe project textures and exposes loading failures through ready', async () => {
    const { editor } = mount({
      listTextures: async () => [{ id: 'bad', url: 'javascript:alert(1)' }],
    })
    await expect(editor.ready).rejects.toThrow('texture must use')
  })

  it('does not initialize WebGL after unmount while project data is loading', async () => {
    let resolve!: (value: []) => void
    const { editor, container } = mount({
      listEffects: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    editor.destroy()
    resolve([])
    await editor.ready
    expect(container.children).toHaveLength(0)
    expect(gpu.dispose).not.toHaveBeenCalled()
  })

  it('isolates instances, shortcuts, and releases resources on repeated destroy', async () => {
    const first = mount({ listEffects: async () => [effect()] })
    const second = mount()
    await Promise.all([first.editor.ready, second.editor.ready])
    expect(first.root.listeners.has('keydown')).toBe(true)
    first.editor.destroy()
    first.editor.destroy()
    expect(first.container.children).toHaveLength(0)
    expect(second.container.children).toHaveLength(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(gpu.dispose).toHaveBeenCalledTimes(1)
    expect(gpu.controlsDispose).toHaveBeenCalledTimes(1)
    expect(first.root.listeners.size).toBe(0)
    expect(browser.listeners.has('keydown')).toBe(false)
  })
})
