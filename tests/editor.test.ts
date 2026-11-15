import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTexture, Group, GridHelper, Mesh, MeshBasicMaterial, Scene } from 'three'
import type { Object3D } from 'three'
import { BatchedRenderer, ParticleSystem, QuarksLoader } from 'three.quarks'
import { createParticleEditor } from '../src/index'
import type { ParticleEditor, ParticleEditorOptions } from '../src/index'
import { parseQuarksDocument } from '../src/document'
import type { QuarksDocument } from '../src/document'
import * as localFiles from '../src/local-files'
import * as unityPackages from '../src/unity-package'
import * as projectZip from '../src/project-zip'
import { memoryFolder } from './fixtures/folder'

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
  style = { setProperty: vi.fn() }
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
  removeAttribute() {}
  showModal() {}
  click = vi.fn()
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
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('HTMLTextAreaElement', class {})
  vi.stubGlobal('HTMLSelectElement', class {})
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

describe('batch effect import workflow', () => {
  const choosePackage = (root: ElementStub, name = 'effects.unitypackage') => {
    dropFiles(root, [{ name }])
  }
  it('imports every prefab in one operation, displays a report, and saves native JSON', async () => {
    const convertPrefab = vi.fn(async (path: string) => ({
      json: effect(path.includes('Fire') ? 'fire' : 'smoke').json,
      warnings: ['Unsupported NoiseModule'],
      particleCount: 1,
    }))
    const read = vi.spyOn(unityPackages, 'readUnityPackage').mockResolvedValue({
      prefabs: ['Assets/Fire.prefab', 'Assets/Smoke.prefab'],
      convertPrefab,
    })
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ saveEffect })
    await editor.ready
    expect(root.innerHTML).toContain('data-action="import-effects">Import</button>')
    expect(root.innerHTML).toContain('accept=".zip,.unitypackage"')
    click('import-effects')
    const input = root.querySelector('[data-effects-input]')
    expect(input.click).toHaveBeenCalledOnce()
    input.listeners.get('change')?.({ target: { files: [{ name: 'effects.unitypackage' }] } })
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('02'))
    expect(read).toHaveBeenCalledTimes(1)
    expect(convertPrefab).toHaveBeenCalledWith('Assets/Smoke.prefab')
    expect(convertPrefab).toHaveBeenCalledWith('Assets/Fire.prefab')
    expect(root.querySelector('[data-unity-report-text]').textContent).toContain(
      'Unsupported NoiseModule',
    )
    expect(root.children).toHaveLength(0)
    expect(editor.hasUnsavedChanges()).toBe(true)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    expect(saveEffect.mock.calls[0]![0]).toBe('fire')
    expect(saveEffect.mock.calls[0]![1].object.type).toBe('Group')
  })

  it('skips failed prefabs and renames duplicates without losing existing edits', async () => {
    const convertPrefab = vi
      .fn()
      .mockRejectedValueOnce(new Error('Nested prefab is unsupported'))
      .mockResolvedValue({ json: effect().json, warnings: [], particleCount: 1 })
    vi.spyOn(unityPackages, 'readUnityPackage').mockResolvedValue({
      prefabs: ['Assets/Broken.prefab', 'Assets/One.prefab', 'Assets/Two.prefab'],
      convertPrefab,
    })
    const { editor, root, click, select } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('duplicate-system')
    choosePackage(root)
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('03'))
    const report = root.querySelector('[data-unity-report-text]').textContent
    expect(report).toContain('Nested prefab is unsupported')
    expect(report).toContain('project-effect-2')
    expect(report).toContain('project-effect-3')
    expect((browser as unknown as Window).confirm).not.toHaveBeenCalled()
    select('project-effect')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('routes package drops separately and prevents concurrent imports and mixed-file drops', async () => {
    let finish!: (value: unityPackages.UnityPrefabImport) => void
    const read = vi.spyOn(unityPackages, 'readUnityPackage').mockResolvedValue({
      prefabs: ['Assets/Fire.prefab'],
      convertPrefab: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const { editor, root } = mount()
    await editor.ready
    const drop = (names: string[]) =>
      root.listeners.get('drop')?.({
        preventDefault() {},
        dataTransfer: { files: names.map((name) => ({ name })) },
      })
    drop(['a.unitypackage', 'b.json'])
    expect(read).not.toHaveBeenCalled()
    drop(['a.unitypackage'])
    await vi.waitFor(() => expect(finish).toBeDefined())
    choosePackage(root)
    expect(read).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.toast').textContent).toContain('Finish the current file operation')
    finish({ json: effect('fire').json, warnings: [], particleCount: 1 })
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('01'))
    expect(root.inert).toBe(false)
  })

  it('ignores conversion completion after the editor was destroyed', async () => {
    let finish!: (value: unityPackages.UnityPrefabImport) => void
    vi.spyOn(unityPackages, 'readUnityPackage').mockResolvedValue({
      prefabs: ['Assets/Fire.prefab'],
      convertPrefab: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const { editor, root } = mount()
    await editor.ready
    choosePackage(root)
    await vi.waitFor(() => expect(finish).toBeDefined())
    editor.destroy()
    finish({ json: effect('late').json, warnings: [], particleCount: 1 })
    await Promise.resolve()
    expect(root.querySelector('[data-effect-count]').textContent).toBe('00')
    expect(editor.hasUnsavedChanges()).toBe(false)
  })

  it('keeps the current effect and history when all prefab conversions fail', async () => {
    vi.spyOn(unityPackages, 'readUnityPackage').mockResolvedValue({
      prefabs: ['Assets/NotParticles.prefab'],
      convertPrefab: vi.fn().mockRejectedValue(new Error('No Particle Systems found')),
    })
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('duplicate-system')
    choosePackage(root)
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toContain('Imported 0'))
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    shortcut(root, 'z')
    expect(root.querySelector('[data-system-count]').textContent).toBe('01')
    expect(root.inert).toBe(false)
  })

  it('imports a project ZIP into the session and saves all effects plus unused assets', async () => {
    const path = 'assets/textures/2cf24dba5fb0a30e.png'
    const read = vi.spyOn(projectZip, 'readProjectZip').mockResolvedValue({
      effects: [
        { path: 'fire.json', json: effect('fire').json },
        { path: 'smoke.json', json: effect('smoke').json },
      ],
      files: new Map([[path, new Blob(['hello'], { type: 'image/png' })]]),
      textures: new Map([['2cf24dba5fb0a30e.png', 'data:image/png;base64,aGVsbG8=']]),
    })
    const folder = memoryFolder()
    const picker = vi.fn(async () => folder.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click } = mount({ listEffects: async () => [effect('existing')] })
    await editor.ready
    root.querySelector('[data-effects-input]').listeners.get('change')?.({
      target: { files: [{ name: 'project.zip' }] },
    })
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('03'))
    expect(read).toHaveBeenCalledOnce()
    expect(picker).not.toHaveBeenCalled()
    expect(editor.hasUnsavedChanges()).toBe(true)
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect([...folder.files.keys()].sort()).toEqual([
      path,
      'existing.json',
      'fire.json',
      'smoke.json',
    ])
    expect(await folder.files.get(path)!.text()).toBe('hello')
  })

  it('keeps the current project intact when ZIP decoding or asset copying fails', async () => {
    const folder = memoryFolder()
    folder.files.set('existing.json', new Blob([JSON.stringify(effect('existing').json)]))
    Object.assign(browser, { showDirectoryPicker: vi.fn(async () => folder.directory) })
    const { editor, root, click } = mount()
    await editor.ready
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Opened project'),
    )
    click('duplicate-system')
    const read = vi
      .spyOn(projectZip, 'readProjectZip')
      .mockRejectedValueOnce(new Error('Broken ZIP'))
    const choose = () =>
      root.querySelector('[data-effects-input]').listeners.get('change')?.({
        target: { files: [{ name: 'project.zip' }] },
      })
    choose()
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Broken ZIP'))
    read.mockResolvedValue({
      effects: [{ path: 'new.json', json: effect('new').json }],
      files: new Map([
        ['assets/textures/2cf24dba5fb0a30e.png', new Blob(['hello'], { type: 'image/png' })],
      ]),
      textures: new Map([['2cf24dba5fb0a30e.png', 'data:image/png;base64,aGVsbG8=']]),
    })
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    choose()
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Disk full'))
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect(folder.files.size).toBe(1)
    choose()
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('02'))
    expect(folder.files.has('assets/textures/2cf24dba5fb0a30e.png')).toBe(true)
    expect(folder.files.has('new.json')).toBe(false)
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(folder.files.has('new.json')).toBe(true)
    expect(
      JSON.parse(await folder.files.get('existing.json')!.text()).object.children,
    ).toHaveLength(2)
  })

  it('skips runtime-invalid ZIP effects while importing the valid ones', async () => {
    vi.spyOn(projectZip, 'readProjectZip').mockResolvedValue({
      effects: [
        { path: 'valid.json', json: effect('valid').json },
        {
          path: 'invalid.json',
          json: {
            metadata: { type: 'Object', version: 4.7 },
            object: { type: 'Group', children: [{ type: 'ParticleEmitter' }] },
          },
        },
      ],
      files: new Map(),
      textures: new Map(),
    })
    const { editor, root } = mount()
    await editor.ready
    root.querySelector('[data-effects-input]').listeners.get('change')?.({
      target: { files: [{ name: 'project.zip' }] },
    })
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('01'))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('valid')
    expect(root.querySelector('[data-unity-report-text]').textContent).toContain(
      'invalid.json\nSkipped:',
    )
  })
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

