import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import {
  ApplyForce,
  BatchedRenderer,
  CircleEmitter,
  ColorOverLife,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  FrameOverLife,
  Gradient,
  GridEmitter,
  HemisphereEmitter,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  QuarksLoader,
  QuarksUtil,
  RectangleEmitter,
  RenderMode,
  SizeOverLife,
  SphereEmitter,
  Vector3 as QVector3,
  Vector4 as QVector4,
  Bezier,
  BehaviorTypes,
  MeshSurfaceEmitter,
} from 'three.quarks'
import { parseQuarksDocument, textureUrlSchema, type QuarksDocument } from './document.js'
import { intervalBounds, particlePreviewDuration, updateParticlePreview } from './preview.js'
import style from './style.css?inline'
import { bindColorEditor, colorEditorMarkup } from './color-editor.js'
import { bindCurveEditor, curveEditorMarkup } from './curve-editor.js'
import { readTextureFile, resolveFolderAssets, resolveLocalTextures } from './local-files.js'
import {
  addFolderAsset,
  existingFile,
  prepareFolderExport,
  textureAssetPath,
  writeFolderAssets,
  writeFolderExport,
} from './folder-export.js'
import { readUnityPackage } from './unity-package.js'
import { readProjectZip } from './project-zip.js'
import {
  appendNativeItem,
  behaviorSlots,
  generatorTemplates,
  getNativeValue,
  nativeNode,
  newBehavior,
  newShape,
  prepareNativeDocument,
  preserveNativeAssets,
  propertyLabel,
  renderProperties,
  renderProperty,
  setNativeValue,
  validateNative,
  writeBehaviorSlots,
} from './native-properties.js'
import type { NativePath, NativeRecord, PropertyContext } from './native-properties.js'

export { parseQuarksDocument, quarksDocumentSchema } from './document.js'
export type { QuarksDocument } from './document.js'
export { intervalBounds, updateParticlePreview } from './preview.js'
export { readUnityPackage } from './unity-package.js'
export { loadProjectEffect } from './project-loader.js'
export { resolveMeshAssets } from './mesh-assets.js'
export type { UnityPackage, UnityPrefabImport } from './unity-package.js'

export interface ParticleEffect {
  id: string
  json: QuarksDocument
  /** Optional project-owned default: protects deletion and enables reset. */
  defaultJson?: QuarksDocument
}

export interface ParticleTexture {
  id: string
  /** Preview/project URL; folder export copies the image to a relative asset file. */
  url: string
}

export interface ParticleEditorOptions {
  listEffects?: () => Promise<ParticleEffect[]>
  listTextures?: () => Promise<ParticleTexture[]>
  saveEffect?: (id: string, json: QuarksDocument) => Promise<void>
  /** For effects with defaultJson, delete removes the override, not the default. */
  deleteEffect?: (id: string) => Promise<void>
}

export interface ParticleEditor {
  ready: Promise<void>
  hasUnsavedChanges(): boolean
  destroy(): void
}