function shortcut(root: ElementStub, key: string, shiftKey = false) {
  root.listeners.get('keydown')?.({ key, ctrlKey: true, shiftKey, preventDefault() {} })
}

function dropFiles(root: ElementStub, files: { name: string; [key: string]: unknown }[]) {
  root.listeners.get('drop')?.({ preventDefault() {}, dataTransfer: { files } })
}

describe('project-independent particle editor', () => {
  it('shows only Open project and Save project in the top toolbar', async () => {
    const { editor, root } = mount()
    await editor.ready
    const header = root.innerHTML.split('<header')[1]!.split('</header>')[0]!
    expect(header.match(/<button /g)).toHaveLength(2)
    expect(header).toContain('>Open project</button>')
    expect(header).toContain('>Save project</button>')
    expect(header).not.toMatch(/Undo|Redo|Import|Export/)
  })

  it('uses a reference grid that cannot occlude particles, without a solid preview floor', async () => {
    const added = vi.spyOn(Scene.prototype, 'add')
    const { editor, click } = mount({ listEffects: async () => [] })
    await editor.ready
    const objects = added.mock.calls.flat()
    const grid = objects.find((object) => object instanceof GridHelper) as GridHelper
    expect(grid).toBeDefined()
    expect(grid.material.depthWrite).toBe(false)
    expect(objects.some((object) => object instanceof Mesh)).toBe(false)
    click('grid')
    expect(grid.visible).toBe(false)
    click('grid')
    expect(grid.visible).toBe(true)
  })

  it('toggles hierarchy systems in preview, supports undo, and omits unchecked systems on save', async () => {
    const source = effect()
    const group = new QuarksLoader().parse(source.json)
    const hidden = new ParticleSystem({ material: new MeshBasicMaterial(), autoDestroy: false })
    hidden.emitter.name = 'CentralOrb'
    const nested = new Group()
    nested.add(hidden.emitter)
    group.add(nested)
    source.json = parseQuarksDocument(group.toJSON())
    const added = vi.spyOn(BatchedRenderer.prototype, 'addSystem')
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [source], saveEffect })
    await editor.ready
    const toggle = (checked: boolean) =>
      root.listeners.get('change')?.({
        target: { dataset: { systemEnabled: '1' }, checked },
      })
    expect(root.querySelector('[data-system-list]').innerHTML).toContain(
      'aria-label="Enable CentralOrb"',
    )
    toggle(false)
    expect(added.mock.calls.at(-1)![0].emitter.visible).toBe(false)
    expect(editor.hasUnsavedChanges()).toBe(true)
    shortcut(root, 'z')
    expect(added.mock.calls.at(-1)![0].emitter.visible).toBe(true)
    shortcut(root, 'z', true)
    expect(added.mock.calls.at(-1)![0].emitter.visible).toBe(false)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const saved = new QuarksLoader().parse(saveEffect.mock.calls[0]![1])
    expect(saved.getObjectByName('CentralOrb')).toBeUndefined()
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    toggle(true)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(2))
    expect(
      new QuarksLoader().parse(saveEffect.mock.calls[1]![1]).getObjectByName('CentralOrb'),
    ).toBeDefined()
  })

  it('preserves unchecked systems in a saved project so they can be restored on reopen', async () => {
    const folder = memoryFolder()
    Object.assign(browser, { showDirectoryPicker: vi.fn(async () => folder.directory) })
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('duplicate-system')
    root.listeners.get('change')?.({ target: { dataset: { systemEnabled: '1' }, checked: false } })
    for (let index = 0; index < 2; index++) {
      click('save')
      await vi.waitFor(() => expect(folder.write).toHaveBeenCalledTimes(index + 1))
      const json = JSON.parse(await folder.files.get('project-effect.json')!.text())
      expect(json.object.children).toHaveLength(2)
      expect(json.object.children[1].visible).toBe(false)
      expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    }
    root.listeners.get('change')?.({ target: { dataset: { systemEnabled: '0' }, checked: false } })
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Opened project'),
    )
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    const reopened = new QuarksLoader().parse(
      JSON.parse(await folder.files.get('project-effect.json')!.text()),
    )
    expect(reopened.children.every((child) => child.visible === false)).toBe(true)
  })

  it('omits assets used only by unchecked systems while retaining enabled native textures', async () => {
    const group = new Group()
    for (let index = 0; index < 2; index++) {
      const map = new DataTexture(new Uint8Array([index, 128, 0, 255]), 1, 1)
      group.add(new ParticleSystem({ material: new MeshBasicMaterial({ map }) }).emitter)
    }
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({
      listEffects: async () => [{ id: 'assets', json: parseQuarksDocument(group.toJSON()) }],
      saveEffect,
    })
    await editor.ready
    root.listeners.get('change')?.({ target: { dataset: { systemEnabled: '1' }, checked: false } })
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledOnce())
    const json = saveEffect.mock.calls[0]![1]
    expect(json.images).toHaveLength(1)
    expect(json.textures).toHaveLength(1)
    expect(json.materials).toHaveLength(1)
    expect(new QuarksLoader().parse(json).children).toHaveLength(1)
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
  })

  it('keeps the host save contract when every system is unchecked without losing editor data', async () => {
    const saveEffect = vi.fn(async () => {})
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    root.listeners.get('change')?.({ target: { dataset: { systemEnabled: '0' }, checked: false } })
    click('save')
    expect(root.querySelector('.toast').textContent).toBe(
      'Enable at least one Particle System before exporting.',
    )
    expect(createUrl).not.toHaveBeenCalled()
    expect(saveEffect).not.toHaveBeenCalled()
    expect(root.querySelector('[data-system-count]').textContent).toBe('01')
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('keeps curve edits in a draft, applies one undoable edit, and shares the lifetime editor', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    click('enable-curve')
    const inspector = root.querySelector('[data-inspector]')
    expect(inspector.innerHTML).toContain('data-native-action="edit-curve"')
    expect(inspector.innerHTML).not.toContain('data-curve-index')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const original = structuredClone(saveEffect.mock.calls[0]![1])
    const nativeClick = (nativeAction: string) =>
      root.listeners.get('click')?.({
        target: {
          closest: () => ({
            tagName: 'BUTTON',
            dataset: { nativeAction, nativePath: '["ps","behaviors",0,"size"]' },
          }),
        },
      })
    const preset = (i: number) =>
      inspector.querySelector('.color-editor-dialog').listeners.get('click')?.({
        target: { closest: () => ({ dataset: { curvePreset: String(i) } }) },
      })
    nativeClick('edit-curve')
    expect(inspector.innerHTML).toContain('Particle System Curves')
    preset(3)
    expect(editor.hasUnsavedChanges()).toBe(false)
    nativeClick('curve-editor-cancel')
    expect(editor.hasUnsavedChanges()).toBe(false)
    nativeClick('edit-curve')
    preset(5)
    nativeClick('curve-editor-apply')
    expect(editor.hasUnsavedChanges()).toBe(true)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(2))
    expect(JSON.stringify(saveEffect.mock.calls[1]![1])).toContain('"p0":0,"p1":0,"p2":1,"p3":1')
    shortcut(root, 'z')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(3))
    expect(saveEffect.mock.calls[2]![1]).toEqual(original)
    shortcut(root, 'z', true)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(4))
    expect(saveEffect.mock.calls[3]![1]).toEqual(saveEffect.mock.calls[1]![1])
  })

  it('keeps custom color edits as a draft until Apply and supports undo', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    const nativeClick = (nativeAction: string, nativePath = '[]') =>
      root.listeners.get('click')?.({
        target: { closest: () => ({ tagName: 'BUTTON', dataset: { nativeAction, nativePath } }) },
      })
    const edit = (hex: string) => {
      const dialog = root.querySelector('[data-inspector]').querySelector('.color-editor-dialog')
      dialog.querySelector('.color-editor-body').listeners.get('input')?.({
        target: { dataset: { pickerHex: '' }, value: hex, setAttribute() {} },
      })
    }
    nativeClick('edit-color', '["ps","startColor","color"]')
    edit('FF000080')
    expect(editor.hasUnsavedChanges()).toBe(false)
    nativeClick('color-editor-cancel')
    expect(editor.hasUnsavedChanges()).toBe(false)
    nativeClick('edit-color', '["ps","startColor","color"]')
    edit('00FF0080')
    nativeClick('color-editor-apply')
    expect(editor.hasUnsavedChanges()).toBe(true)
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(saveEffect.mock.calls[0]![1])).toContain(
      '"g":1,"b":0,"a":0.5019607843137255',
    )
    shortcut(root, 'z')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(2))
    expect(JSON.stringify(saveEffect.mock.calls[1]![1])).not.toContain('0.5019607843137255')
  })

  it('keeps added and moved gradient keys valid for native JSON', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    root.listeners.get('change')?.({
      target: {
        dataset: { nativeAction: 'generator', nativePath: '["ps","startColor"]' },
        value: 'Gradient',
      },
    })
    const nativeClick = (nativeAction: string) =>
      root.listeners.get('click')?.({
        target: {
          closest: () => ({
            tagName: 'BUTTON',
            dataset: { nativeAction, nativePath: '["ps","startColor"]' },
          }),
        },
      })
    nativeClick('edit-gradient')
    const body = root
      .querySelector('[data-inspector]')
      .querySelector('.color-editor-dialog')
      .querySelector('.color-editor-body')
    const add = () =>
      body.listeners.get('click')?.({
        target: { closest: () => ({ dataset: { pickerAction: 'add-color' } }) },
      })
    const move = (pos: number) =>
      body.listeners.get('input')?.({
        target: { dataset: { keyPosition: '' }, value: String(pos), valueAsNumber: pos },
      })
    add()
    move(0)
    add()
    add()
    move(100)
    nativeClick('color-editor-apply')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const saved = saveEffect.mock.calls[0]![1].object.children![0] as {
      ps: { startColor: { color: { keys: { pos: number }[] } } }
    }
    const stops = saved.ps.startColor.color.keys
    expect(stops).toHaveLength(5)
    for (let i = 1; i < stops.length; i++) expect(stops[i]!.pos).toBeGreaterThan(stops[i - 1]!.pos)
    expect(root.querySelector('.toast').textContent).not.toContain('strictly increasing')
  })

  it('uses the custom picker for material colors without changing their numeric format', async () => {
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    const nativeClick = (nativeAction: string) =>
      root.listeners.get('click')?.({
        target: {
          closest: () => ({
            tagName: 'BUTTON',
            dataset: { nativeAction, nativePath: '["document","materials",0,"color"]' },
          }),
        },
      })
    nativeClick('edit-color')
    const body = root
      .querySelector('[data-inspector]')
      .querySelector('.color-editor-dialog')
      .querySelector('.color-editor-body')
    expect(body.innerHTML).not.toContain('data-picker-channel="a"')
    body.listeners.get('input')?.({
      target: { dataset: { pickerHex: '' }, value: '12345680', setAttribute() {} },
    })
    nativeClick('color-editor-apply')
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    expect(saveEffect.mock.calls[0]![1].materials).toEqual(
      expect.arrayContaining([expect.objectContaining({ color: 0x123456 })]),
    )
  })

  it('uses the same gradient editor for Color over Lifetime', async () => {
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('enable-color')
    const markup = root.querySelector('[data-inspector]').innerHTML
    expect(markup).toContain(
      'data-native-path="[&quot;ps&quot;,&quot;behaviors&quot;,0,&quot;color&quot;]"',
    )
    expect(markup).toContain('data-native-action="edit-gradient"')
    expect(markup).not.toContain('type="color"')
  })

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
    const folder = memoryFolder()
    Object.assign(browser, { showDirectoryPicker: vi.fn(async () => folder.directory) })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'Content-Type': 'image/png' } })),
    )
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
      target: { files: [new File(['hello'], 'smoke.png', { type: 'image/png' })] },
    })
    await vi.waitFor(() => expect(load.mock.calls.at(-1)![0].images![0]!.url).toBe(embedded))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('value="7"')
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(saveEffect).not.toHaveBeenCalled()
    const saved = JSON.parse(await folder.files.get('first.json')!.text())
    expect(saved.images[0].url).toMatch(/^assets\/textures\/[a-f0-9]{16}\.png$/)
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
    shortcut(root, 'z')
    expect(root.querySelector('[data-inspector]').innerHTML).not.toContain(
      'value="Vector3Function" selected',
    )
    change({ nativePath: '["ps","duration"]', nativeKind: 'number' }, '-1')
    expect(root.querySelector('.toast').textContent).toContain('must be positive')
  })

  it('accepts emitter rotation in degrees and saves radians', async () => {
    class InputStub extends ElementStub {
      dataset = { bind: 'emitter.rotation.x' }
      type = 'number'
      value = '90'
    }
    vi.stubGlobal('HTMLInputElement', InputStub)
    vi.stubGlobal('HTMLSelectElement', class {})
    const saveEffect = vi.fn(async (_id: string, _json: QuarksDocument) => {})
    const { editor, root, click } = mount({ listEffects: async () => [effect()], saveEffect })
    await editor.ready
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Emitter Rotation (deg)')
    root.listeners.get('input')?.({ target: new InputStub() })
    click('save')
    await vi.waitFor(() => expect(saveEffect).toHaveBeenCalledTimes(1))
    const emitter = saveEffect.mock.calls[0]![1].object.children![0] as { matrix: number[] }
    expect(emitter.matrix[6]).toBeCloseTo(1)
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
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Open a project folder')
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
    dropFiles(root, [{ name: 'imported.json', text: async () => JSON.stringify(effect().json) }])
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
    dropFiles(root, [{ name: 'huge.json', size: 64 * 1024 * 1024 + 1, text }])
    await vi.advanceTimersByTimeAsync(0)
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
    dropFiles(root, [{ name: 'broken.json', text: async () => JSON.stringify(json) }])
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).not.toBe(''))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('project-effect')
    expect(editor.hasUnsavedChanges()).toBe(false)
  })

  it('saves all effects to a selected folder and retains edits when switching effects', async () => {
    const folder = memoryFolder()
    const picker = vi.fn(async () => folder.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click, select } = mount({
      listEffects: async () => [effect('first'), effect('second')],
    })
    await editor.ready
    click('duplicate-system')
    select('second')
    click('duplicate-system')
    select('first')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect((browser as unknown as Window).confirm).not.toHaveBeenCalled()
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(folder.files.has('first.json')).toBe(true)
    expect(folder.files.has('second.json')).toBe(true)
    expect(JSON.parse(await folder.files.get('second.json')!.text()).object.children).toHaveLength(
      2,
    )
    expect(root.querySelector('.toast').textContent).toContain('Saved project')
    click('duplicate-system')
    select('second')
    select('first')
    expect(root.querySelector('[data-system-count]').textContent).toBe('03')
  })

  it('keeps edits on picker cancellation, declined overwrite, unsupported browser, or write failure', async () => {
    const folder = memoryFolder()
    const picker = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'))
      .mockResolvedValue(folder.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('duplicate-system')
    click('save')
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.hasUnsavedChanges()).toBe(true)
    folder.files.set('project-effect.json', new Blob(['old']))
    vi.mocked((browser as unknown as Window).confirm).mockReturnValue(false)
    click('save')
    await vi.waitFor(() => expect((browser as unknown as Window).confirm).toHaveBeenCalled())
    expect(folder.write).not.toHaveBeenCalled()
    expect(editor.hasUnsavedChanges()).toBe(true)
    await Promise.resolve()
    vi.mocked((browser as unknown as Window).confirm).mockReturnValue(true)
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    click('save')
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Disk full'))
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect(await folder.files.get('project-effect.json')!.text()).toBe('old')
    Object.assign(browser, { showDirectoryPicker: undefined })
    click('save')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Chrome or Edge'),
    )
    expect(editor.hasUnsavedChanges()).toBe(true)
  })

  it('opens every root JSON in a project, remembers filenames, and saves without another picker', async () => {
    const folder = memoryFolder()
    folder.files.set('Reopened effect.json', new Blob([JSON.stringify(effect('reopened').json)]))
    folder.files.set('second.json', new Blob([JSON.stringify(effect('second').json)]))
    const picker = vi.fn(async () => folder.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click, select } = mount()
    await editor.ready
    shortcut(root, 'o')
    await vi.waitFor(() => expect(root.querySelector('[data-effect-count]').textContent).toBe('02'))
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('reopened')
    expect(editor.hasUnsavedChanges()).toBe(false)
    click('duplicate-system')
    select('second')
    click('duplicate-system')
    select('reopened-effect')
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(editor.hasUnsavedChanges()).toBe(true)
    shortcut(root, 's')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(picker).toHaveBeenCalledOnce()
    expect(
      JSON.parse(await folder.files.get('Reopened effect.json')!.text()).object.children,
    ).toHaveLength(2)
    expect(JSON.parse(await folder.files.get('second.json')!.text()).object.children).toHaveLength(
      2,
    )
    expect(folder.files.size).toBe(2)
  })

  it('copies browsed files immediately, deduplicates bytes, and reopens unused textures', async () => {
    const folder = memoryFolder()
    const picker = vi.fn(async () => folder.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    vi.spyOn(localFiles, 'readTextureFile').mockResolvedValue('data:image/png;base64,aGVsbG8=')
    const { editor, root, click } = mount()
    await editor.ready
    click('import-texture')
    const input = root.querySelector('[data-texture-input]')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Click Browse again'),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(input.click).not.toHaveBeenCalled()
    click('import-texture')
    await vi.waitFor(() => expect(input.click).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)
    input.listeners.get('change')?.({
      target: {
        files: [
          new File(['hello'], 'smoke.png', { type: 'image/png' }),
          new File(['hello'], 'same-texture.png', { type: 'image/png' }),
          new File(['different'], 'spark.png', { type: 'image/png' }),
        ],
      },
    })
    await vi.waitFor(() =>
      expect(root.querySelector('[data-texture-list]').innerHTML).toContain('spark.png'),
    )
    expect(folder.files.size).toBe(2)
    expect(
      [...folder.files.keys()].every((path) => /^assets\/textures\/[a-f0-9]{16}\.png$/.test(path)),
    ).toBe(true)
    expect(folder.write).toHaveBeenCalledTimes(2)
    expect(picker).toHaveBeenCalledOnce()
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Opened project'),
    )
    const markup = root.querySelector('[data-texture-list]').innerHTML
    for (const path of folder.files.keys()) expect(markup).toContain(path.split('/').at(-1))
  })

  it('does not add a texture to the library if copying to the project fails', async () => {
    const folder = memoryFolder()
    Object.assign(browser, { showDirectoryPicker: vi.fn(async () => folder.directory) })
    vi.spyOn(localFiles, 'readTextureFile').mockResolvedValue('data:image/png;base64,aGVsbG8=')
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    const { editor, root } = mount()
    await editor.ready
    root.querySelector('[data-texture-input]').listeners.get('change')?.({
      target: { files: [new File(['hello'], 'smoke.png', { type: 'image/png' })] },
    })
    await vi.waitFor(() => expect(root.querySelector('.toast').textContent).toBe('Disk full'))
    expect(root.querySelector('[data-texture-list]').innerHTML).not.toContain(
      'data-texture="smoke.png"',
    )
    expect(folder.files.size).toBe(0)
    expect(folder.abort).toHaveBeenCalledOnce()
  })

  it('keeps the current project and edits when opening is declined, cancelled, or invalid', async () => {
    const current = memoryFolder()
    current.files.set('first.json', new Blob([JSON.stringify(effect('first').json)]))
    const invalid = memoryFolder()
    invalid.files.set('valid.json', new Blob([JSON.stringify(effect('other').json)]))
    invalid.files.set('broken.json', new Blob(['not json']))
    const picker = vi
      .fn()
      .mockResolvedValueOnce(current.directory)
      .mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'))
      .mockResolvedValueOnce(invalid.directory)
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click } = mount()
    await editor.ready
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Opened project'),
    )
    click('duplicate-system')
    vi.mocked((browser as unknown as Window).confirm).mockReturnValue(false)
    click('open-project')
    expect(picker).toHaveBeenCalledOnce()
    vi.mocked((browser as unknown as Window).confirm).mockReturnValue(true)
    click('open-project')
    await vi.advanceTimersByTimeAsync(0)
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).not.toContain('Opened project'),
    )
    expect(root.querySelector('[data-system-count]').textContent).toBe('02')
    expect(root.querySelector('[data-effect-count]').textContent).toBe('01')
    expect(editor.hasUnsavedChanges()).toBe(true)
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(JSON.parse(await current.files.get('first.json')!.text()).object.children).toHaveLength(
      2,
    )
    expect(await invalid.files.get('broken.json')!.text()).toBe('not json')
    expect(picker).toHaveBeenCalledTimes(3)
  })

  it('saves project deletions without removing unrelated files or unused textures', async () => {
    const folder = memoryFolder()
    folder.files.set('first.json', new Blob([JSON.stringify(effect('first').json)]))
    folder.files.set('second.json', new Blob([JSON.stringify(effect('second').json)]))
    folder.files.set('notes.txt', new Blob(['keep']))
    folder.files.set('assets/textures/old.png', new Blob(['image'], { type: 'image/png' }))
    vi.spyOn(localFiles, 'readTextureFile').mockResolvedValue('data:image/png;base64,aGVsbG8=')
    Object.assign(browser, { showDirectoryPicker: vi.fn(async () => folder.directory) })
    const { editor, root, click } = mount()
    await editor.ready
    click('open-project')
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Opened project'),
    )
    click('delete-effect')
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.hasUnsavedChanges()).toBe(true)
    expect(folder.files.has('first.json')).toBe(true)
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect([...folder.files.keys()].sort()).toEqual([
      'assets/textures/old.png',
      'notes.txt',
      'second.json',
    ])
    click('delete-effect')
    await vi.advanceTimersByTimeAsync(0)
    click('save')
    await vi.waitFor(() => expect(editor.hasUnsavedChanges()).toBe(false))
    expect(folder.files.has('second.json')).toBe(false)
  })

  it('keeps edits made while a folder save is pending and prevents concurrent exports', async () => {
    const folder = memoryFolder()
    let choose!: (directory: FileSystemDirectoryHandle) => void
    const picker = vi.fn(
      () =>
        new Promise<FileSystemDirectoryHandle>((resolve) => {
          choose = resolve
        }),
    )
    Object.assign(browser, { showDirectoryPicker: picker })
    const { editor, root, click } = mount({ listEffects: async () => [effect()] })
    await editor.ready
    click('duplicate-system')
    click('save')
    click('duplicate-system')
    click('save')
    expect(picker).toHaveBeenCalledOnce()
    choose(folder.directory)
    await vi.waitFor(() =>
      expect(root.querySelector('.toast').textContent).toContain('Saved project'),
    )
    expect(
      JSON.parse(await folder.files.get('project-effect.json')!.text()).object.children,
    ).toHaveLength(2)
    expect(root.querySelector('[data-system-count]').textContent).toBe('03')
    expect(editor.hasUnsavedChanges()).toBe(true)
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
    expect(root.querySelector('[data-inspector]').innerHTML).toContain('Open a project folder')
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