export function createParticleEditor(
  container: HTMLElement,
  options: ParticleEditorOptions = {},
): ParticleEditor {
  const host = document.createElement('div')
  container.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const sheet = document.createElement('style')
  sheet.textContent = style
  const root = document.createElement('div')
  root.className = 'editor-root'
  root.tabIndex = 0
  root.inert = true
  shadow.append(sheet, root)
  let destroyed = false
  const events = new AbortController()

  root.innerHTML = `
  <div class="studio">
    <header class="topbar">
      <div class="brand"><div class="brand-title">Quarks Particle Editor</div></div>
      <div class="top-actions"><button class="btn" type="button" data-action="open-project" title="Open a project folder (Ctrl+O)">Open project</button><span class="save-state" data-save-state>No unsaved changes</span><button class="btn primary" type="button" data-action="save" title="Save project (Ctrl+S)">Save project</button></div>
    </header>
    <main class="workspace">
      <aside class="left-panel">
        <div class="panel-tab">Hierarchy</div>
        <section class="panel-block">
          <div class="section-title"><span>Hierarchy</span><span class="count" data-system-count>00</span></div>
          <div data-system-list></div>
          <div class="system-actions"><button class="btn small" type="button" data-action="add-system">+ Add</button><button class="btn small" type="button" data-action="duplicate-system" title="Duplicate selected system">Copy</button><button class="btn small" type="button" data-action="move-system-up" title="Move system up">Up</button><button class="btn small" type="button" data-action="move-system-down" title="Move system down">Down</button><button class="btn small danger" type="button" data-action="remove-system" title="Remove selected system">-</button></div>
        </section>
        <section class="panel-block"><div class="hint">Open a project folder or create a particle system to begin.<br><br>Space: Play / Pause<br>R: Restart &nbsp; F: Frame selected<br>Ctrl+O: Open &nbsp; Ctrl+S: Save<br>Ctrl+Z: Undo &nbsp; Ctrl+Shift+Z: Redo<br>Drag: Orbit &nbsp; Scroll: Zoom</div></section>
      </aside>
      <section class="stage">
        <div class="panel-tab">Scene <span class="hint">Perspective \u{b7} Quarks runtime</span></div>
        <div class="viewport">
          <canvas id="vfx-canvas" aria-label="Particle effect preview"></canvas>
          <div class="viewport-label"><strong>Particle Effect</strong><span>Drop a project ZIP, UnityPackage, JSON, or textures here</span></div>
          <div class="viewport-actions"><button class="btn" type="button" data-action="frame">Frame</button><button class="btn" type="button" data-action="grid">Grid</button></div>
        </div>
        <div class="timeline">
          <div class="transport"><button class="btn" type="button" data-action="restart" title="Restart (R)">Restart</button><button class="btn primary" type="button" data-action="play" title="Play / pause (Space)" data-play>Play</button><button class="btn" type="button" data-action="step" title="Step frame">Step</button><div class="time-readout"><span data-time>0.00</span> <span>/</span> <span data-duration>0.00 s</span></div></div>
          <div class="timeline-track"><div class="timeline-progress" data-progress></div><div class="timeline-knob" data-knob></div><div class="timeline-ticks"><span>0s</span><span>25%</span><span>50%</span><span>75%</span><span data-end-tick>1s</span></div><input class="timeline-input" type="range" min="0" max="1000" value="0" aria-label="Preview timeline" data-timeline></div>
        </div>
        <section class="project-panel" aria-label="Project assets">
          <div class="panel-tab">Project <span class="hint" data-project-folder>No project folder selected</span></div>
          <div class="project-toolbar"><input class="search" type="search" placeholder="Search effects" aria-label="Search effects" data-search><button class="btn small" type="button" data-action="new">+ New effect</button><button class="btn small" type="button" data-action="duplicate" title="Duplicate selected effect">Duplicate</button></div>
          <div class="project-columns"><section><div class="section-title"><span>Effects <span data-effect-count>00</span></span><button class="btn small" type="button" data-action="import-effects">Import</button></div><div class="effect-list" data-effect-list></div><details class="unity-import-report" data-unity-report hidden><summary>Import report</summary><pre data-unity-report-text></pre></details></section><section><div class="section-title"><span>Textures</span><button class="btn small" type="button" data-action="import-texture">+ Browse</button></div><div class="texture-list" data-texture-list></div></section></div>
        </section>
      </section>
      <aside class="right-panel" data-inspector></aside>
    </main>
  </div>
  <input type="file" accept=".zip,.unitypackage" hidden data-effects-input>
  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" multiple hidden data-texture-input>
  <input type="file" accept="application/json,.json" hidden data-geometry-input>
  <div class="toast" role="status" aria-live="polite" hidden></div>
`

  // Keep loading status outside the inert editor so assistive technology can announce it.
  const loading = document.createElement('div')
  loading.className = 'loading-overlay'
  loading.hidden = true
  loading.setAttribute('role', 'status')
  loading.setAttribute('aria-live', 'polite')
  loading.innerHTML =
    '<div class="loading-card"><p data-loading-label></p><progress aria-label="Operation progress"></progress></div>'
  shadow.append(loading)
  let lastLoadingYield = 0

  function setLoading(message: string, completed?: number, total?: number): boolean {
    const first = loading.hidden === true
    loading.hidden = false
    root.setAttribute('aria-busy', 'true')
    loading.querySelector('[data-loading-label]')!.textContent =
      total === undefined ? message : `${message} (${completed}/${total})`
    const progress = loading.querySelector('progress')!
    if (total === undefined || !total) progress.removeAttribute('value')
    else {
      progress.max = total
      progress.value = completed ?? 0
    }
    return first
  }

  async function showLoading(message: string, completed?: number, total?: number): Promise<void> {
    if (destroyed) throw new DOMException('Editor closed', 'AbortError')
    const first = setLoading(message, completed, total)
    if (first || performance.now() - lastLoadingYield >= 32) {
      // A task boundary lets the browser paint; awaiting an already-resolved promise does not.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      lastLoadingYield = performance.now()
    }
    if (destroyed) throw new DOMException('Editor closed', 'AbortError')
  }

  function hideLoading(): void {
    loading.hidden = true
    root.removeAttribute('aria-busy')
  }

  type NativeNode = {
    type: string
    name?: string
    children?: NativeNode[]
    ps?: Record<string, unknown>
    [key: string]: unknown
  }
  type EffectFile = ParticleEffect
  interface EmitterObject extends THREE.Object3D {
    system: ParticleSystem
  }

  const $ = <T extends Element>(selector: string): T => {
    const element = root!.querySelector<T>(selector)
    if (!element) throw new Error(`missing ${selector}`)
    return element
  }
  const canvas = $<HTMLCanvasElement>('#vfx-canvas')
  const inspector = $<HTMLElement>('[data-inspector]')
  const toast = $<HTMLElement>('.toast')
  const effectList = $<HTMLElement>('[data-effect-list]')
  const systemList = $<HTMLElement>('[data-system-list]')
  const saveState = $<HTMLElement>('[data-save-state]')
  const textures = new Map<string, string>()
  const textureFiles = new Map<string, FileSystemFileHandle>()
  const texturePreviewLoads = new Map<FileSystemFileHandle, Promise<string>>()
  const visibleTexturePreviews = new Set<HTMLElement>()
  let loadingTexturePreviews = false
  const textureObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const button = entry.target as HTMLElement
      if (entry.isIntersecting) visibleTexturePreviews.add(button)
      else visibleTexturePreviews.delete(button)
    }
    void loadTexturePreviews()
  })
  const unloadedEffects = new Set<string>()
  const defaults = new Map<string, EffectFile>()
  const savedEffects = new Map<string, EffectFile>()
  let effects: EffectFile[] = []
  let projectDirectory: FileSystemDirectoryHandle | undefined
  const projectFiles = new Map<string, string>()
  const deletedProjectFiles = new Set<string>()
  const pendingAssets = new Map<string, Blob>()
  const savedIds = new Set<string>()
  let currentId = ''
  let systemIndex = 0
  let dirty = false
  let saving = false
  let editRevision = 0
  let playing = true
  let showGrid = true
  let elapsed = 0
  let previousFrame = 0
  let previewFailed = false
  let frameRequest = 0
  let toastTimer = 0
  let previewTimer = 0
  let previewDuration = 1
  let currentGroup: THREE.Object3D | undefined
  let previewSystems: ParticleSystem[] = []
  let renderer: THREE.WebGLRenderer
  let scene: THREE.Scene
  let camera: THREE.PerspectiveCamera
  let controls: OrbitControls
  let transformControls: TransformControls | undefined
  let batch: BatchedRenderer
  let grid: THREE.GridHelper
  let resize: ResizeObserver | undefined
  let depthTarget: THREE.WebGLRenderTarget
  let pendingSize: { width: number; height: number } | undefined
  const undoStack: EffectFile[] = []
  const redoStack: EffectFile[] = []
  const collapsedModules = new Set<string>()
  let propertyEditor:
    | {
        path: NativePath
        type: 'color' | 'gradient' | 'curve'
        value: NativeRecord
        material?: boolean
      }
    | undefined

  const currentEffect = (): EffectFile | undefined =>
    effects.find((effect) => effect.id === currentId)
  const esc = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  const num = (value: number, digits = 2): string =>
    Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '0'
  const asHex = (rgb: readonly number[]): string =>
    `#${rgb
      .slice(0, 3)
      .map((channel) =>
        Math.round(Math.max(0, Math.min(1, channel)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  const fromHex = (hex: string): [number, number, number] =>
    [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255) as [
      number,
      number,
      number,
    ]

  function emitterNodes(rootNode: NativeNode): NativeNode[] {
    const found: NativeNode[] = []
    const visit = (node: NativeNode) => {
      if (node.type === 'ParticleEmitter') found.push(node)
      for (const child of node.children ?? []) visit(child)
    }
    visit(rootNode)
    return found
  }

  function nativeRoot(json: QuarksDocument): NativeNode {
    return json.object as unknown as NativeNode
  }

  function displayName(effect: EffectFile): string {
    return String(nativeRoot(effect.json).name || effect.id)
  }

  function rootRotation(effect: EffectFile): THREE.Euler {
    const matrix = nativeRoot(effect.json).matrix
    const transform = Array.isArray(matrix)
      ? new THREE.Matrix4().fromArray(matrix as number[])
      : new THREE.Matrix4()
    return new THREE.Euler().setFromRotationMatrix(transform)
  }

  function emitters(group = currentGroup): EmitterObject[] {
    const result: EmitterObject[] = []
    group?.traverse((object) => {
      if (object.type === 'ParticleEmitter' && 'system' in object)
        result.push(object as EmitterObject)
    })
    return result
  }

  function currentEmitter(): EmitterObject | undefined {
    return emitters()[systemIndex]
  }

  function flash(message: string, error = false): void {
    toast.textContent = message
    toast.classList.toggle('error', error)
    toast.hidden = false
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 3000)
  }

  function markDirty(): void {
    editRevision += 1
    dirty = true
    saveState.textContent = 'Unsaved changes'
    saveState.classList.add('dirty')
  }

  function setSaved(): void {
    dirty = false
    saveState.textContent = 'All changes saved'
    saveState.classList.remove('dirty')
  }

  function syncEffect(): void {
    const effect = currentEffect()
    if (!effect || !currentGroup) return
    nativeRoot(effect.json).name = currentGroup.name || effect.id
    currentGroup.updateMatrixWorld(true)
    effect.json = serializeGroup(currentGroup)
  }

  function recordHistory(snapshot?: EffectFile): void {
    if (!snapshot) syncEffect()
    const effect = currentEffect()
    if (!effect) return
    undoStack.push(structuredClone(snapshot ?? effect))
    if (undoStack.length > 100) undoStack.shift()
    redoStack.length = 0
  }

  function travelHistory(from: EffectFile[], to: EffectFile[]): void {
    syncEffect()
    const effect = currentEffect()
    const snapshot = from.pop()
    if (!effect || !snapshot) return
    to.push(structuredClone(effect))
    releasePreview()
    effects = effects.map((item) => (item.id === currentId ? snapshot : item))
    systemIndex = Math.min(systemIndex, emitterNodes(nativeRoot(snapshot.json)).length - 1)
    markDirty()
    renderEffects()
    renderSystems()
    resetPreview()
    renderInspector()
  }

  function isBuiltIn(id: string): boolean {
    return defaults.has(id)
  }

  function effectMarkup(effect: EffectFile): string {
    return `<span class="effect-icon">\u{2733}</span><span><span class="effect-name">${esc(displayName(effect))}</span><span class="effect-meta">${esc(effect.id)} \u{b7} ${emitterNodes(nativeRoot(effect.json)).length} systems</span></span>${savedIds.has(effect.id) ? '<span class="saved-dot" title="Saved to project"></span>' : ''}`
  }

  function renderEffects(currentOnly = false): void {
    const query = $<HTMLInputElement>('[data-search]').value.trim().toLowerCase()
    const current = currentEffect()
    const button =
      currentOnly && !query && current
        ? effectList.querySelector<HTMLElement>(`[data-effect="${CSS.escape(current.id)}"]`)
        : null
    if (button && current) {
      button.innerHTML = effectMarkup(current)
      return
    }
    const visible = effects.filter((effect) =>
      `${displayName(effect)} ${effect.id}`.toLowerCase().includes(query),
    )
    $('[data-effect-count]').textContent = String(effects.length).padStart(2, '0')
    effectList.innerHTML = visible.length
      ? visible
          .map(
            (effect) => `
    <button class="effect-item${effect.id === currentId ? ' active' : ''}" type="button" data-effect="${esc(effect.id)}">${effectMarkup(effect)}</button>`,
          )
          .join('')
      : '<div class="empty-list">No matching effects</div>'
  }

  function renderSystems(): void {
    const effect = currentEffect()
    const nodes = effect ? emitterNodes(nativeRoot(effect.json)) : []
    $('[data-system-count]').textContent = String(nodes.length).padStart(2, '0')
    if (!effect) {
      systemList.innerHTML = '<div class="empty-list">Create or import an effect.</div>'
      return
    }
    systemList.innerHTML = `<div class="hierarchy-row"><span>\u{2304}</span><span class="tree-icon">\u{2733}</span><strong>${esc(displayName(effect))}</strong><span class="row-meta">GROUP</span></div>${nodes.map((node, index) => `<div class="hierarchy-row${index === systemIndex ? ' active' : ''}"><input type="checkbox" data-system-enabled="${index}" aria-label="Enable ${esc(node.name || `Particle System ${index + 1}`)}" title="Enable in preview; visibility is saved with the project"${node.visible !== false ? ' checked' : ''}><button class="system-select" type="button" data-system="${index}"><span class="tree-icon">\u{25a7}</span><span>${esc(node.name || `Particle System ${index + 1}`)}</span><span class="row-meta">${index + 1}</span></button></div>`).join('')}`
  }

  function colorOf(system: ParticleSystem): [number, number, number, number] {
    const color = (system.startColor as unknown as { color?: QVector4 }).color
    return color ? [color.x, color.y, color.z, color.w] : [1, 1, 1, 1]
  }

  function renderSizeCurve(system: ParticleSystem, context: PropertyContext): string {
    const index = system.behaviors.findIndex((item) => item.type === 'SizeOverLife')
    const behavior = system.behaviors[index] as SizeOverLife | undefined
    return behavior
      ? renderProperty(behavior.size.toJSON(), ['ps', 'behaviors', index, 'size'], context)
      : '<button class="btn small" type="button" data-action="enable-curve">+ Add SizeOverLife</button>'
  }

  function frameRange(system: ParticleSystem): [number, number] | undefined {
    const behavior = system.behaviors.find((item) => item.type === 'FrameOverLife') as
      FrameOverLife | undefined
    const data = behavior?.frame as unknown as
      { functions?: Array<[{ p: number[] }, number]> } | undefined
    const segment = data?.functions?.[0]
    const curve = segment?.[0]
    return curve ? [curve.p[0] ?? 0, data!.functions!.at(-1)?.[0].p[3] ?? 0] : undefined
  }

  function setFrameRange(system: ParticleSystem, start: number, end: number): void {
    const frame = new FrameOverLife(
      linearCurve([
        [0, start],
        [1, end],
      ]),
    )
    const current = system.behaviors.findIndex((item) => item.type === 'FrameOverLife')
    if (current >= 0) system.behaviors[current] = frame
    else system.behaviors.push(frame)
  }

  function gravityOf(system: ParticleSystem): number {
    const behavior = system.behaviors.find((item) => item.type === 'ApplyForce') as
      ApplyForce | undefined
    if (!behavior) return 0
    const strength = behavior.magnitude as unknown as { value?: number }
    return behavior.direction.y * (strength.value ?? 0)
  }

  function materialOf(system: ParticleSystem): { name: string; additive: boolean } {
    const material = system.material as THREE.MeshBasicMaterial
    const image = material.map?.image as { src?: string } | undefined
    const src = image?.src
    const name = [...textures].find(([, url]) => new URL(url, document.baseURI).href === src)?.[0]
    return {
      name: name ?? (textures.has(material.map?.name ?? '') ? material.map!.name : ''),
      additive: material.blending === THREE.AdditiveBlending,
    }
  }

  function propertyContext(json: QuarksDocument): PropertyContext {
    const resources = (key: string) =>
      ((json[key] ?? []) as NativeRecord[]).map((item) => ({
        uuid: String(item.uuid),
        name: String(item.name || item.type || item.uuid),
      }))
    return {
      emitters: emitterNodes(nativeRoot(json)).map((node) => ({
        uuid: String(node.uuid),
        name: node.name || 'Particle System',
      })),
      geometries: resources('geometries'),
      materials: resources('materials'),
      textures: resources('textures'),
    }
  }

  function renderMaterial(json: QuarksDocument, uuid: string, context: PropertyContext): string {
    const materials = (json.materials ?? []) as NativeRecord[]
    const index = materials.findIndex((item) => item.uuid === uuid)
    if (index < 0) return '<p class="hint">No material selected.</p>'
    const material = materials[index]!
    return renderProperties(
      material,
      Object.keys(material).filter((key) => !['uuid', 'type', 'metadata'].includes(key)),
      context,
      ['document', 'materials', index],
    )
  }

  function renderTextureProperties(
    json: QuarksDocument,
    materialId: string,
    context: PropertyContext,
  ): string {
    const material = ((json.materials ?? []) as NativeRecord[]).find(
      (item) => item.uuid === materialId,
    )
    const textures = (json.textures ?? []) as NativeRecord[]
    const indices = textures
      .map((texture, index) => (Object.values(material ?? {}).includes(texture.uuid) ? index : -1))
      .filter((index) => index >= 0)
    return (
      indices
        .map((index) =>
          renderProperties(
            textures[index]!,
            Object.keys(textures[index]!).filter(
              (key) => !['uuid', 'image', 'metadata'].includes(key),
            ),
            context,
            ['document', 'textures', index],
          ),
        )
        .join('') || '<p class="hint">Assign a texture in Renderer first.</p>'
    )
  }

  function commitNativeEdit(edit: (node: NativeRecord, json: QuarksDocument) => void): void {
    const effect = currentEffect()
    if (!effect || !currentGroup) return
    try {
      syncEffect()
      const next = structuredClone(effect.json)
      edit(nativeNode(next, systemIndex), next)
      prepareNativeDocument(next)
      validateSubEmitters(next)
      const probe = new QuarksLoader().parse(structuredClone(next))
      disposeObjects(probe)
      for (const emitter of emitters(probe)) emitter.system.dispose()
      recordHistory()
      releasePreview()
      effect.json = next
      markDirty()
      resetPreview()
      renderEffects(true)
      renderSystems()
      renderInspector()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Invalid Quarks property', true)
      renderInspector()
    }
  }

  function validateSubEmitters(json: QuarksDocument): void {
    const nodes = emitterNodes(nativeRoot(json))
    const visiting = new Set<string>(),
      visited = new Set<string>()
    const visit = (node: NativeNode) => {
      const uuid = String(node.uuid)
      if (visiting.has(uuid)) throw new Error('Sub emitter references cannot form a cycle.')
      if (visited.has(uuid)) return
      visiting.add(uuid)
      for (const behavior of (node.ps?.behaviors ?? []) as NativeRecord[]) {
        if (behavior.type !== 'EmitSubParticleSystem' || !behavior.subParticleSystem) continue
        const target = nodes.find((item) => item.uuid === behavior.subParticleSystem)
        if (!target) throw new Error('Sub emitter must reference an emitter in this effect.')
        visit(target)
      }
      visiting.delete(uuid)
      visited.add(uuid)
    }
    nodes.forEach(visit)
  }

  function nativeAction(target: HTMLElement): void {
    const action = target.dataset.nativeAction
    const path = JSON.parse(target.dataset.nativePath ?? '[]') as NativePath
    if (action === 'edit-color' || action === 'edit-gradient' || action === 'edit-curve') {
      const effect = currentEffect()
      if (!effect) return
      const value = getNativeValue(
        { ...nativeNode(effect.json, systemIndex), document: effect.json },
        path,
      )
      if (value === null || (typeof value !== 'object' && typeof value !== 'number')) return
      propertyEditor = {
        path,
        type: action === 'edit-color' ? 'color' : action === 'edit-curve' ? 'curve' : 'gradient',
        value:
          typeof value === 'number'
            ? {
                r: ((value >> 16) & 255) / 255,
                g: ((value >> 8) & 255) / 255,
                b: (value & 255) / 255,
              }
            : structuredClone(value as NativeRecord),
        material: typeof value === 'number',
      }
      renderInspector()
      return
    }
    if (action === 'color-editor-cancel' || action === 'curve-editor-cancel') {
      propertyEditor = undefined
      renderInspector()
      return
    }
    if (action === 'color-editor-apply' || action === 'curve-editor-apply') {
      if (!propertyEditor) return
      const editor = propertyEditor
      try {
        validateNative(editor.value)
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Invalid property', true)
        return
      }
      propertyEditor = undefined
      if (editor.type === 'gradient') {
        for (const part of ['color', 'alpha'])
          ((editor.value[part] as NativeRecord).keys as NativeRecord[]).sort(
            (a, b) => Number(a.pos) - Number(b.pos),
          )
      }
      commitNativeEdit((node, json) =>
        setNativeValue(
          { ...node, document: json },
          editor.path,
          editor.material
            ? Number.parseInt(
                asHex(['r', 'g', 'b'].map((key) => Number(editor.value[key]))).slice(1),
                16,
              )
            : editor.value,
        ),
      )
      return
    }
    commitNativeEdit((node, json) => {
      const root = { ...node, document: json }
      if (action?.startsWith('behavior-')) {
        const slots = behaviorSlots(node)
        const index = Number(target.dataset.slot)
        const slot = slots[index]
        if (!slot) throw new Error('Select a behavior.')
        if (action === 'behavior-toggle') slot.enabled = (target as HTMLInputElement).checked
        else if (action === 'behavior-remove') slots.splice(index, 1)
        else {
          const next = index + (action === 'behavior-up' ? -1 : 1)
          if (next < 0 || next >= slots.length) return
          ;[slots[index], slots[next]] = [slots[next]!, slots[index]!]
        }
        writeBehaviorSlots(node, slots)
      } else if (action === 'append') appendNativeItem(root, path)
      else if (action === 'remove') {
        const array = getNativeValue(root, path.slice(0, -1))
        if (!Array.isArray(array)) throw new Error('Select a list item.')
        array.splice(Number(path.at(-1)), 1)
      } else if (action === 'generator') {
        const type = (target as HTMLSelectElement).value
        if (!Object.hasOwn(generatorTemplates, type)) throw new Error('Unsupported generator.')
        setNativeValue(root, path, generatorTemplates[type]!())
      } else if (action === 'shape')
        setNativeValue(root, path, newShape((target as HTMLSelectElement).value))
      else {
        const input = target as HTMLInputElement
        const value =
          input.dataset.nativeKind === 'number'
            ? input.value === ''
              ? NaN
              : Number(input.value)
            : input.dataset.nativeKind === 'boolean'
              ? input.checked
              : input.dataset.nativeKind === 'hex'
                ? Number.parseInt(input.value.slice(1), 16)
                : input.value
        setNativeValue(root, path, value)
        if (
          path[0] === 'ps' &&
          path[1] === 'shape' &&
          ['mesh', 'geometry'].includes(String(path.at(-1)))
        ) {
          const shape = (node.ps as NativeRecord).shape as NativeRecord
          shape.mesh = value
          shape.geometry = value
        }
        if (['pos', 'start'].includes(String(path.at(-1)))) {
          const array = getNativeValue(root, path.slice(0, -2))
          const key = String(path.at(-1))
          if (Array.isArray(array)) array.sort((a, b) => Number(a[key]) - Number(b[key]))
        }
        if (path.at(-1) === 'time' && path.includes('emissionBursts')) {
          const bursts = (node.ps as NativeRecord).emissionBursts as NativeRecord[]
          bursts.sort((a, b) => Number(a.time) - Number(b.time))
        }
        if (path.at(-1) === 'subParticleSystem' && value) {
          const child = emitterNodes(nativeRoot(json)).find((item) => item.uuid === value)
          if (child?.ps) child.ps.onlyUsedByOther = true
        }
      }
    })
  }

  function renderBehaviors(node: NativeRecord, context: PropertyContext): string {
    let active = 0,
      disabled = 0
    const items = behaviorSlots(node)
      .map((slot, index) => {
        const prefix: NativePath = slot.enabled
          ? ['ps', 'behaviors', active++]
          : ['userData', 'quarksEditorDisabled', disabled++, 'value']
        return `<details class="behavior-module" open><summary><label><input type="checkbox" data-native-action="behavior-toggle" data-slot="${index}" ${slot.enabled ? 'checked' : ''}> ${esc(propertyLabel(String(slot.value.type)))}</label></summary><fieldset ${slot.enabled ? '' : 'disabled'}>${renderProperties(
          slot.value,
          Object.keys(slot.value).filter((key) => key !== 'type'),
          context,
          prefix,
        )}</fieldset><div class="system-actions"><button class="btn small" type="button" data-native-action="behavior-up" data-slot="${index}">Up</button><button class="btn small" type="button" data-native-action="behavior-down" data-slot="${index}">Down</button><button class="btn small danger" type="button" data-native-action="behavior-remove" data-slot="${index}">Remove</button></div></details>`
      })
      .join('')
    return `${items}<label class="field"><span>Add Module</span><select data-add-behavior><option value="">Choose a Quarks behavior...</option>${Object.keys(
      BehaviorTypes,
    )
      .map((type) => `<option value="${esc(type)}">${esc(propertyLabel(type))}</option>`)
      .join(
        '',
      )}</select></label><p class="hint">All registered behaviors, in execution order. Angles use native radians. Disabled modules retain their settings in Object3D userData.</p>`
  }

  function renderColorStops(system: ParticleSystem, context: PropertyContext): string {
    const index = system.behaviors.findIndex((behavior) => behavior.type === 'ColorOverLife')
    const behavior = system.behaviors[index] as ColorOverLife | undefined
    if (behavior && !(behavior.color instanceof Gradient))
      return '<p class="hint">Edit this color generator in the Behaviors module.</p>'
    if (!behavior)
      return '<button class="btn small" type="button" data-action="enable-color">+ Add color over life</button>'
    return renderProperty(behavior.color.toJSON(), ['ps', 'behaviors', index, 'color'], context)
  }

  function renderInspector(): void {
    for (const module of inspector.querySelectorAll<HTMLDetailsElement>('[data-module]')) {
      if (module.open) collapsedModules.delete(module.dataset.module!)
      else collapsedModules.add(module.dataset.module!)
    }
    const effect = currentEffect()
    const emitter = currentEmitter()
    const system = emitter?.system
    if (!effect || !system) {
      inspector.innerHTML =
        '<div class="panel-tab">Inspector</div><div class="empty-list">Open a project folder or create a new effect. Browse textures in the Project panel. No account or backend required.</div>'
      return
    }
    syncEffect()
    const node = nativeNode(effect.json, systemIndex)
    const ps = node.ps as NativeRecord
    const context = propertyContext(effect.json)
    const material = materialOf(system)
    const effectRotation = rootRotation(effect)
    const modes = [
      [RenderMode.BillBoard, 'Billboard'],
      [RenderMode.StretchedBillBoard, 'Stretched Billboard'],
      [RenderMode.HorizontalBillBoard, 'Horizontal Billboard'],
      [RenderMode.VerticalBillBoard, 'Vertical Billboard'],
      [RenderMode.Trail, 'Trail'],
      [RenderMode.Mesh, 'Mesh'],
    ] as const
    const textureOptions =
      (material.name ? '' : '<option value="" selected disabled>Embedded texture / none</option>') +
      [...textures.keys()]
        .map(
          (name) =>
            `<option value="${esc(name)}" ${name === material.name ? 'selected' : ''}>${esc(name)}</option>`,
        )
        .join('')
    const markup = `
    <div class="panel-tab">Inspector</div><header class="inspector-head"><div class="inspector-kicker">Particle System</div><input class="inspector-title" value="${esc(displayName(effect))}" aria-label="Effect name" data-bind="effect.name"><div class="inspector-sub">${esc(emitter.name || `Particle System ${systemIndex + 1}`)} <span>\u{b7}</span> ${esc(effect.id)}</div></header>
    <section class="inspect-section"><h3>Transform</h3><div class="field-grid">
      <div class="axis-row"><span class="axis-title">Rotation (deg)</span>${(['x', 'y', 'z'] as const).map((axis) => `<label class="axis-field"><span>${axis.toUpperCase()}</span><input type="number" min="-360" max="360" step="1" value="${num((effectRotation[axis] * 180) / Math.PI)}" data-bind="effect.rotation.${axis}"></label>`).join('')}</div>
      ${(['position', 'scale'] as const).map((property) => `<div class="axis-row"><span class="axis-title">Root ${propertyLabel(property)}</span>${(['x', 'y', 'z'] as const).map((axis) => `<label class="axis-field"><span>${axis.toUpperCase()}</span><input type="number" step="any" value="${num(currentGroup![property][axis])}" data-bind="effect.${property}.${axis}"></label>`).join('')}</div>`).join('')}
      ${(['position', 'rotation', 'scale'] as const).map((property) => `<div class="axis-row"><span class="axis-title">Emitter ${propertyLabel(property)}${property === 'rotation' ? ' (deg)' : ''}</span>${(['x', 'y', 'z'] as const).map((axis) => `<label class="axis-field"><span>${axis.toUpperCase()}</span><input type="number" step="any" value="${num(property === 'rotation' ? (emitter[property][axis] * 180) / Math.PI : emitter[property][axis])}" data-bind="emitter.${property}.${axis}"></label>`).join('')}</div>`).join('')}
    </div><p class="hint">Rotates the native root Group and all its emitters. Angles are degrees.</p></section>
    <section class="inspect-section"><h3>Main</h3><div class="field-grid">
      <label class="field"><span>Duration (s)</span><input type="number" min="0.01" step="0.05" value="${num(system.duration)}" data-bind="duration"></label>
      <label class="check-field"><span>Looping</span><input type="checkbox" ${system.looping ? 'checked' : ''} data-bind="looping"></label>
      <label class="field"><span>Simulation Space</span><select data-bind="worldSpace"><option value="false" ${system.worldSpace ? '' : 'selected'}>Local</option><option value="true" ${system.worldSpace ? 'selected' : ''}>World</option></select></label>
      <p class="hint">World keeps existing particles in place as the group moves; Local moves them with the group. Use World to preview a trail left behind by the emitter.</p>
      <label class="check-field"><span>Prewarm</span><input type="checkbox" ${system.prewarm ? 'checked' : ''} data-bind="prewarm"></label>
      <label class="check-field"><span>Auto destroy</span><input type="checkbox" ${system.autoDestroy ? 'checked' : ''} data-bind="autoDestroy"></label>
      ${renderProperties(ps, ['startLife', 'startSpeed', 'startSize', 'startRotation', 'startColor', 'onlyUsedByOther'], context)}
      <label class="field"><span>Gravity Y</span><input type="number" step="0.5" value="${num(gravityOf(system))}" data-bind="gravity"></label>
    </div></section>
    <section class="inspect-section"><h3>Emission</h3><div class="field-grid">
      ${renderProperties(ps, ['emissionOverTime', 'emissionOverDistance', 'emissionBursts'], context)}
    </div></section>
    <section class="inspect-section"><h3>Shape</h3><div class="field-grid">
      ${renderProperty(ps.shape, ['ps', 'shape'], context)}<p class="hint">Native angles are radians. Mesh surface requires indexed geometry.</p>
    </div></section>
    <section class="inspect-section"><h3>Renderer</h3><div class="field-grid">
      <label class="field full"><span>Texture</span><select data-bind="material">${textureOptions}</select></label>
      <button class="btn small" type="button" data-action="import-texture">Browse Texture...</button>
      <div class="field full">${textures.has(material.name) ? `<img class="asset-preview" src="${esc(textures.get(material.name)!)}" alt="${esc(material.name)} texture">` : '<span class="hint">Embedded texture or no project texture selected</span>'}</div>
      <label class="field full"><span>Render Mode</span><select data-bind="renderMode">${modes.map(([mode, label]) => `<option value="${mode}" ${system.renderMode === mode ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="field"><span>Blending</span><select data-bind="additive"><option value="true" ${material.additive ? 'selected' : ''}>Additive</option><option value="false" ${material.additive ? '' : 'selected'}>Alpha</option></select></label>
      ${renderProperties(ps, ['material', 'instancingGeometry', 'rendererEmitterSettings', 'renderOrder', 'layers', 'softParticles', 'softNearFade', 'softFarFade'], context)}
      <label class="field"><span>New Geometry</span><select data-geometry-kind>${['Box', 'Sphere', 'Plane', 'Cone', 'Cylinder', 'Torus', 'Icosahedron'].map((type) => `<option>${type}</option>`).join('')}</select></label><button class="btn small" type="button" data-action="add-geometry">+ Geometry</button><button class="btn small" type="button" data-action="import-geometry">Browse Geometry JSON</button>
    </div><p class="hint">Soft particles use the preview depth pass. Your game must also supply a depth texture to BatchedRenderer.</p></section>
    <section class="inspect-section"><h3>Material Properties</h3>${renderMaterial(effect.json, String(ps.material), context)}</section>
    <section class="inspect-section"><h3>Texture Properties</h3>${renderTextureProperties(effect.json, String(ps.material), context)}</section>
    <section class="inspect-section"><h3>Behaviors</h3>${renderBehaviors(node, context)}</section>
    <section class="inspect-section"><h3>Size over lifetime</h3>${renderSizeCurve(system, context)}</section>
    <section class="inspect-section"><h3>Color over lifetime</h3>${renderColorStops(system, context)}</section>
    <section class="inspect-section"><h3>Texture sheet</h3>${renderProperties(ps, ['uTileCount', 'vTileCount', 'startTileIndex', 'blendTiles'], context)}<p class="hint">Add Frame Over Life in Behaviors to animate frames.</p></section>
    <section class="inspect-section"><details class="native-json"><summary>Native Quarks JSON</summary><textarea spellcheck="false" aria-label="Native Quarks JSON" data-native-json>${esc(JSON.stringify(effect.json, null, 2))}</textarea><button class="btn small" type="button" data-action="apply-json">Apply document</button></details></section>
    <section class="inspect-section"><button class="btn danger small" type="button" data-action="delete-effect" ${isBuiltIn(effect.id) || (savedIds.has(effect.id) && !options.deleteEffect) ? 'disabled' : ''}>Delete effect</button>${isBuiltIn(effect.id) && options.deleteEffect ? '<button class="btn small" type="button" data-action="reset-effect">Reset to project default</button>' : ''}</section>${propertyEditor ? (propertyEditor.type === 'curve' ? curveEditorMarkup() : colorEditorMarkup(propertyEditor.type)) : ''}`
    inspector.innerHTML = markup.replace(
      /<section class="inspect-section"><h3>([^<]+)<\/h3>([\s\S]*?)<\/section>/g,
      (_match, title: string, content: string) =>
        `<details class="particle-module" data-module="${esc(title)}" ${collapsedModules.has(title) ? '' : 'open'}><summary>${esc(title)}</summary><div class="module-body">${content}</div></details>`,
    )
    if (propertyEditor) {
      const dialog = inspector.querySelector<HTMLDialogElement>('.color-editor-dialog')
      if (dialog) {
        if (propertyEditor.type === 'curve')
          bindCurveEditor(
            dialog,
            propertyEditor.value,
            propertyLabel(String(propertyEditor.path.at(-1))),
          )
        else bindColorEditor(dialog, propertyEditor.type, propertyEditor.value)
      }
      dialog?.addEventListener('cancel', () => (propertyEditor = undefined), { once: true })
      dialog?.showModal()
    }
  }

  function renderTextures(): void {
    textureObserver.disconnect()
    visibleTexturePreviews.clear()
    const ids = new Set([...textureFiles.keys(), ...textures.keys()])
    $('[data-texture-list]').innerHTML = ids.size
      ? [...ids]
          .map(
            (id) =>
              `<button class="texture-item" type="button" data-texture="${esc(id)}" title="Load and assign ${esc(id)} to selected particle system">${textures.has(id) ? `<img loading="lazy" decoding="async" src="${esc(textures.get(id)!)}" alt="">` : '<span class="texture-placeholder" aria-hidden="true">\u{25a7}</span>'}<span>${esc(id)}</span></button>`,
          )
          .join('')
      : '<p class="empty-list">No textures. Browse or drop PNG, JPEG, WebP, or GIF files.</p>'
    for (const button of $('[data-texture-list]').querySelectorAll<HTMLElement>('[data-texture]'))
      if (!textures.has(button.dataset.texture!)) textureObserver.observe(button)
  }

  function readLibraryTexture(handle: FileSystemFileHandle): Promise<string> {
    const cached = texturePreviewLoads.get(handle)
    if (cached) return cached
    const reading = handle
      .getFile()
      .then(readTextureFile)
      .catch((error) => {
        if (texturePreviewLoads.get(handle) === reading) texturePreviewLoads.delete(handle)
        throw error
      })
    texturePreviewLoads.set(handle, reading)
    return reading
  }

  async function loadTexturePreviews(): Promise<void> {
    if (loadingTexturePreviews) return
    loadingTexturePreviews = true
    try {
      // Decode one visible file at a time without assigning it or rebuilding the library.
      for (const button of visibleTexturePreviews) {
        visibleTexturePreviews.delete(button)
        textureObserver.unobserve(button)
        const id = button.dataset.texture!
        const handle = textureFiles.get(id)
        if (!handle || !button.isConnected || destroyed) continue
        try {
          const url = await readLibraryTexture(handle)
          if (destroyed || textureFiles.get(id) !== handle || !button.isConnected) continue
          const placeholder = button.querySelector('.texture-placeholder')
          if (placeholder)
            placeholder.outerHTML = `<img loading="lazy" decoding="async" src="${esc(url)}" alt="">`
        } catch (error) {
          if (!destroyed && textureFiles.get(id) === handle && button.isConnected)
            button.title = `${error instanceof Error ? error.message : 'Could not load texture preview.'} Click to retry.`
        }
      }
    } finally {
      loadingTexturePreviews = false
    }
  }

  function addGeometry(geometry: THREE.BufferGeometry): void {
    try {
      const position = geometry.getAttribute('position')
      if (
        !position ||
        !position.count ||
        position.count > 1_000_000 ||
        !Array.from(position.array).every(Number.isFinite)
      )
        throw new Error('Geometry needs finite positions and at most one million vertices.')
      if (!geometry.index)
        geometry.setIndex(Array.from({ length: position.count }, (_, index) => index))
      if (
        !Array.from(geometry.index!.array).every(
          (index) => Number.isInteger(index) && index >= 0 && index < position.count,
        )
      )
        throw new Error('Geometry has invalid indices.')
      commitNativeEdit((node, json) => {
        const geometries = (json.geometries ??= []) as NativeRecord[]
        geometries.push(geometry.toJSON() as unknown as NativeRecord)
        const ps = node.ps as NativeRecord
        if ((ps.shape as NativeRecord).type === 'mesh_surface')
          ps.shape = { type: 'mesh_surface', geometry: geometry.uuid, mesh: geometry.uuid }
        else ps.instancingGeometry = geometry.uuid
      })
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Could not import geometry', true)
    } finally {
      geometry.dispose()
    }
  }

  async function importTextures(files: readonly File[]): Promise<void> {
    if (!files.length || saving) return
    saving = true
    root.inert = true
    let imported = false
    try {
      const directory = projectDirectory ?? (await pickProjectDirectory())
      if (destroyed) return
      useProjectDirectory(directory)
      for (const file of files) {
        if (destroyed) return
        try {
          if (textures.has(file.name) || textureFiles.has(file.name))
            throw new Error(
              `A texture named "${file.name}" is already loaded. Rename the file to import another version.`,
            )
          const url = await readTextureFile(file)
          if (destroyed) return
          const path = await textureAssetPath(file)
          await writeFolderAssets(directory, new Map([[path, file]]))
          if (destroyed) return
          if (textures.has(file.name))
            throw new Error(`A texture named "${file.name}" is already loaded.`)
          textures.set(file.name, url)
          imported = true
          renderTextures()
          flash(
            `Imported ${file.name}. Matching local image paths resolve automatically; select its thumbnail to assign it manually.`,
          )
        } catch (error) {
          if (!destroyed)
            flash(error instanceof Error ? error.message : 'Could not import texture', true)
        }
      }
    } catch (error) {
      if (!destroyed && !(error instanceof Error && error.name === 'AbortError'))
        flash(error instanceof Error ? error.message : 'Could not copy textures to project.', true)
    } finally {
      saving = false
      if (!destroyed) root.inert = false
    }
    if (!imported || destroyed) return
    syncEffect()
    let changed = false
    let refresh = false
    for (const effect of effects) {
      if (unloadedEffects.has(effect.id)) continue
      if (resolveLocalTextures(effect.json, textures)) {
        changed = true
        if (effect.id === currentId) refresh = true
      }
    }
    if (refresh) {
      releasePreview()
      resetPreview()
    }
    if (changed) markDirty()
    renderInspector()
  }

  async function loadTexture(id: string): Promise<void> {
    if (saving) return
    const handle = textureFiles.get(id)
    if (handle && !textures.has(id)) {
      saving = true
      root.inert = true
      try {
        await showLoading(`Loading texture: ${id}…`)
        const url = await readLibraryTexture(handle)
        if (destroyed) return
        textures.set(id, url)
        renderTextures()
      } catch (error) {
        if (!destroyed)
          flash(error instanceof Error ? error.message : 'Could not load texture.', true)
        return
      } finally {
        saving = false
        hideLoading()
        if (!destroyed) root.inert = false
      }
    }
    assignTexture(id)
  }

  function assignTexture(id: string): void {
    const system = currentEmitter()?.system
    if (!system || !textures.has(id)) return
    recordHistory()
    const material = (system.material as THREE.MeshBasicMaterial).clone()
    const source = createMaterial(id)
    material.map = source.map
    source.dispose()
    system.material = material
    markEdit()
    renderInspector()
  }

  function linearCurve(points: readonly (readonly [number, number])[]): PiecewiseBezier {
    const first = points[0] ?? [0, 1]
    const last = points.at(-1) ?? [1, 1]
    const keys = [
      [0, first[1]] as const,
      ...points.filter(([time]) => time > 0 && time < 1),
      [1, last[1]] as const,
    ]
    return new PiecewiseBezier(
      keys.slice(0, -1).map(([time, value], index) => {
        const nextValue = keys[index + 1]![1]
        const delta = nextValue - value
        return [new Bezier(value, value + delta / 3, value + (delta * 2) / 3, nextValue), time]
      }),
    )
  }

  function setColorGradient(
    system: ParticleSystem,
    colors: readonly (readonly [number, number, number, number])[],
    alphas: readonly (readonly [number, number])[],
  ): void {
    const gradient = new Gradient(
      colors.map(([time, r, g, b]) => [new QVector3(r, g, b), time]),
      alphas.map(([time, alpha]) => [alpha, time]),
    )
    const current = system.behaviors.find((item) => item.type === 'ColorOverLife') as
      ColorOverLife | undefined
    if (current) current.color = gradient
    else system.behaviors.push(new ColorOverLife(gradient))
  }

  function serializeGroup(group: THREE.Object3D): QuarksDocument {
    const previous = group === currentGroup ? currentEffect()?.json : undefined
    const json = group.toJSON() as unknown as QuarksDocument
    const urls = new Map<string, string>()
    group.traverse((object) => {
      if (object.type !== 'ParticleEmitter' || !('system' in object)) return
      const system = (object as EmitterObject).system
      const material = system.material as THREE.MeshBasicMaterial
      const materialJson = ((json.materials ?? []) as NativeRecord[]).find(
        (item) => item.uuid === material.uuid,
      )
      if (materialJson)
        for (const key of [
          'opacity',
          'transparent',
          'depthWrite',
          'depthTest',
          'alphaTest',
          'side',
          'blending',
          'colorWrite',
          'toneMapped',
        ] as const)
          materialJson[key] = material[key]
      if (system.emitterShape instanceof MeshSurfaceEmitter && system.emitterShape.geometry) {
        const geometry = system.emitterShape.geometry
        const geometries = (json.geometries ??= []) as NativeRecord[]
        if (!geometries.some((item) => item.uuid === geometry.uuid))
          geometries.push(geometry.toJSON() as unknown as NativeRecord)
        const node = emitterNodes(nativeRoot(json)).find((node) => node.uuid === object.uuid)
        if (node?.ps)
          node.ps.shape = { type: 'mesh_surface', mesh: geometry.uuid, geometry: geometry.uuid }
      }
      const texture = material.map
      const source = texture?.image as { src?: string } | undefined
      if (!texture) return
      const projectUrl =
        textures.get(texture.name) ??
        [...textures.values()].find((url) => new URL(url, document.baseURI).href === source?.src)
      if (projectUrl) urls.set(texture.uuid, projectUrl)
      else if (source?.src) {
        const originalTexture = (previous?.textures as NativeRecord[] | undefined)?.find(
          (item) => item.uuid === texture.uuid,
        )
        const original = previous?.images?.find(
          (image) => image.uuid === originalTexture?.image,
        )?.url
        // Preserve relative paths while images are missing so later local imports can resolve them.
        urls.set(
          texture.uuid,
          typeof original === 'string' && new URL(original, document.baseURI).href === source.src
            ? original
            : source.src,
        )
      }
    })
    const parsed = json as unknown as {
      textures?: { uuid: string; image: string }[]
      images?: { uuid: string; url: unknown }[]
    }
    const urlsByImage = new Map(
      (parsed.textures ?? []).map((texture) => [texture.image, urls.get(texture.uuid)]),
    )
    for (const image of parsed.images ?? []) {
      const url = urlsByImage.get(image.uuid)
      if (url) image.url = url
    }
    if (previous) preserveNativeAssets(previous, json)
    return parseQuarksDocument(json)
  }

  function renderTransport(): void {
    const fraction = Math.max(0, Math.min(1, elapsed / previewDuration))
    $('[data-progress]').setAttribute('style', `width:${fraction * 100}%`)
    $('[data-knob]').setAttribute('style', `left:${fraction * 100}%`)
    $('[data-time]').textContent = elapsed.toFixed(2)
    $('[data-duration]').textContent = `${previewDuration.toFixed(2)} s`
    $('[data-end-tick]').textContent = `${previewDuration.toFixed(1)}s`
    $<HTMLButtonElement>('[data-play]').textContent = playing ? 'Pause' : 'Play'
    $<HTMLInputElement>('[data-timeline]').value = String(Math.round(fraction * 1000))
  }

  function resetPreview(): void {
    previewFailed = false
    syncEffect()
    releasePreview()
    if (batch) {
      scene.remove(batch)
      disposeObjects(batch)
    }
    batch = new BatchedRenderer()
    batch.setDepthTexture(depthTarget?.depthTexture ?? null)
    scene.add(batch)
    const effect = currentEffect()
    if (effect) {
      resolveLocalTextures(effect.json, textures)
      currentGroup = new QuarksLoader().parse(structuredClone(effect.json))
      currentGroup.name = displayName(effect)
      scene.add(currentGroup)
      QuarksUtil.addToBatchRenderer(currentGroup, batch)
      transformControls?.attach(currentGroup)
      previewSystems = emitters(currentGroup).map((emitter) => emitter.system)
      previewDuration = particlePreviewDuration(previewSystems)
    }
    elapsed = 0
    renderTransport()
  }

  function releasePreview(): void {
    window.clearTimeout(previewTimer)
    transformControls?.detach()
    if (currentGroup) disposeObjects(currentGroup)
    for (const system of previewSystems) system.dispose()
    previewSystems = []
    if (currentGroup) {
      scene.remove(currentGroup)
    }
    currentGroup = undefined
  }

  function disposeObjects(group: THREE.Object3D): void {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose()
        }
        material.dispose()
      }
      if ('system' in object) {
        const material = (object as EmitterObject).system.material as THREE.MeshBasicMaterial
        material.map?.dispose()
        material.dispose()
      }
    })
  }

  function setupPreview(): void {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    depthTarget = new THREE.WebGLRenderTarget(1, 1)
    depthTarget.depthTexture = new THREE.DepthTexture(1, 1)
    scene = new THREE.Scene()
    scene.background = new THREE.Color('#282828')
    camera = new THREE.PerspectiveCamera(43, 1, 0.1, 150)
    camera.layers.enableAll()
    camera.position.set(8, 6, 10)
    controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.target.set(0, 1.1, 0)
    controls.minDistance = 2
    controls.maxDistance = 35
    transformControls = new TransformControls(camera, canvas)
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value
    })
    let transformStart: { position: THREE.Vector3; effect: EffectFile } | undefined
    transformControls.addEventListener('mouseDown', () => {
      const effect = currentEffect()
      if (!effect || !currentGroup) return
      syncEffect()
      transformStart = {
        position: currentGroup.position.clone(),
        effect: structuredClone(effect),
      }
    })
    transformControls.addEventListener('mouseUp', () => {
      const start = transformStart
      transformStart = undefined
      if (!start || !currentGroup || currentGroup.position.equals(start.position)) return
      recordHistory(start.effect)
      syncEffect()
      markDirty()
      renderEffects(true)
      renderSystems()
      renderInspector()
    })
    scene.add(transformControls.getHelper())
    scene.add(new THREE.HemisphereLight(0xc4ddff, 0x242130, 1.7))
    const key = new THREE.DirectionalLight(0xffe2b1, 2.2)
    key.position.set(-4, 8, 5)
    scene.add(key)
    grid = new THREE.GridHelper(16, 32, 0x777777, 0x414141)
    grid.position.y = -0.025
    grid.material.depthWrite = false
    scene.add(grid)
    batch = new BatchedRenderer()
    scene.add(batch)
    const viewport = $<HTMLElement>('.viewport')
    resize = new ResizeObserver(() => {
      const rect = viewport.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pendingSize = {
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      }
    })
    resize.observe(viewport)
  }

  function pauseBrokenPreview(error: unknown): void {
    playing = false
    previewFailed = true
    flash(
      `Preview paused: ${error instanceof Error ? error.message : 'incompatible Quarks settings'}. Edit the modules or restart to retry.`,
      true,
    )
    renderTransport()
  }

  function simulate(delta: number): boolean {
    if (previewFailed) return false
    try {
      updateParticlePreview(batch, previewSystems, delta)
      return true
    } catch (error) {
      pauseBrokenPreview(error)
      return false
    }
  }

  function frame(now: number): void {
    if (!frameRequest) return
    try {
      drawFrame(now)
    } catch (error) {
      pauseBrokenPreview(error)
    }
    frameRequest = window.requestAnimationFrame(frame)
  }

  function drawFrame(now: number): void {
    if (previewFailed) return
    // Canvas writes belong in the animation frame, not ResizeObserver delivery.
    if (pendingSize) {
      renderer.setSize(pendingSize.width, pendingSize.height, false)
      depthTarget.setSize(pendingSize.width, pendingSize.height)
      camera.aspect = pendingSize.width / pendingSize.height
      camera.updateProjectionMatrix()
      pendingSize = undefined
    }
    const dt = Math.min((now - previousFrame) / 1000, 0.05)
    previousFrame = now
    if (playing && dt > 0) {
      if (!simulate(dt)) return
      elapsed += dt
      if (elapsed >= previewDuration) {
        if (previewSystems.some((system) => system.looping && !system.onlyUsedByOther))
          elapsed %= previewDuration
        else {
          elapsed = previewDuration
          playing = false
        }
      }
      renderTransport()
    }
    controls.update()
    if (previewSystems.some((system) => system.softParticles)) {
      const visible = batch.visible
      batch.visible = false
      renderer.setRenderTarget(depthTarget)
      try {
        renderer.render(scene, camera)
      } finally {
        renderer.setRenderTarget(null)
        batch.visible = visible
      }
    }
    renderer.render(scene, camera)
  }

  function startAnimation(): void {
    if (!frameRequest) {
      previousFrame = performance.now()
      frameRequest = window.requestAnimationFrame(frame)
    }
  }

  function schedulePreview(): void {
    window.clearTimeout(previewTimer)
    previewTimer = window.setTimeout(() => {
      resetPreview()
      renderTransport()
    }, 120)
  }

  function markEdit(): void {
    syncEffect()
    markDirty()
    renderEffects(true)
    renderSystems()
    schedulePreview()
  }

  function setRange(
    system: ParticleSystem,
    key: 'life' | 'speed' | 'size' | 'rotation',
    index: 0 | 1,
    value: number,
  ): void {
    const property =
      key === 'life'
        ? 'startLife'
        : key === 'speed'
          ? 'startSpeed'
          : key === 'size'
            ? 'startSize'
            : 'startRotation'
    const bounds = intervalBounds(system[property], [0, 0])
    bounds[index] = key === 'rotation' ? (value * Math.PI) / 180 : value
    system[property] = new IntervalValue(bounds[0], bounds[1])
  }

  function writeBound(target: HTMLInputElement | HTMLSelectElement): void {
    const bind = target.dataset.bind
    const system = currentEmitter()?.system
    const effect = currentEffect()
    if (!bind || !system || !effect) return
    const value =
      target instanceof HTMLInputElement && target.type === 'checkbox'
        ? target.checked
        : target instanceof HTMLInputElement && target.type === 'color'
          ? fromHex(target.value)
          : target instanceof HTMLSelectElement &&
              (bind === 'additive' ||
                bind === 'looping' ||
                bind === 'worldSpace' ||
                bind === 'blendTiles')
            ? target.value === 'true'
            : target instanceof HTMLInputElement && target.type === 'number'
              ? Number(target.value)
              : target.value
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || (bind === 'duration' && value <= 0))
    ) {
      flash('Enter a finite number; duration must be positive.', true)
      return
    }
    if (bind === 'effect.name') {
      const name = String(value).trim() || effect.id
      currentGroup!.name = name
      nativeRoot(effect.json).name = name
    } else if (bind.startsWith('effect.rotation.')) {
      const axis = bind.at(-1) as 'x' | 'y' | 'z'
      currentGroup!.rotation[axis] = (Number(value) * Math.PI) / 180
    } else if (bind.startsWith('emitter.')) {
      const [, property, axis] = bind.split('.') as [
        string,
        'position' | 'rotation' | 'scale',
        'x' | 'y' | 'z',
      ]
      currentEmitter()![property][axis] =
        property === 'rotation' ? (Number(value) * Math.PI) / 180 : Number(value)
    } else if (bind.startsWith('effect.position.') || bind.startsWith('effect.scale.')) {
      const [, property, axis] = bind.split('.') as [string, 'position' | 'scale', 'x' | 'y' | 'z']
      currentGroup![property][axis] = Number(value)
    } else if (bind === 'duration') system.duration = Number(value)
    else if (bind === 'looping') system.looping = Boolean(value)
    else if (bind === 'worldSpace') system.worldSpace = Boolean(value)
    else if (bind === 'prewarm') system.prewarm = Boolean(value)
    else if (bind === 'autoDestroy') system.autoDestroy = Boolean(value)
    else if (bind === 'rate') system.emissionOverTime = new ConstantValue(Number(value))
    else if (bind === 'distanceRate') system.emissionOverDistance = new ConstantValue(Number(value))
    else if (bind === 'life.0' || bind === 'life.1')
      setRange(system, 'life', Number(bind.at(-1)) as 0 | 1, Number(value))
    else if (bind === 'speed.0' || bind === 'speed.1')
      setRange(system, 'speed', Number(bind.at(-1)) as 0 | 1, Number(value))
    else if (bind === 'size.0' || bind === 'size.1')
      setRange(system, 'size', Number(bind.at(-1)) as 0 | 1, Number(value))
    else if (bind === 'rotation.0' || bind === 'rotation.1')
      setRange(system, 'rotation', Number(bind.at(-1)) as 0 | 1, Number(value))
    else if (bind === 'burst.count' || bind === 'burst.time') {
      const burst = system.emissionBursts[0]
      const count = burst ? intervalBounds(burst.count, [0, 0])[1] : 0
      const time = burst?.time ?? 0
      const nextCount = bind === 'burst.count' ? Number(value) : count
      const nextTime = bind === 'burst.time' ? Number(value) : time
      system.emissionBursts =
        nextCount > 0
          ? [
              {
                time: nextTime,
                count: new ConstantValue(nextCount),
                cycle: 1,
                interval: 0,
                probability: 1,
              },
            ]
          : []
    } else if (bind === 'shape.kind') {
      const shape = String(value)
      system.emitterShape =
        shape === 'cone'
          ? new ConeEmitter({ angle: Math.PI / 6, radius: 0.5 })
          : shape === 'sphere'
            ? new SphereEmitter({ radius: 1 })
            : shape === 'hemisphere'
              ? new HemisphereEmitter({ radius: 1 })
              : shape === 'circle'
                ? new CircleEmitter({ radius: 1 })
                : shape === 'donut'
                  ? new DonutEmitter({ radius: 1, donutRadius: 0.2 })
                  : shape === 'rectangle'
                    ? new RectangleEmitter({ width: 1, height: 1 })
                    : shape === 'grid'
                      ? new GridEmitter({ width: 1, height: 1, row: 2, column: 2 })
                      : new PointEmitter()
      renderInspector()
    } else if (bind === 'shape.angle' || bind === 'shape.arc') {
      const property = bind.slice('shape.'.length) as 'angle' | 'arc'
      if (property in system.emitterShape)
        (system.emitterShape as unknown as Record<string, unknown>)[property] =
          (Number(value) * Math.PI) / 180
    } else if (bind.startsWith('shape.')) {
      const key = bind.slice('shape.'.length)
      ;(system.emitterShape as unknown as Record<string, unknown>)[key] = Number(value)
    } else if (bind === 'gravity') {
      const force = system.behaviors.find((item) => item.type === 'ApplyForce') as
        ApplyForce | undefined
      if (Number(value) === 0) {
        if (force) system.behaviors.splice(system.behaviors.indexOf(force), 1)
      } else if (force) {
        force.direction.set(0, Math.sign(Number(value)), 0)
        force.magnitude = new ConstantValue(Math.abs(Number(value)))
      } else {
        system.behaviors.push(
          new ApplyForce(
            new QVector3(0, Math.sign(Number(value)), 0),
            new ConstantValue(Math.abs(Number(value))),
          ),
        )
      }
    } else if (bind === 'renderMode') {
      commitNativeEdit((node) => {
        const ps = node.ps as NativeRecord
        ps.renderMode = Number(value)
        ps.rendererEmitterSettings =
          Number(value) === RenderMode.Trail
            ? { startLength: { type: 'ConstantValue', value: 30 }, followLocalOrigin: false }
            : Number(value) === RenderMode.StretchedBillBoard
              ? { speedFactor: 1, lengthFactor: 1 }
              : {}
      })
      return
    } else if (bind === 'additive' || bind === 'material') {
      const old = system.material as THREE.MeshBasicMaterial
      if (bind === 'material') {
        system.material = createMaterial(String(value), old.blending === THREE.AdditiveBlending)
      } else {
        const material = old.clone()
        material.blending = value ? THREE.AdditiveBlending : THREE.NormalBlending
        system.material = material
      }
    } else if (bind === 'startColor' || bind === 'startAlpha') {
      const color = colorOf(system)
      const rgb = bind === 'startColor' ? (value as number[]) : color.slice(0, 3)
      const alpha = bind === 'startAlpha' ? Number(value) : color[3]
      system.startColor = new ConstantColor(new QVector4(rgb[0]!, rgb[1]!, rgb[2]!, alpha))
    } else if (bind === 'uTileCount') system.uTileCount = Number(value)
    else if (bind === 'vTileCount') system.vTileCount = Number(value)
    else if (bind === 'startTileIndex') system.startTileIndex = new ConstantValue(Number(value))
    else if (bind === 'blendTiles') system.blendTiles = Boolean(value)
    else if (bind === 'frame.start' || bind === 'frame.end') {
      const [start, end] = frameRange(system) ?? [0, system.uTileCount * system.vTileCount]
      setFrameRange(
        system,
        bind === 'frame.start' ? Number(value) : start,
        bind === 'frame.end' ? Number(value) : end,
      )
    }
    markEdit()
  }

  function createMaterial(name: string, additive = true): THREE.MeshBasicMaterial {
    const url = textures.get(name)
    const map = url ? new THREE.TextureLoader().load(url) : null
    if (map) {
      map.name = name
      map.colorSpace = THREE.SRGBColorSpace
    }
    return new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      name,
    })
  }

  function newNativeSystem(): ParticleSystem {
    return new ParticleSystem({
      duration: 5,
      looping: true,
      autoDestroy: false,
      shape: new ConeEmitter({ angle: Math.PI / 6, radius: 0.1 }),
      startLife: new ConstantValue(5),
      startSpeed: new ConstantValue(5),
      startSize: new ConstantValue(1),
      startColor: new ConstantColor(new QVector4(1, 1, 1, 1)),
      emissionOverTime: new ConstantValue(10),
      emissionBursts: [],
      material: createMaterial(textures.keys().next().value ?? ''),
      behaviors: [],
    })
  }

  function slug(value: string): string {
    return (
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'new-effect'
    )
  }

  function openNameModal(title: string, initial: string, callback: (name: string) => void): void {
    const backdrop = document.createElement('dialog')
    backdrop.className = 'name-dialog'
    backdrop.setAttribute('aria-label', title)
    backdrop.innerHTML = `<form class="modal"><h2>${esc(title)}</h2><p>Creates a native Quarks particle system. Save to a folder to keep your work.</p><input name="name" value="${esc(initial)}" maxlength="80" required autocomplete="off" aria-label="Effect name"><div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Create effect</button></div></form>`
    root.append(backdrop)
    backdrop.showModal()
    backdrop.addEventListener('close', () => backdrop.remove(), { once: true })
    const form = backdrop.querySelector('form')!
    const input = form.querySelector('input')!
    input.focus()
    input.select()
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      callback(input.value.trim())
      backdrop.close()
    })
    form.querySelector('[data-cancel]')!.addEventListener('click', () => backdrop.close())
  }

  async function saveCurrent(): Promise<void> {
    const effect = currentEffect()
    if (saving || (!effect && options.saveEffect && !projectDirectory)) return
    saving = true
    root.inert = true
    try {
      syncEffect()
      const revision = editRevision
      const snapshots = structuredClone(
        options.saveEffect && !projectDirectory
          ? [effect!]
          : effects.filter((item) => !unloadedEffects.has(item.id)),
      )
      // Open the picker before yielding so the browser retains the user gesture.
      const directory =
        options.saveEffect && !projectDirectory
          ? undefined
          : (projectDirectory ?? (await pickProjectDirectory()))
      await showLoading('Preparing save… Do not close the editor.')
      if (!directory) {
        await showLoading('Saving effect… Do not close the editor.', 0, 1)
        await options.saveEffect!(effect!.id, exportDocument(snapshots[0]!.json))
        savedIds.add(effect!.id)
      } else {
        if (destroyed) return
        const filenames = snapshots.map(
          (item) => projectFiles.get(item.id) ?? `${slug(item.id)}.json`,
        )
        for (const filename of filenames) {
          if (
            ![...projectFiles.values()].includes(filename) &&
            (await existingFile(directory, filename))
          )
            if (!window.confirm(`Replace "${filename}" in the selected folder?`)) return
        }
        const bundles: Awaited<ReturnType<typeof prepareFolderExport>>[] = []
        for (const [index, item] of snapshots.entries()) {
          await showLoading(
            `Preparing ${filenames[index]}… Do not close the editor.`,
            index,
            snapshots.length,
          )
          bundles.push(await prepareFolderExport(item.json, document.baseURI))
        }
        if (destroyed) return
        const total =
          pendingAssets.size +
          bundles.reduce((sum, bundle) => sum + bundle.files.size, 0) +
          bundles.length +
          [...deletedProjectFiles].filter((name) => !filenames.includes(name)).length
        let completed = 0
        const reportWritten = async (path: string) => {
          await showLoading(`Saved ${path}. Do not close the editor.`, ++completed, total)
        }
        await showLoading('Writing project files… Do not close the editor.', completed, total)
        // Finish all assets before replacing any document.
        await writeFolderAssets(directory, pendingAssets, reportWritten)
        for (const bundle of bundles)
          await writeFolderAssets(directory, bundle.files, reportWritten)
        for (const [index, bundle] of bundles.entries()) {
          const filename = filenames[index]!
          await writeFolderExport(directory, filename, { json: bundle.json, files: new Map() })
          deletedProjectFiles.delete(filename)
          await reportWritten(filename)
        }
        for (const filename of deletedProjectFiles) {
          await directory.removeEntry(filename)
          deletedProjectFiles.delete(filename)
          await showLoading(`Removed ${filename}. Do not close the editor.`, ++completed, total)
        }
        useProjectDirectory(directory)
        pendingAssets.clear()
        for (const [index, item] of snapshots.entries())
          projectFiles.set(item.id, filenames[index]!)
      }
      if (destroyed) return
      if (!projectDirectory && options.saveEffect)
        for (const snapshot of snapshots) savedEffects.set(snapshot.id, snapshot)
      if (editRevision === revision) setSaved()
      renderEffects()
      renderInspector()
      flash(
        projectDirectory
          ? `Saved project: ${projectDirectory.name}`
          : `Saved native Quarks JSON: ${effect!.id}.json`,
      )
    } catch (error) {
      if (!destroyed && !(error instanceof Error && error.name === 'AbortError'))
        flash(error instanceof Error ? error.message : 'Could not save Quarks document', true)
    } finally {
      saving = false
      hideLoading()
      if (!destroyed) root.inert = false
    }
  }

  function discardCurrentChanges(): boolean {
    if (projectDirectory || !options.saveEffect) {
      syncEffect()
      return true
    }
    if (dirty) {
      if (!window.confirm('Discard unsaved changes?')) return false
      const saved = savedEffects.get(currentId)
      if (saved)
        effects = effects.map((effect) =>
          effect.id === currentId ? structuredClone(saved) : effect,
        )
      else effects = effects.filter((effect) => effect.id !== currentId)
    }
    return true
  }

  async function loadFolderEffect(
    effect: EffectFile,
    directory: FileSystemDirectoryHandle,
  ): Promise<QuarksDocument> {
    const json = structuredClone(effect.json)
    await resolveFolderAssets(json, directory)
    validateImportedDocument(json)
    return json
  }

  async function selectEffect(id: string): Promise<void> {
    const effect = effects.find((effect) => effect.id === id)
    if (saving || id === currentId || !effect) return
    if (unloadedEffects.has(id)) {
      saving = true
      root.inert = true
      try {
        await showLoading(`Loading ${displayName(effect)}…`)
        const json = await loadFolderEffect(effect, projectDirectory!)
        if (destroyed) return
        effect.json = json
        unloadedEffects.delete(id)
      } catch (error) {
        if (!destroyed)
          flash(error instanceof Error ? error.message : 'Could not load effect.', true)
        return
      } finally {
        saving = false
        hideLoading()
        if (!destroyed) root.inert = false
      }
    }
    if (!discardCurrentChanges()) return
    releasePreview()
    currentId = id
    systemIndex = 0
    undoStack.length = 0
    redoStack.length = 0
    if (!projectDirectory && options.saveEffect) setSaved()
    renderEffects()
    renderSystems()
    resetPreview()
    renderInspector()
  }

  function addNewEffect(name: string, source?: EffectFile): void {
    const id = slug(name)
    if (effects.some((effect) => effect.id === id)) {
      flash(`An effect named "${id}" already exists.`, true)
      return
    }
    if (!discardCurrentChanges()) return
    releasePreview()
    const group = new THREE.Group()
    group.name = name
    const json = source
      ? structuredClone(source.json)
      : (() => {
          const emitter = newNativeSystem().emitter
          emitter.name = 'Particle System'
          group.add(emitter)
          return serializeGroup(group)
        })()
    nativeRoot(json).name = name
    effects.push({ id, json })
    currentId = id
    systemIndex = 0
    undoStack.length = 0
    redoStack.length = 0
    markDirty()
    renderEffects()
    renderSystems()
    resetPreview()
    renderInspector()
  }

  function drawTransport(): void {
    const fraction = Math.max(0, Math.min(1, elapsed / previewDuration))
    $('[data-progress]').setAttribute('style', `width:${fraction * 100}%`)
    $('[data-knob]').setAttribute('style', `left:${fraction * 100}%`)
    $('[data-time]').textContent = elapsed.toFixed(2)
    $('[data-duration]').textContent = `${previewDuration.toFixed(2)} s`
    $('[data-end-tick]').textContent = `${previewDuration.toFixed(1)}s`
    $<HTMLButtonElement>('[data-play]').textContent = playing ? 'Pause' : 'Play'
    $<HTMLInputElement>('[data-timeline]').value = String(Math.round(fraction * 1000))
  }

  function importFile(file: File): Promise<void> {
    if (file.size > 64 * 1024 * 1024) {
      flash('JSON files must not exceed 64 MB.', true)
      return Promise.resolve()
    }
    return file
      .text()
      .then((text) => {
        const json = parseQuarksDocument(JSON.parse(text))
        if (destroyed) return
        importDocument(json, file.name.replace(/\.json$/i, ''))
      })
      .catch((error: unknown) => {
        if (!destroyed) flash(error instanceof Error ? error.message : 'Invalid Quarks JSON', true)
      })
  }

  function importDocument(json: QuarksDocument, fallbackName: string): boolean {
    resolveLocalTextures(json, textures)
    validateImportedDocument(json)
    const name = String(nativeRoot(json).name || fallbackName)
    const id = slug(name)
    const imported = { id, json }
    if (effects.some((effect) => effect.id === id)) {
      if (!window.confirm(`Replace the current "${id}" document with this file?`)) return false
      if (!discardCurrentChanges()) return false
      releasePreview()
      effects = effects.map((effect) => (effect.id === id ? imported : effect))
      unloadedEffects.delete(id)
      currentId = id
      systemIndex = 0
      undoStack.length = 0
      redoStack.length = 0
      markDirty()
      renderEffects()
      renderSystems()
      resetPreview()
      renderInspector()
    } else {
      addNewEffect(name, imported)
      if (currentId !== id) return false
    }
    return true
  }

  function validateImportedDocument(json: QuarksDocument): void {
    if (
      (json.geometries as NativeRecord[] | undefined)?.some(
        (geometry) => geometry.url !== undefined,
      )
    )
      throw new Error(
        'External meshes must be resolved first. Use Open project or import the project ZIP.',
      )
    prepareNativeDocument(json)
    validateSubEmitters(json)
    // Validate runtime compatibility before replacing any in-session document.
    const probe = new QuarksLoader().parse(structuredClone(json))
    disposeObjects(probe)
    for (const emitter of emitters(probe)) emitter.system.dispose()
  }

  async function importEffects(file: File): Promise<void> {
    if (saving) {
      flash('Finish the current file operation first.', true)
      return
    }
    saving = true
    root.inert = true
    try {
      await showLoading(`Reading ${file.name}…`)
      syncEffect()
      const incoming: { path: string; json: QuarksDocument }[] = []
      const assets = new Map<string, Blob>()
      const library = new Map<string, string>()
      const report: string[] = []
      flash(`Reading ${file.name} locally…`)
      if (/\.unitypackage$/i.test(file.name)) {
        const unity = await readUnityPackage(file, (bytes) =>
          showLoading(`Unpacking ${file.name}: ${Math.round(bytes / 1024 / 1024)} MB expanded…`),
        )
        for (const [index, path] of unity.prefabs.entries()) {
          if (destroyed) return
          await showLoading(`Converting ${path}`, index + 1, unity.prefabs.length)
          try {
            const result = await unity.convertPrefab(path)
            incoming.push({ path, json: result.json })
            report.push(
              `${path}\n${result.particleCount} Particle System(s).\n${result.warnings.join('\n') || 'No conversion warnings.'}`,
            )
          } catch (error) {
            report.push(
              `${path}\nSkipped: ${error instanceof Error ? error.message : 'Conversion failed.'}`,
            )
          }
        }
      } else if (/\.zip$/i.test(file.name)) {
        const project = await readProjectZip(file, showLoading)
        incoming.push(...project.effects)
        for (const [path, blob] of project.files) assets.set(path, blob)
        for (const [id, url] of project.textures) library.set(id, url)
      } else throw new Error('Choose a project .zip or .unitypackage file.')
      if (destroyed) return
      const staged: EffectFile[] = []
      const ids = new Set(effects.map((effect) => effect.id))
      for (const [index, { path, json: source }] of incoming.entries()) {
        if (destroyed) return
        await showLoading(`Preparing ${path}`, index + 1, incoming.length)
        try {
          const json = structuredClone(source)
          validateImportedDocument(json)
          const bundle = await prepareFolderExport(json, document.baseURI)
          for (const [path, blob] of bundle.files) await addFolderAsset(assets, path, blob)
          const name = String(
            nativeRoot(json).name ||
              path
                .split('/')
                .at(-1)!
                .replace(/\.[^.]+$/, ''),
          )
          const base = slug(name)
          let id = base
          let suffix = 2
          while (ids.has(id)) id = `${base}-${suffix++}`
          ids.add(id)
          if (id !== base) {
            nativeRoot(json).name = `${name} (${suffix - 1})`
            report.push(`${path}\nRenamed to ${id} to keep the existing effect.`)
          }
          staged.push({ id, json })
          report.push(`${path}\nImported as ${id}.`)
        } catch (error) {
          report.push(
            `${path}\nSkipped: ${error instanceof Error ? error.message : 'Invalid effect.'}`,
          )
        }
      }
      if (destroyed) return
      if (staged.length) {
        await showLoading('Preparing project textures…')
        for (const [path, blob] of assets) {
          if (!blob.type.startsWith('image/')) continue
          const id = path.split('/').at(-1)!
          if (!library.has(id))
            library.set(id, await readTextureFile(new File([blob], id, { type: blob.type })))
        }
        if (destroyed) return
        await showLoading('Copying project assets…')
        if (projectDirectory) await writeFolderAssets(projectDirectory, assets)
        else for (const [path, blob] of assets) await addFolderAsset(pendingAssets, path, blob)
        if (destroyed) return
        releasePreview()
        effects.push(...staged)
        for (const [id, url] of library) {
          let key = id
          let suffix = 2
          while (textures.has(key) && textures.get(key) !== url) key = `${id} (${suffix++})`
          textures.set(key, url)
        }
        currentId = staged[0]!.id
        systemIndex = 0
        undoStack.length = 0
        redoStack.length = 0
        markDirty()
        renderEffects()
        renderTextures()
        renderSystems()
        resetPreview()
        renderInspector()
      }
      $('[data-unity-report-text]').textContent =
        `${file.name}\nImported ${staged.length} effect(s).\n\n${report.join('\n\n')}`
      const details = $<HTMLDetailsElement>('[data-unity-report]')
      details.hidden = false
      details.open = true
      flash(
        `Imported ${staged.length} effect(s). Check the Import report, then Save project.`,
        !staged.length,
      )
    } catch (error) {
      if (!destroyed)
        flash(error instanceof Error ? error.message : 'Could not import effects.', true)
    } finally {
      saving = false
      hideLoading()
      if (!destroyed) root.inert = false
    }
  }

  function exportDocument(source: QuarksDocument): QuarksDocument {
    const json = structuredClone(source)
    const prune = (node: NativeNode): void => {
      if (!node.children) return
      node.children = node.children.filter((child) => child.visible !== false)
      node.children.forEach(prune)
    }
    const root = nativeRoot(json)
    prune(root)
    if (root.visible === false || !emitterNodes(root).length)
      throw new Error('Enable at least one Particle System before exporting.')
    const assetKeys = [
      'geometries',
      'materials',
      'textures',
      'images',
      'shapes',
      'skeletons',
      'animations',
    ]
    const assets = new Map<string, NativeRecord>()
    for (const key of assetKeys)
      for (const asset of (json[key] ?? []) as NativeRecord[]) assets.set(String(asset.uuid), asset)
    const used = new Set<string>()
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && assets.has(value) && !used.has(value)) {
        used.add(value)
        collect(assets.get(value))
      } else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(root)
    for (const key of assetKeys)
      if (Array.isArray(json[key]))
        json[key] = (json[key] as NativeRecord[]).filter((asset) => used.has(String(asset.uuid)))
    return parseQuarksDocument(json)
  }

  function useProjectDirectory(directory: FileSystemDirectoryHandle): void {
    projectDirectory = directory
    $('[data-project-folder]').textContent = directory.name
  }

  async function pickProjectDirectory(): Promise<FileSystemDirectoryHandle> {
    const picker = (
      window as Window & {
        showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
      }
    ).showDirectoryPicker
    if (!picker) throw new Error('Project folders require Chrome or Edge on HTTPS or localhost.')
    return picker.call(window, { mode: 'readwrite' })
  }

  async function openProject(): Promise<void> {
    if (saving) return
    if (dirty && !window.confirm('Discard unsaved changes and open another project?')) return
    saving = true
    root.inert = true
    try {
      const directory = await pickProjectDirectory()
      await showLoading(`Scanning ${directory.name}…`)
      const loaded: EffectFile[] = []
      const filenames = new Map<string, string>()
      const entries: [string, FileSystemFileHandle][] = []
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file' || !/\.json$/i.test(name)) continue
        entries.push([name, handle])
      }
      for (const [index, [name, handle]] of entries.entries()) {
        await showLoading(`Reading ${name}`, index, entries.length)
        const file = await handle.getFile()
        if (file.size > 64 * 1024 * 1024) throw new Error('JSON files must not exceed 64 MB.')
        const json = parseQuarksDocument(JSON.parse(await file.text()))
        prepareNativeDocument(json)
        validateSubEmitters(json)
        const id = slug(name.replace(/\.json$/i, ''))
        if (filenames.has(id)) throw new Error(`Duplicate effect id in project: ${id}`)
        filenames.set(id, name)
        loaded.push({ id, json })
      }
      const library = new Map<string, FileSystemFileHandle>()
      await showLoading('Indexing textures…')
      try {
        const assets = await directory.getDirectoryHandle('assets')
        const folder = await assets.getDirectoryHandle('textures')
        for await (const [name, handle] of folder.entries()) {
          if (handle.kind === 'file' && /\.(png|jpe?g|webp|gif)$/i.test(name))
            library.set(name, handle)
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'NotFoundError')) throw error
      }
      const first = loaded[0]
      if (first) {
        await showLoading(`Loading ${displayName(first)}…`, entries.length, entries.length)
        first.json = await loadFolderEffect(first, directory)
      }
      if (destroyed) return
      releasePreview()
      effects = loaded
      unloadedEffects.clear()
      for (const item of loaded.slice(1)) unloadedEffects.add(item.id)
      textures.clear()
      texturePreviewLoads.clear()
      textureFiles.clear()
      for (const [name, handle] of library) textureFiles.set(name, handle)
      defaults.clear()
      savedIds.clear()
      savedEffects.clear()
      projectFiles.clear()
      deletedProjectFiles.clear()
      pendingAssets.clear()
      // Folder switching keeps edits in effects; host-only discard snapshots are unnecessary here.
      for (const [id, name] of filenames) projectFiles.set(id, name)
      useProjectDirectory(directory)
      currentId = loaded[0]?.id ?? ''
      systemIndex = 0
      undoStack.length = 0
      redoStack.length = 0
      setSaved()
      $('[data-unity-report]').setAttribute('hidden', '')
      renderEffects()
      renderTextures()
      renderSystems()
      resetPreview()
      renderInspector()
      flash(`Opened project: ${directory.name}`)
    } catch (error) {
      if (!destroyed && !(error instanceof Error && error.name === 'AbortError'))
        flash(error instanceof Error ? error.message : 'Could not open project.', true)
    } finally {
      saving = false
      hideLoading()
      if (!destroyed) root.inert = false
    }
  }

  root.addEventListener(
    'click',
    (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-action], [data-effect], [data-system], [data-texture], [data-native-action]',
      )
      if (!target) return
      const action = target.dataset.action
      if (target.dataset.nativeAction) {
        if (target.tagName === 'BUTTON') nativeAction(target)
        return
      }
      if (action === 'add-geometry') {
        const types = {
          Box: THREE.BoxGeometry,
          Sphere: THREE.SphereGeometry,
          Plane: THREE.PlaneGeometry,
          Cone: THREE.ConeGeometry,
          Cylinder: THREE.CylinderGeometry,
          Torus: THREE.TorusGeometry,
          Icosahedron: THREE.IcosahedronGeometry,
        }
        const kind = $<HTMLSelectElement>('[data-geometry-kind]').value as keyof typeof types
        addGeometry(new types[kind]())
        return
      }
      if (action === 'import-geometry') {
        const input = $<HTMLInputElement>('[data-geometry-input]')
        input.value = ''
        input.click()
        return
      }
      if (target.dataset.texture) {
        void loadTexture(target.dataset.texture)
        return
      }
      if (target.dataset.effect) {
        void selectEffect(target.dataset.effect)
        return
      }
      if (target.dataset.system !== undefined) {
        systemIndex = Number(target.dataset.system)
        renderSystems()
        renderInspector()
        return
      }
      if (action === 'save') void saveCurrent()
      else if (action === 'open-project') void openProject()
      else if (action === 'import-effects') {
        if (saving) return
        const input = $<HTMLInputElement>('[data-effects-input]')
        input.value = ''
        input.click()
      } else if (action === 'import-texture') {
        if (saving) return
        if (projectDirectory) {
          const input = $<HTMLInputElement>('[data-texture-input]')
          input.value = ''
          input.click()
          return
        }
        saving = true
        root.inert = true
        void pickProjectDirectory()
          .then((directory) => {
            if (destroyed) return
            useProjectDirectory(directory)
            // Directory selection consumes activation; the file picker needs a fresh click.
            flash('Project folder selected. Click Browse again to choose textures.')
          })
          .catch((error: unknown) => {
            if (!destroyed && !(error instanceof Error && error.name === 'AbortError'))
              flash(
                error instanceof Error ? error.message : 'Could not select project folder.',
                true,
              )
          })
          .finally(() => {
            saving = false
            if (!destroyed) root.inert = false
          })
      } else if (action === 'new')
        openNameModal('Create Quarks effect', 'New Effect', (name) => name && addNewEffect(name))
      else if (action === 'duplicate') {
        const effect = currentEffect()
        if (effect)
          openNameModal(
            'Duplicate effect',
            `${displayName(effect)} Copy`,
            (name) => name && addNewEffect(name, effect),
          )
      } else if (action === 'add-system' || action === 'duplicate-system') {
        const group = currentGroup
        if (!group) return
        recordHistory()
        const emitter =
          action === 'add-system'
            ? newNativeSystem().emitter
            : (currentEmitter()?.clone() as EmitterObject | undefined)
        if (emitter) {
          emitter.name = 'Particle System'
          group.add(emitter)
          systemIndex = emitters(group).length - 1
          syncEffect()
          markDirty()
          renderSystems()
          resetPreview()
          renderInspector()
        }
      } else if (action === 'remove-system') {
        const emitter = currentEmitter()
        if (!emitter || emitters().length <= 1) return
        syncEffect()
        const effect = currentEffect()!
        const removed = new Set<string>()
        emitter.traverse((child) => removed.add(child.uuid))
        if (
          emitterNodes(nativeRoot(effect.json)).some((node) =>
            behaviorSlots(node).some((slot) => removed.has(String(slot.value.subParticleSystem))),
          )
        ) {
          flash('Remove sub emitter references to this system before deleting it.', true)
          return
        }
        recordHistory()
        emitter.system.dispose()
        emitter.parent?.remove(emitter)
        systemIndex = Math.max(0, systemIndex - 1)
        syncEffect()
        markDirty()
        renderSystems()
        resetPreview()
        renderInspector()
      } else if (action === 'move-system-up' || action === 'move-system-down') {
        const emitter = currentEmitter()
        const parent = emitter?.parent
        if (!emitter || !parent) return
        const index = parent.children.indexOf(emitter)
        const next = index + (action === 'move-system-up' ? -1 : 1)
        if (next < 0 || next >= parent.children.length) return
        recordHistory()
        parent.children.splice(index, 1)
        parent.children.splice(next, 0, emitter)
        systemIndex = emitters().indexOf(emitter)
        syncEffect()
        markDirty()
        renderSystems()
        renderInspector()
      } else if (action === 'play') {
        if (elapsed >= previewDuration) resetPreview()
        playing = !playing
        drawTransport()
      } else if (action === 'restart') {
        resetPreview()
        playing = true
        drawTransport()
      } else if (action === 'step') {
        playing = false
        if (simulate(1 / 30)) elapsed = Math.min(previewDuration, elapsed + 1 / 30)
        drawTransport()
      } else if (action === 'frame') {
        controls.target.set(0, 1, 0)
        camera.position.set(8, 6, 10)
        controls.update()
      } else if (action === 'grid') {
        showGrid = !showGrid
        grid.visible = showGrid
      } else if (action === 'enable-curve') {
        const system = currentEmitter()?.system
        if (system) {
          recordHistory()
          system.behaviors.push(
            new SizeOverLife(
              linearCurve([
                [0, 0.2],
                [0.4, 1],
                [1, 0],
              ]),
            ),
          )
          markEdit()
          renderInspector()
        }
      } else if (action === 'enable-color') {
        const system = currentEmitter()?.system
        if (!system) return
        recordHistory()
        const color = colorOf(system)
        setColorGradient(
          system,
          [
            [0, color[0], color[1], color[2]],
            [1, color[0], color[1], color[2]],
          ],
          [
            [0, color[3]],
            [1, 0],
          ],
        )
        markEdit()
        renderInspector()
      } else if (action === 'enable-frame') {
        const system = currentEmitter()?.system
        if (!system) return
        recordHistory()
        setFrameRange(system, 0, system.uTileCount * system.vTileCount)
        markEdit()
        renderInspector()
      } else if (action === 'apply-json') {
        const effect = currentEffect()
        const input = $<HTMLTextAreaElement>('[data-native-json]')
        if (!effect) return
        try {
          const json = parseQuarksDocument(JSON.parse(input.value))
          validateImportedDocument(json)
          recordHistory()
          releasePreview()
          effect.json = json
          systemIndex = Math.min(systemIndex, emitterNodes(nativeRoot(json)).length - 1)
          markDirty()
          renderEffects()
          renderSystems()
          resetPreview()
          renderInspector()
        } catch (error) {
          flash(error instanceof Error ? error.message : 'Invalid Quarks JSON', true)
        }
      } else if (action === 'delete-effect') {
        const effect = currentEffect()
        if (!effect || isBuiltIn(effect.id) || !window.confirm(`Delete "${displayName(effect)}"?`))
          return
        void deleteCurrent(effect)
      } else if (action === 'reset-effect') {
        const effect = currentEffect()
        const preset = effect && defaults.get(effect.id)
        if (!effect || !preset) return
        if (!window.confirm('Discard changes and restore the project default?')) return
        void resetCurrent(effect, preset)
      }
    },
    { signal: events.signal },
  )

  async function resetCurrent(effect: EffectFile, preset: EffectFile): Promise<void> {
    if (saving || !options.deleteEffect) return
    saving = true
    root.inert = true
    try {
      await options.deleteEffect(effect.id)
      if (destroyed) return
      releasePreview()
      effects = effects.map((item) => (item.id === effect.id ? structuredClone(preset) : item))
      savedEffects.set(effect.id, structuredClone(preset))
      setSaved()
      renderEffects()
      renderSystems()
      resetPreview()
      renderInspector()
      flash('Project default restored')
    } catch (error) {
      if (!destroyed) flash(error instanceof Error ? error.message : 'Reset failed', true)
    } finally {
      saving = false
      if (!destroyed) root.inert = false
    }
  }

  async function deleteCurrent(effect: EffectFile): Promise<void> {
    if (saving) return
    saving = true
    root.inert = true
    try {
      const next = effects.find((item) => item.id !== effect.id)
      if (currentId === effect.id && next && unloadedEffects.has(next.id)) {
        await showLoading(`Loading ${displayName(next)}…`)
        const json = await loadFolderEffect(next, projectDirectory!)
        if (destroyed) return
        next.json = json
        unloadedEffects.delete(next.id)
      }
      if (savedIds.has(effect.id) && !projectDirectory) {
        if (!options.deleteEffect) throw new Error('This project has no delete handler')
        await options.deleteEffect(effect.id)
      }
      if (destroyed) return
      if (projectDirectory) {
        const filename = projectFiles.get(effect.id)
        if (filename) deletedProjectFiles.add(filename)
        projectFiles.delete(effect.id)
      }
      effects = effects.filter((item) => item.id !== effect.id)
      unloadedEffects.delete(effect.id)
      savedIds.delete(effect.id)
      savedEffects.delete(effect.id)
      if (currentEffect() === effect || currentId === effect.id) {
        releasePreview()
        currentId = effects[0]?.id ?? ''
        systemIndex = 0
        undoStack.length = 0
        redoStack.length = 0
        if (!projectDirectory && options.saveEffect) setSaved()
        resetPreview()
      }
      if (projectDirectory || !options.saveEffect) markDirty()
      renderEffects()
      renderSystems()
      renderInspector()
    } catch (error) {
      if (!destroyed) flash(error instanceof Error ? error.message : 'Delete failed', true)
    } finally {
      saving = false
      hideLoading()
      if (!destroyed) root.inert = false
    }
  }

  root.addEventListener(
    'input',
    (event) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (target.dataset.bind) writeBound(target)
        else if (target.matches('[data-timeline]')) {
          playing = false
          const next = (Number(target.value) / 1000) * previewDuration
          resetPreview()
          for (let i = 0; i < Math.ceil(next * 60); i++) {
            if (!simulate(Math.min(1 / 60, next - i / 60))) break
          }
          elapsed = next
          drawTransport()
        } else if (target.matches('[data-search]')) renderEffects()
      }
    },
    { signal: events.signal },
  )

  root.addEventListener(
    'change',
    (event) => {
      const target = event.target as HTMLInputElement
      if (target.dataset.systemEnabled !== undefined) {
        const emitter = emitters()[Number(target.dataset.systemEnabled)]
        if (!emitter) return
        recordHistory()
        emitter.visible = target.checked
        markEdit()
        return
      }
      if (target.dataset.addBehavior !== undefined && target.value) {
        const system = currentEmitter()?.system
        if (system)
          commitNativeEdit((node) => {
            const slots = behaviorSlots(node)
            slots.push({ enabled: true, value: newBehavior(target.value, system) })
            writeBehaviorSlots(node, slots)
          })
        return
      }
      if (target.dataset.nativePath || target.dataset.nativeAction) {
        nativeAction(target)
        return
      }
      if (event.target instanceof HTMLSelectElement && event.target.dataset.bind) renderInspector()
    },
    { signal: events.signal },
  )
  root.addEventListener(
    'focusin',
    (event) => {
      const target = event.target as HTMLElement
      if (target.dataset.bind) recordHistory()
    },
    { signal: events.signal },
  )
  $<HTMLInputElement>('[data-geometry-input]').addEventListener(
    'change',
    (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      if (file.size > 64 * 1024 * 1024) {
        flash('Geometry JSON must not exceed 64 MB.', true)
        return
      }
      void file
        .text()
        .then((text) => {
          if (destroyed) return
          const value = JSON.parse(text) as NativeRecord
          const source = (
            Array.isArray(value.geometries) ? value.geometries[0] : value
          ) as NativeRecord
          if (source.url !== undefined)
            throw new Error(
              'Choose the mesh asset JSON itself, or use Open project to resolve external meshes.',
            )
          validateNative(source)
          // Imported geometry is a new document resource, even if its source has an existing UUID.
          const geometries = new THREE.ObjectLoader().parseGeometries([
            { ...source, uuid: THREE.MathUtils.generateUUID() },
          ])
          const geometry = Object.values(geometries)[0]
          if (!geometry) throw new Error('Choose a Three.js geometry JSON document.')
          addGeometry(geometry)
        })
        .catch((error: unknown) => {
          if (!destroyed)
            flash(error instanceof Error ? error.message : 'Invalid geometry JSON', true)
        })
    },
    { signal: events.signal },
  )

  $<HTMLInputElement>('[data-effects-input]').addEventListener(
    'change',
    (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (file) void importEffects(file)
    },
    { signal: events.signal },
  )

  $<HTMLInputElement>('[data-texture-input]').addEventListener(
    'change',
    (event) => {
      void importTextures(Array.from((event.target as HTMLInputElement).files ?? []))
    },
    { signal: events.signal },
  )

  root.addEventListener(
    'dragover',
    (event) => {
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    },
    { signal: events.signal },
  )
  root.addEventListener(
    'drop',
    (event) => {
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      const packages = files.filter((file) => /\.(unitypackage|zip)$/i.test(file.name))
      if (packages.length) {
        if (files.length !== 1)
          flash('Drop one project ZIP or UnityPackage at a time, without other files.', true)
        else void importEffects(packages[0]!)
        return
      }
      const documents = files.filter((file) => /\.json$/i.test(file.name))
      if (documents.length > 1) {
        flash('Open one JSON document at a time. Multiple textures can be imported together.', true)
        return
      }
      void (async () => {
        await importTextures(files.filter((file) => !/\.json$/i.test(file.name)))
        if (!destroyed && documents[0]) await importFile(documents[0])
      })()
    },
    { signal: events.signal },
  )
  root.addEventListener(
    'toggle',
    (event) => {
      const module = event.target as HTMLDetailsElement
      const title = module.dataset.module
      if (!title || module.isConnected === false) return
      if (module.open) collapsedModules.delete(title)
      else collapsedModules.add(title)
    },
    { capture: true, signal: events.signal },
  )

  root.addEventListener(
    'keydown',
    (event) => {
      if (propertyEditor) return
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'o') {
        event.preventDefault()
        void openProject()
      } else if ((event.metaKey || event.ctrlKey) && key === 's') {
        event.preventDefault()
        void saveCurrent()
      } else if ((event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) travelHistory(redoStack, undoStack)
        else travelHistory(undoStack, redoStack)
      } else if ((event.metaKey || event.ctrlKey) && key === 'y') {
        event.preventDefault()
        travelHistory(redoStack, undoStack)
      } else if (event.code === 'Space' && !typing) {
        event.preventDefault()
        $<HTMLButtonElement>('[data-action="play"]').click()
      } else if (key === 'r' && !typing) {
        resetPreview()
        playing = true
      } else if (key === 'f' && !typing) {
        $<HTMLButtonElement>('[data-action="frame"]').click()
      }
    },
    { signal: events.signal },
  )

  async function initialize(): Promise<void> {
    try {
      setLoading('Loading project…')
      const [stored, textureResponse] = await Promise.all([
        options.listEffects?.() ?? [],
        options.listTextures?.() ?? [],
      ])
      if (destroyed) return
      for (const texture of textureResponse) {
        if (textures.has(texture.id)) throw new Error(`Duplicate texture id: ${texture.id}`)
        textureUrlSchema.parse(texture.url)
        textures.set(texture.id, texture.url)
      }
      for (const [index, saved] of stored.entries()) {
        if (index % 25 === 24) await showLoading('Reading effects', index + 1, stored.length)
        if (savedIds.has(saved.id)) throw new Error(`Duplicate effect id: ${saved.id}`)
        const json = parseQuarksDocument(structuredClone(saved.json))
        prepareNativeDocument(json)
        validateSubEmitters(json)
        if (saved.defaultJson) {
          const json = parseQuarksDocument(structuredClone(saved.defaultJson))
          prepareNativeDocument(json)
          validateSubEmitters(json)
          defaults.set(saved.id, { id: saved.id, json })
        }
        const effect = { id: saved.id, json }
        effects.push(structuredClone(effect))
        savedEffects.set(saved.id, structuredClone(effect))
        savedIds.add(saved.id)
      }
      currentId = effects[0]?.id ?? ''
      setupPreview()
      renderEffects()
      renderTextures()
      renderSystems()
      resetPreview()
      renderInspector()
      startAnimation()
      root.inert = false
    } catch (error) {
      if (!destroyed)
        flash(
          error instanceof Error ? error.message : 'Could not load native Quarks documents',
          true,
        )
      throw error
    } finally {
      hideLoading()
    }
  }

  window.addEventListener(
    'beforeunload',
    (event) => {
      if (dirty || saving) {
        event.preventDefault()
        event.returnValue = ''
      }
    },
    { signal: events.signal },
  )

  return {
    ready: initialize(),
    hasUnsavedChanges: () => dirty,
    destroy() {
      if (destroyed) return
      destroyed = true
      events.abort()
      window.cancelAnimationFrame(frameRequest)
      frameRequest = 0
      window.clearTimeout(previewTimer)
      window.clearTimeout(toastTimer)
      resize?.disconnect()
      textureObserver.disconnect()
      visibleTexturePreviews.clear()
      texturePreviewLoads.clear()
      releasePreview()
      if (transformControls) {
        scene.remove(transformControls.getHelper())
        transformControls.dispose()
      }
      if (scene) disposeObjects(scene)
      controls?.dispose()
      renderer?.dispose()
      depthTarget?.dispose()
      host.remove()
    },
  }
}
