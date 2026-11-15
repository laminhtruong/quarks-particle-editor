import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
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
import { readTextureFile, resolveLocalTextures } from './local-files.js'
import { readUnityPackage } from './unity-package.js'
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
export type { UnityPackage, UnityPrefabImport } from './unity-package.js'

export interface ParticleEffect {
  id: string
  json: QuarksDocument
  /** Optional project-owned default: protects deletion and enables reset. */
  defaultJson?: QuarksDocument
}

export interface ParticleTexture {
  id: string
  /** URL stored in exported JSON; resolved relative to the host page for preview. */
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
      <div class="top-actions"><button class="btn" type="button" data-action="import" title="Open a native Quarks JSON file (Ctrl+O)">Open JSON</button><button class="btn" type="button" data-action="import-unity">Import Unity Package</button><button class="btn" type="button" data-action="import-texture">Import Textures</button><button class="btn ghost" type="button" data-action="undo" title="Undo (Ctrl+Z)" disabled>Undo</button><button class="btn ghost" type="button" data-action="redo" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button><span class="save-state" data-save-state>No unsaved changes</span><button class="btn" type="button" data-action="export">Export JSON</button><button class="btn primary" type="button" data-action="save">${options.saveEffect ? 'Save to Project' : 'Download JSON'}</button></div>
    </header>
    <main class="workspace">
      <aside class="left-panel">
        <div class="panel-tab">Hierarchy</div>
        <section class="panel-block">
          <div class="section-title"><span>Hierarchy</span><span class="count" data-system-count>00</span></div>
          <div data-system-list></div>
          <div class="system-actions"><button class="btn small" type="button" data-action="add-system">+ Add</button><button class="btn small" type="button" data-action="duplicate-system" title="Duplicate selected system">Copy</button><button class="btn small" type="button" data-action="move-system-up" title="Move system up">Up</button><button class="btn small" type="button" data-action="move-system-down" title="Move system down">Down</button><button class="btn small danger" type="button" data-action="remove-system" title="Remove selected system">-</button></div>
        </section>
        <section class="panel-block"><div class="hint">Open a JSON file or create a particle system to begin.<br><br>Space: Play / Pause<br>R: Restart &nbsp; F: Frame selected<br>Ctrl+O: Open &nbsp; Ctrl+S: Save / Download<br>Drag: Orbit &nbsp; Scroll: Zoom</div></section>
      </aside>
      <section class="stage">
        <div class="panel-tab">Scene <span class="hint">Perspective \u{b7} Quarks runtime</span></div>
        <div class="viewport">
          <canvas id="vfx-canvas" aria-label="Particle effect preview"></canvas>
          <div class="viewport-label"><strong>Particle Effect</strong><span>Drop JSON, a .unitypackage, or textures here</span></div>
          <div class="viewport-actions"><button class="btn" type="button" data-action="frame">Frame</button><button class="btn" type="button" data-action="grid">Grid</button></div>
        </div>
        <div class="timeline">
          <div class="transport"><button class="btn" type="button" data-action="restart" title="Restart (R)">Restart</button><button class="btn primary" type="button" data-action="play" title="Play / pause (Space)" data-play>Play</button><button class="btn" type="button" data-action="step" title="Step frame">Step</button><div class="time-readout"><span data-time>0.00</span> <span>/</span> <span data-duration>0.00 s</span></div></div>
          <div class="timeline-track"><div class="timeline-progress" data-progress></div><div class="timeline-knob" data-knob></div><div class="timeline-ticks"><span>0s</span><span>25%</span><span>50%</span><span>75%</span><span data-end-tick>1s</span></div><input class="timeline-input" type="range" min="0" max="1000" value="0" aria-label="Preview timeline" data-timeline></div>
        </div>
        <section class="project-panel" aria-label="Project assets">
          <div class="panel-tab">Project <span class="hint">Local session \u{b7} files stay in your browser</span></div>
          <div class="project-toolbar"><input class="search" type="search" placeholder="Search effects" aria-label="Search effects" data-search><button class="btn small" type="button" data-action="new">+ New effect</button><button class="btn small" type="button" data-action="duplicate" title="Duplicate selected effect">Duplicate</button></div>
          <div class="project-columns"><section><div class="section-title"><span>Effects</span><span data-effect-count>00</span></div><div class="effect-list" data-effect-list></div><details class="unity-import-report" data-unity-report hidden><summary>Unity import report</summary><pre data-unity-report-text></pre></details></section><section><div class="section-title"><span>Textures</span><button class="btn small" type="button" data-action="import-texture">+ Browse</button></div><div class="texture-list" data-texture-list></div></section></div>
        </section>
      </section>
      <aside class="right-panel" data-inspector></aside>
    </main>
  </div>
  <input type="file" accept="application/json,.json" hidden data-file-input>
  <input type="file" accept=".unitypackage" hidden data-unity-input>
  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" multiple hidden data-texture-input>
  <input type="file" accept="application/json,.json" hidden data-geometry-input>
  <div class="toast" role="status" aria-live="polite" hidden></div>
`

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
  const defaults = new Map<string, EffectFile>()
  const savedEffects = new Map<string, EffectFile>()
  let effects: EffectFile[] = []
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
  let batch: BatchedRenderer
  let grid: THREE.GridHelper
  let resize: ResizeObserver | undefined
  let depthTarget: THREE.WebGLRenderTarget
  let pendingSize: { width: number; height: number } | undefined
  const undoStack: EffectFile[] = []
  const redoStack: EffectFile[] = []
  const collapsedModules = new Set<string>()
  let colorEditor: { path: NativePath; type: 'color' | 'gradient'; value: NativeRecord } | undefined

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

  function editorColorHex(color: NativeRecord): string {
    return asHex(['r', 'g', 'b'].map((key) => Number(color[key] ?? 0)))
  }

  function editorRgba(color: NativeRecord): string {
    return `rgba(${['r', 'g', 'b'].map((key) => Math.round(Math.max(0, Math.min(1, Number(color[key] ?? 0))) * 255)).join(',')},${Math.max(0, Math.min(1, Number(color.a ?? 1)))})`
  }

  function editorGradientCss(value: NativeRecord): string {
    const color = value.color as NativeRecord
    const alpha = value.alpha as NativeRecord
    const colors = (color.keys ?? []) as NativeRecord[]
    const alphas = (alpha.keys ?? []) as NativeRecord[]
    const alphaAt = (pos: number) => {
      const next = alphas.findIndex((key) => Number(key.pos) >= pos)
      if (next <= 0) return Number(alphas[Math.max(0, next)]?.value ?? 1)
      if (next < 0) return Number(alphas.at(-1)?.value ?? 1)
      const before = alphas[next - 1]!
      const after = alphas[next]!
      const span = Number(after.pos) - Number(before.pos)
      return (
        Number(before.value) +
        (Number(after.value) - Number(before.value)) *
          (span ? (pos - Number(before.pos)) / span : 0)
      )
    }
    return `linear-gradient(90deg,${
      colors
        .map((key) => {
          const rgb = key.value as NativeRecord
          return `rgba(${['r', 'g', 'b'].map((channel) => Math.round(Math.max(0, Math.min(1, Number(rgb[channel] ?? 0))) * 255)).join(',')},${Math.max(0, Math.min(1, alphaAt(Number(key.pos))))}) ${Math.max(0, Math.min(1, Number(key.pos))) * 100}%`
        })
        .join(',') || 'transparent,transparent'
    })`
  }

  function colorEditorMarkup(): string {
    if (!colorEditor) return ''
    const { type, value } = colorEditor
    const contents =
      type === 'color'
        ? `<div class="color-editor-picker"><input type="color" value="${editorColorHex(value)}" aria-label="Color" data-editor-color="hex"><div class="color-editor-sample" style="--swatch:${editorRgba(value)}" role="img" aria-label="Color with alpha preview"></div><div class="color-editor-channels">${['r', 'g', 'b'].map((channel) => `<label>${channel.toUpperCase()}<input type="number" min="0" max="255" step="1" value="${Math.round(Math.max(0, Math.min(1, Number(value[channel] ?? 0))) * 255)}" data-editor-color="${channel}"></label>`).join('')}<label>A<input type="number" min="0" max="255" step="1" value="${Math.round(Math.max(0, Math.min(1, Number(value.a ?? 1))) * 255)}" data-editor-color="alpha"></label></div><label class="color-editor-alpha">Alpha<input type="range" min="0" max="255" step="1" value="${Math.round(Math.max(0, Math.min(1, Number(value.a ?? 1))) * 255)}" data-editor-color="alpha"></label></div>`
        : `<div class="gradient-editor-preview" style="background:${editorGradientCss(value)}"></div><section class="gradient-editor-section"><header><strong>Color</strong><button class="btn small" type="button" data-native-action="gradient-add" data-editor-part="color">+ Key</button></header>${((value.color as NativeRecord).keys as NativeRecord[]).map((key, index) => `<div class="gradient-editor-row"><input type="number" min="0" max="1" step="0.01" value="${num(Number(key.pos), 3)}" aria-label="Color key position" data-editor-stop="color" data-editor-index="${index}" data-editor-field="pos"><input type="color" value="${editorColorHex(key.value as NativeRecord)}" aria-label="Color key color" data-editor-stop="color" data-editor-index="${index}" data-editor-field="color"><button class="btn small danger" type="button" aria-label="Remove color key" data-native-action="gradient-remove" data-editor-part="color" data-editor-index="${index}" ${((value.color as NativeRecord).keys as NativeRecord[]).length <= 2 ? 'disabled' : ''}>&times;</button></div>`).join('')}</section><section class="gradient-editor-section"><header><strong>Alpha</strong><button class="btn small" type="button" data-native-action="gradient-add" data-editor-part="alpha">+ Key</button></header>${((value.alpha as NativeRecord).keys as NativeRecord[]).map((key, index) => `<div class="gradient-editor-row"><input type="number" min="0" max="1" step="0.01" value="${num(Number(key.pos), 3)}" aria-label="Alpha key position" data-editor-stop="alpha" data-editor-index="${index}" data-editor-field="pos"><input type="number" min="0" max="1" step="0.01" value="${num(Number(key.value), 3)}" aria-label="Alpha value" data-editor-stop="alpha" data-editor-index="${index}" data-editor-field="value"><button class="btn small danger" type="button" aria-label="Remove alpha key" data-native-action="gradient-remove" data-editor-part="alpha" data-editor-index="${index}" ${((value.alpha as NativeRecord).keys as NativeRecord[]).length <= 2 ? 'disabled' : ''}>&times;</button></div>`).join('')}</section>`
    return `<dialog class="color-editor-dialog"><header><strong>${type === 'color' ? 'Color' : 'Gradient'}</strong><button class="btn small" type="button" aria-label="Close" data-native-action="color-editor-cancel">&times;</button></header><div class="color-editor-body">${contents}</div><footer><button class="btn" type="button" data-native-action="color-editor-cancel">Cancel</button><button class="btn primary" type="button" data-native-action="color-editor-apply">Apply</button></footer></dialog>`
  }

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

  function updateHistoryButtons(): void {
    $<HTMLButtonElement>('[data-action="undo"]').disabled = undoStack.length === 0
    $<HTMLButtonElement>('[data-action="redo"]').disabled = redoStack.length === 0
  }

  function syncEffect(): void {
    const effect = currentEffect()
    if (!effect || !currentGroup) return
    nativeRoot(effect.json).name = currentGroup.name || effect.id
    currentGroup.updateMatrixWorld(true)
    effect.json = serializeGroup(currentGroup)
  }

  function recordHistory(): void {
    syncEffect()
    const effect = currentEffect()
    if (!effect) return
    undoStack.push(structuredClone(effect))
    if (undoStack.length > 100) undoStack.shift()
    redoStack.length = 0
    updateHistoryButtons()
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
    updateHistoryButtons()
  }

  function isBuiltIn(id: string): boolean {
    return defaults.has(id)
  }

  function renderEffects(): void {
    const query = $<HTMLInputElement>('[data-search]').value.trim().toLowerCase()
    const visible = effects.filter((effect) =>
      `${displayName(effect)} ${effect.id}`.toLowerCase().includes(query),
    )
    $('[data-effect-count]').textContent = String(effects.length).padStart(2, '0')
    effectList.innerHTML = visible.length
      ? visible
          .map(
            (effect) => `
    <button class="effect-item${effect.id === currentId ? ' active' : ''}" type="button" data-effect="${esc(effect.id)}"><span class="effect-icon">\u{2733}</span><span><span class="effect-name">${esc(displayName(effect))}</span><span class="effect-meta">${esc(effect.id)} \u{b7} ${emitterNodes(nativeRoot(effect.json)).length} systems</span></span>${savedIds.has(effect.id) ? '<span class="saved-dot" title="Saved to project"></span>' : ''}</button>`,
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
    systemList.innerHTML = `<div class="hierarchy-row"><span>\u{2304}</span><span class="tree-icon">\u{2733}</span><strong>${esc(displayName(effect))}</strong><span class="row-meta">GROUP</span></div>${nodes.map((node, index) => `<div class="hierarchy-row${index === systemIndex ? ' active' : ''}"><input type="checkbox" data-system-enabled="${index}" aria-label="Enable ${esc(node.name || `Particle System ${index + 1}`)}" title="Show in preview and include in exported JSON"${node.visible !== false ? ' checked' : ''}><button class="system-select" type="button" data-system="${index}"><span class="tree-icon">\u{25a7}</span><span>${esc(node.name || `Particle System ${index + 1}`)}</span><span class="row-meta">${index + 1}</span></button></div>`).join('')}`
  }

  function colorOf(system: ParticleSystem): [number, number, number, number] {
    const color = (system.startColor as unknown as { color?: QVector4 }).color
    return color ? [color.x, color.y, color.z, color.w] : [1, 1, 1, 1]
  }

  function colorStops(
    system: ParticleSystem,
  ): { colors: [number, number, number, number][]; alphas: [number, number][] } | undefined {
    const behavior = system.behaviors.find((item) => item.type === 'ColorOverLife') as
      ColorOverLife | undefined
    if (!behavior || !(behavior.color instanceof Gradient)) return undefined
    return {
      colors: behavior.color.color.keys.map(([value, time]) => [time, value.x, value.y, value.z]),
      alphas: behavior.color.alpha.keys.map(([value, time]) => [time, value]),
    }
  }

  function sizeCurve(system: ParticleSystem): [number, number][] | undefined {
    const behavior = system.behaviors.find((item) => item.type === 'SizeOverLife') as
      SizeOverLife | undefined
    const curve = behavior?.size as unknown as
      { functions?: Array<[{ p: number[] }, number]> } | undefined
    const segments = curve?.functions
    if (!segments?.length) return undefined
    const points = segments.map(([bezier, time]) => [time, bezier.p[0] ?? 1] as [number, number])
    const last = segments.at(-1)?.[0]
    points.push([1, last?.p[3] ?? 1])
    return points
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
      renderEffects()
      renderSystems()
      renderInspector()
      updateHistoryButtons()
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
    if (action === 'edit-color' || action === 'edit-gradient') {
      const effect = currentEffect()
      if (!effect) return
      const value = getNativeValue(
        { ...nativeNode(effect.json, systemIndex), document: effect.json },
        path,
      )
      if (!value || typeof value !== 'object') return
      colorEditor = {
        path,
        type: action === 'edit-color' ? 'color' : 'gradient',
        value: structuredClone(value as NativeRecord),
      }
      renderInspector()
      return
    }
    if (action === 'color-editor-cancel') {
      colorEditor = undefined
      renderInspector()
      return
    }
    if (action === 'gradient-add' || action === 'gradient-remove') {
      if (colorEditor?.type !== 'gradient') return
      const part = target.dataset.editorPart === 'alpha' ? 'alpha' : 'color'
      const keys = ((colorEditor.value[part] as NativeRecord).keys ?? []) as NativeRecord[]
      if (action === 'gradient-remove') {
        if (keys.length > 2) keys.splice(Number(target.dataset.editorIndex), 1)
      } else {
        let start = 0
        let span = 0
        for (let index = 0; index < keys.length; index++) {
          const gap = Number(keys[index + 1]?.pos ?? 1) - Number(keys[index]!.pos)
          if (gap > span) {
            start = index
            span = gap
          }
        }
        if (span <= 0.001) return
        const source = keys[start]!
        const key = {
          ...structuredClone(source),
          pos: (Number(source.pos) + Number(keys[start + 1]?.pos ?? 1)) / 2,
        }
        keys.splice(start + 1, 0, key)
      }
      renderInspector()
      return
    }
    if (action === 'color-editor-apply') {
      if (!colorEditor) return
      const editor = colorEditor
      colorEditor = undefined
      if (editor.type === 'gradient') {
        for (const part of ['color', 'alpha'])
          ((editor.value[part] as NativeRecord).keys as NativeRecord[]).sort(
            (a, b) => Number(a.pos) - Number(b.pos),
          )
      }
      commitNativeEdit((node, json) =>
        setNativeValue({ ...node, document: json }, editor.path, editor.value),
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

  function renderColorStops(system: ParticleSystem): string {
    const stops = colorStops(system)
    if (!stops && system.behaviors.some((behavior) => behavior.type === 'ColorOverLife'))
      return '<p class="hint">Edit this color generator in the Behaviors module.</p>'
    if (!stops)
      return '<button class="btn small" type="button" data-action="enable-color">+ Add color over life</button>'
    const colors = stops.colors
      .map(
        ([time, r, g, b], index) =>
          `<div class="color-stop"><input type="number" min="0" max="1" step="0.01" value="${num(time, 3)}" aria-label="Color stop time" data-color-stop="${index}" data-color-part="time"><input type="color" value="${asHex([r, g, b])}" aria-label="Color stop color" data-color-stop="${index}" data-color-part="color"><button class="btn small danger" type="button" data-action="remove-color" data-index="${index}" title="Remove key">&times;</button></div>`,
      )
      .join('')
    const alphas = stops.alphas
      .map(
        ([time, value], index) =>
          `<div class="color-stop"><input type="number" min="0" max="1" step="0.01" value="${num(time, 3)}" aria-label="Alpha stop time" data-alpha-stop="${index}" data-alpha-part="time"><input type="number" min="0" max="1" step="0.01" value="${num(value, 3)}" aria-label="Alpha" data-alpha-stop="${index}" data-alpha-part="value"><button class="btn small danger" type="button" data-action="remove-alpha" data-index="${index}" title="Remove key">&times;</button></div>`,
      )
      .join('')
    return `<div class="asset-heading"><span>COLOR KEYS \u{b7} T / RGB</span><button class="btn small" type="button" data-action="add-color">+ Key</button></div>${colors}<div class="asset-heading" style="margin-top:12px"><span>ALPHA KEYS \u{b7} T / VALUE</span><button class="btn small" type="button" data-action="add-alpha">+ Key</button></div>${alphas}`
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
        '<div class="panel-tab">Inspector</div><div class="empty-list">Select or create a Quarks effect.<br><br>Open JSON to edit a local file, or import textures and create a new effect. No account or backend required.</div>'
      return
    }
    syncEffect()
    const node = nativeNode(effect.json, systemIndex)
    const ps = node.ps as NativeRecord
    const context = propertyContext(effect.json)
    const material = materialOf(system)
    const effectRotation = rootRotation(effect)
    const curve = sizeCurve(system)
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
    <section class="inspect-section"><h3>Size over lifetime</h3>${curve ? '<div class="curve-box"><svg viewBox="0 0 100 100" preserveAspectRatio="none" data-curve></svg><span class="curve-label">0 \u{2192} LIFE \u{2192} 100%</span></div><div class="curve-tools"><span>Quarks PiecewiseBezier</span><div><button class="btn" type="button" data-action="add-curve-key">+ Key</button> <button class="btn" type="button" data-action="remove-curve-key">- Key</button></div></div>' : '<button class="btn small" type="button" data-action="enable-curve">+ Add SizeOverLife</button>'}</section>
    <section class="inspect-section"><h3>Color over lifetime</h3>${renderColorStops(system)}</section>
    <section class="inspect-section"><h3>Texture sheet</h3>${renderProperties(ps, ['uTileCount', 'vTileCount', 'startTileIndex', 'blendTiles'], context)}<p class="hint">Add Frame Over Life in Behaviors to animate frames.</p></section>
    <section class="inspect-section"><details class="native-json"><summary>Native Quarks JSON</summary><textarea spellcheck="false" aria-label="Native Quarks JSON" data-native-json>${esc(JSON.stringify(effect.json, null, 2))}</textarea><button class="btn small" type="button" data-action="apply-json">Apply document</button></details></section>
    <section class="inspect-section"><button class="btn danger small" type="button" data-action="delete-effect" ${isBuiltIn(effect.id) || (savedIds.has(effect.id) && !options.deleteEffect) ? 'disabled' : ''}>Delete effect</button>${isBuiltIn(effect.id) && options.deleteEffect ? '<button class="btn small" type="button" data-action="reset-effect">Reset to project default</button>' : ''}</section>${colorEditorMarkup()}`
    inspector.innerHTML = markup.replace(
      /<section class="inspect-section"><h3>([^<]+)<\/h3>([\s\S]*?)<\/section>/g,
      (_match, title: string, content: string) =>
        `<details class="particle-module" data-module="${esc(title)}" ${collapsedModules.has(title) ? '' : 'open'}><summary>${esc(title)}</summary><div class="module-body">${content}</div></details>`,
    )
    if (curve) drawCurve($<SVGSVGElement>('[data-curve]'), curve)
    if (colorEditor) {
      const dialog = inspector.querySelector<HTMLDialogElement>('.color-editor-dialog')
      dialog?.addEventListener('cancel', () => (colorEditor = undefined), { once: true })
      dialog?.showModal()
    }
  }

  function renderTextures(): void {
    $('[data-texture-list]').innerHTML = textures.size
      ? [...textures]
          .map(
            ([id, url]) =>
              `<button class="texture-item" type="button" data-texture="${esc(id)}" title="Assign ${esc(id)} to selected particle system"><img src="${esc(url)}" alt=""><span>${esc(id)}</span></button>`,
          )
          .join('')
      : '<p class="empty-list">No textures. Browse or drop PNG, JPEG, WebP, or GIF files.</p>'
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
    let imported = false
    for (const file of files) {
      if (destroyed) return
      try {
        if (textures.has(file.name))
          throw new Error(
            `A texture named "${file.name}" is already loaded. Rename the file to import another version.`,
          )
        const url = await readTextureFile(file)
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
    if (!imported || destroyed) return
    syncEffect()
    let refresh = false
    for (const effect of effects) {
      if (resolveLocalTextures(effect.json, textures) && effect.id === currentId) refresh = true
    }
    if (refresh) {
      releasePreview()
      resetPreview()
      markDirty()
    }
    renderInspector()
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

  function drawCurve(svg: SVGSVGElement, points: readonly (readonly [number, number])[]): void {
    const d = points
      .map(
        ([time, value], index) =>
          `${index === 0 ? 'M' : 'L'} ${(time * 100).toFixed(2)} ${(90 - value * 45).toFixed(2)}`,
      )
      .join(' ')
    svg.innerHTML = `<path class="curve-path" d="${d}"/>${points.map(([time, value], index) => `<circle class="curve-point" cx="${(time * 100).toFixed(2)}" cy="${(90 - value * 45).toFixed(2)}" r="${index === 0 || index === points.length - 1 ? 3.2 : 4}" data-curve-index="${index}"/>`).join('')}`
  }

  function curveFromSystem(system: ParticleSystem): [number, number][] | undefined {
    const behavior = system.behaviors.find((item) => item.type === 'SizeOverLife') as
      SizeOverLife | undefined
    const data = behavior?.size as unknown as
      { functions?: Array<[{ p: number[] }, number]> } | undefined
    const segments = data?.functions
    if (!segments?.length) return undefined
    const points = segments.map(([bezier, time]) => [time, bezier.p[0] ?? 1] as [number, number])
    points.push([1, segments.at(-1)?.[0].p[3] ?? 1])
    return points
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

  function setSizeCurve(
    system: ParticleSystem,
    points: readonly (readonly [number, number])[],
  ): void {
    const current = system.behaviors.find((item) => item.type === 'SizeOverLife') as
      SizeOverLife | undefined
    if (current) current.size = linearCurve(points)
    else system.behaviors.push(new SizeOverLife(linearCurve(points)))
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
      previewSystems = emitters(currentGroup).map((emitter) => emitter.system)
      previewDuration = particlePreviewDuration(previewSystems)
    }
    elapsed = 0
    renderTransport()
  }

  function releasePreview(): void {
    window.clearTimeout(previewTimer)
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
    scene.add(new THREE.HemisphereLight(0xc4ddff, 0x242130, 1.7))
    const key = new THREE.DirectionalLight(0xffe2b1, 2.2)
    key.position.set(-4, 8, 5)
    scene.add(key)
    grid = new THREE.GridHelper(16, 32, 0x777777, 0x414141)
    grid.position.y = -0.025
    scene.add(grid)
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(8, 64),
      new THREE.MeshBasicMaterial({ color: 0x303030, transparent: true, opacity: 0.4 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.04
    scene.add(floor)
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
    renderEffects()
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
    backdrop.innerHTML = `<form class="modal"><h2>${esc(title)}</h2><p>Creates a native Quarks particle system. Download JSON to keep your work.</p><input name="name" value="${esc(initial)}" maxlength="80" required autocomplete="off" aria-label="Effect name"><div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Create effect</button></div></form>`
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
    if (!effect || !currentGroup || saving) return
    saving = true
    try {
      syncEffect()
      effect.json = parseQuarksDocument(serializeGroup(currentGroup))
      const revision = editRevision
      const snapshot = structuredClone(effect)
      if (options.saveEffect) await options.saveEffect(effect.id, exportDocument(effect.json))
      else exportCurrent()
      if (destroyed) return
      savedEffects.set(effect.id, snapshot)
      if (options.saveEffect) savedIds.add(effect.id)
      if (currentEffect() === effect && editRevision === revision) setSaved()
      renderEffects()
      renderInspector()
      flash(
        `${options.saveEffect ? 'Saved native Quarks JSON' : 'Downloaded JSON (original file unchanged)'}: ${effect.id}.json`,
      )
    } catch (error) {
      if (!destroyed)
        flash(error instanceof Error ? error.message : 'Could not save Quarks document', true)
    } finally {
      saving = false
    }
  }

  function discardCurrentChanges(): boolean {
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

  function selectEffect(id: string): void {
    if (id === currentId || !effects.some((effect) => effect.id === id)) return
    if (!discardCurrentChanges()) return
    releasePreview()
    currentId = id
    systemIndex = 0
    undoStack.length = 0
    redoStack.length = 0
    setSaved()
    updateHistoryButtons()
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
        if (destroyed) return
        importDocument(parseQuarksDocument(JSON.parse(text)), file.name.replace(/\.json$/i, ''))
      })
      .catch((error: unknown) => {
        if (!destroyed) flash(error instanceof Error ? error.message : 'Invalid Quarks JSON', true)
      })
  }

  function importDocument(json: QuarksDocument, fallbackName: string): boolean {
    resolveLocalTextures(json, textures)
    prepareNativeDocument(json)
    validateSubEmitters(json)
    // Validate runtime compatibility before replacing any in-session document.
    const probe = new QuarksLoader().parse(structuredClone(json))
    disposeObjects(probe)
    for (const emitter of emitters(probe)) emitter.system.dispose()
    const name = String(nativeRoot(json).name || fallbackName)
    const id = slug(name)
    const imported = { id, json }
    if (effects.some((effect) => effect.id === id)) {
      if (!window.confirm(`Replace the current "${id}" document with this file?`)) return false
      if (!discardCurrentChanges()) return false
      releasePreview()
      effects = effects.map((effect) => (effect.id === id ? imported : effect))
      currentId = id
      systemIndex = 0
      undoStack.length = 0
      redoStack.length = 0
      updateHistoryButtons()
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

  let importingUnity = false
  async function importUnityFile(file: File): Promise<void> {
    if (importingUnity) {
      flash('Finish or cancel the current Unity package import first.', true)
      return
    }
    importingUnity = true
    let dialog: HTMLDialogElement | undefined
    try {
      flash('Reading Unity package locally…')
      const unity = await readUnityPackage(file)
      if (destroyed) {
        importingUnity = false
        return
      }
      dialog = document.createElement('dialog')
      dialog.className = 'name-dialog'
      dialog.setAttribute('aria-label', 'Import Unity prefab')
      dialog.innerHTML = `<form class="modal"><h2>Import Unity prefab</h2><p>Choose one prefab to convert. Reopen the package to import another. Export from Unity with Include dependencies enabled.</p><label class="field"><span>Prefab (${unity.prefabs.length})</span><select name="prefab" aria-label="Unity prefab">${unity.prefabs.map((path, index) => `<option value="${index}">${esc(path)}</option>`).join('')}</select></label><p>Shuriken text prefabs only. Unsupported features are listed in the import report; Unity shaders cannot be reproduced exactly.</p><p role="status" aria-live="polite" data-unity-status></p><div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Convert &amp; import</button></div></form>`
      const chooser = dialog
      const close = () => {
        chooser.remove()
        importingUnity = false
      }
      chooser.addEventListener(
        'cancel',
        (event) => {
          event.preventDefault()
          close()
        },
        { signal: events.signal },
      )
      chooser
        .querySelector('[data-cancel]')!
        .addEventListener('click', close, { signal: events.signal })
      chooser.querySelector('form')!.addEventListener(
        'submit',
        (event) => {
          event.preventDefault()
          const submit = chooser.querySelector<HTMLButtonElement>('[type="submit"]')!
          if (submit.disabled) return
          const path =
            unity.prefabs[Number(chooser.querySelector<HTMLSelectElement>('select')!.value)]
          if (!path) return
          submit.disabled = true
          const status = chooser.querySelector<HTMLElement>('[data-unity-status]')!
          status.textContent = 'Converting prefab and embedding textures…'
          void unity
            .convertPrefab(path)
            .then((result) => {
              if (destroyed || !chooser.isConnected) return
              if (!importDocument(result.json, path)) {
                status.textContent = 'Import cancelled. Your current effect was kept.'
                return
              }
              const report = $<HTMLDetailsElement>('[data-unity-report]')
              $('[data-unity-report-text]').textContent =
                `${path}\n${result.particleCount} Particle System(s) converted.\n\n${result.warnings.join('\n') || 'No conversion warnings.'}`
              report.hidden = false
              report.open = true
              close()
              flash(
                `Imported ${result.particleCount} Particle System(s). Check the Unity import report, then Download JSON.`,
              )
            })
            .catch((error: unknown) => {
              if (!destroyed && chooser.isConnected)
                status.textContent =
                  error instanceof Error ? error.message : 'Could not convert Unity prefab.'
            })
            .finally(() => {
              submit.disabled = false
            })
        },
        { signal: events.signal },
      )
      root.append(chooser)
      chooser.showModal()
    } catch (error) {
      dialog?.remove()
      importingUnity = false
      if (!destroyed)
        flash(error instanceof Error ? error.message : 'Could not import Unity package.', true)
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
    return parseQuarksDocument(json)
  }

  function exportCurrent(): void {
    const effect = currentEffect()
    if (!effect || !currentGroup) return
    syncEffect()
    const json = exportDocument(effect.json)
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${effect.id}.json`
    link.click()
    URL.revokeObjectURL(url)
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
        assignTexture(target.dataset.texture)
        return
      }
      if (action === 'undo') {
        travelHistory(undoStack, redoStack)
        return
      }
      if (action === 'redo') {
        travelHistory(redoStack, undoStack)
        return
      }
      if (target.dataset.effect) {
        selectEffect(target.dataset.effect)
        return
      }
      if (target.dataset.system !== undefined) {
        systemIndex = Number(target.dataset.system)
        renderSystems()
        renderInspector()
        return
      }
      if (action === 'save') void saveCurrent()
      else if (action === 'import') {
        const input = $<HTMLInputElement>('[data-file-input]')
        input.value = ''
        input.click()
      } else if (action === 'import-unity') {
        const input = $<HTMLInputElement>('[data-unity-input]')
        input.value = ''
        input.click()
      } else if (action === 'import-texture') {
        const input = $<HTMLInputElement>('[data-texture-input]')
        input.value = ''
        input.click()
      } else if (action === 'export') {
        try {
          exportCurrent()
        } catch (error) {
          flash(error instanceof Error ? error.message : 'Could not export JSON', true)
        }
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
          setSizeCurve(system, [
            [0, 0.2],
            [0.4, 1],
            [1, 0],
          ])
          markEdit()
          renderInspector()
        }
      } else if (action === 'add-curve-key' || action === 'remove-curve-key') {
        const system = currentEmitter()?.system
        const points = system && curveFromSystem(system)
        if (!system || !points) return
        recordHistory()
        if (action === 'add-curve-key') {
          points.push([0.5, 0.8])
          points.sort((a, b) => a[0] - b[0])
        } else if (points.length > 2) points.splice(points.length - 2, 1)
        setSizeCurve(system, points)
        markEdit()
        renderInspector()
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
          prepareNativeDocument(json)
          validateSubEmitters(json)
          const probe = new QuarksLoader().parse(structuredClone(json))
          disposeObjects(probe)
          for (const emitter of emitters(probe)) emitter.system.dispose()
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
      } else if (
        action === 'add-color' ||
        action === 'remove-color' ||
        action === 'add-alpha' ||
        action === 'remove-alpha'
      ) {
        const system = currentEmitter()?.system
        const stops = system && colorStops(system)
        if (!system || !stops) return
        recordHistory()
        if (action === 'add-color') stops.colors.push([0.5, 1, 1, 1])
        else if (action === 'remove-color' && stops.colors.length > 2)
          stops.colors.splice(Number(target.dataset.index), 1)
        else if (action === 'add-alpha') stops.alphas.push([0.5, 1])
        else if (stops.alphas.length > 2) stops.alphas.splice(Number(target.dataset.index), 1)
        stops.colors.sort((a, b) => a[0] - b[0])
        stops.alphas.sort((a, b) => a[0] - b[0])
        setColorGradient(system, stops.colors, stops.alphas)
        markEdit()
        renderInspector()
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
      if (savedIds.has(effect.id)) {
        if (!options.deleteEffect) throw new Error('This project has no delete handler')
        await options.deleteEffect(effect.id)
      }
      if (destroyed) return
      effects = effects.filter((item) => item.id !== effect.id)
      savedIds.delete(effect.id)
      savedEffects.delete(effect.id)
      if (currentEffect() === effect || currentId === effect.id) {
        releasePreview()
        currentId = effects[0]?.id ?? ''
        systemIndex = 0
        undoStack.length = 0
        redoStack.length = 0
        setSaved()
        updateHistoryButtons()
        resetPreview()
      }
      renderEffects()
      renderSystems()
      renderInspector()
    } catch (error) {
      if (!destroyed) flash(error instanceof Error ? error.message : 'Delete failed', true)
    } finally {
      saving = false
      if (!destroyed) root.inert = false
    }
  }

  function editCurvePointer(event: PointerEvent, svg: SVGSVGElement): void {
    const point = (event.target as HTMLElement).closest<SVGCircleElement>('[data-curve-index]')
    const system = currentEmitter()?.system
    const points = system && curveFromSystem(system)
    if (!point || !system || !points) return
    event.preventDefault()
    recordHistory()
    svg.setPointerCapture(event.pointerId)
    const index = Number(point.dataset.curveIndex)
    const move = (pointer: PointerEvent) => {
      const rect = svg.getBoundingClientRect()
      const time = Math.max(0, Math.min(1, (pointer.clientX - rect.left) / rect.width))
      const value = Math.max(0, Math.min(2, 2 * (1 - (pointer.clientY - rect.top) / rect.height)))
      const next = curveFromSystem(system)
      if (!next?.[index]) return
      next[index]![0] =
        index === 0
          ? 0
          : index === next.length - 1
            ? 1
            : Math.max(next[index - 1]![0] + 0.015, Math.min(next[index + 1]![0] - 0.015, time))
      next[index]![1] = value
      setSizeCurve(system, next)
      drawCurve(svg, next)
      markEdit()
    }
    const end = () => {
      svg.removeEventListener('pointermove', move)
      svg.removeEventListener('pointerup', end)
      svg.removeEventListener('pointercancel', end)
    }
    svg.addEventListener('pointermove', move, { signal: events.signal })
    svg.addEventListener('pointerup', end, { signal: events.signal })
    svg.addEventListener('pointercancel', end, { signal: events.signal })
  }

  root.addEventListener(
    'input',
    (event) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (
          target instanceof HTMLInputElement &&
          target.dataset.editorColor &&
          colorEditor?.type === 'color'
        ) {
          const color = colorEditor.value
          if (target.dataset.editorColor === 'hex') {
            const rgb = fromHex(target.value)
            ;['r', 'g', 'b'].forEach((key, index) => (color[key] = rgb[index]))
          } else if (target.dataset.editorColor === 'alpha') {
            color.a = Math.max(0, Math.min(255, Number(target.value))) / 255
          } else {
            color[target.dataset.editorColor] =
              Math.max(0, Math.min(255, Number(target.value))) / 255
          }
          const dialog = target.closest('dialog')!
          dialog.querySelector<HTMLInputElement>('[data-editor-color="hex"]')!.value =
            editorColorHex(color)
          for (const channel of ['r', 'g', 'b'])
            dialog.querySelector<HTMLInputElement>(`[data-editor-color="${channel}"]`)!.value =
              String(Math.round(Number(color[channel]) * 255))
          for (const alpha of dialog.querySelectorAll<HTMLInputElement>(
            '[data-editor-color="alpha"]',
          ))
            alpha.value = String(Math.round(Number(color.a) * 255))
          dialog
            .querySelector<HTMLElement>('.color-editor-sample')!
            .style.setProperty('--swatch', editorRgba(color))
        } else if (
          target instanceof HTMLInputElement &&
          target.dataset.editorStop &&
          colorEditor?.type === 'gradient'
        ) {
          const keys = ((colorEditor.value[target.dataset.editorStop] as NativeRecord).keys ??
            []) as NativeRecord[]
          const key = keys[Number(target.dataset.editorIndex)]
          if (!key) return
          if (target.dataset.editorField === 'color') {
            const rgb = fromHex(target.value)
            const value = key.value as NativeRecord
            ;['r', 'g', 'b'].forEach((channel, index) => (value[channel] = rgb[index]))
          } else if (target.dataset.editorField === 'value')
            key.value = Math.max(0, Math.min(1, Number(target.value)))
          else {
            const index = Number(target.dataset.editorIndex)
            const previous = Number(keys[index - 1]?.pos ?? 0)
            const next = Number(keys[index + 1]?.pos ?? 1)
            key.pos = Math.max(
              previous + (index ? 0.001 : 0),
              Math.min(next - (index < keys.length - 1 ? 0.001 : 0), Number(target.value)),
            )
            target.value = String(key.pos)
          }
          const preview = target
            .closest('dialog')
            ?.querySelector<HTMLElement>('.gradient-editor-preview')
          if (preview) preview.style.background = editorGradientCss(colorEditor.value)
        } else if (target.dataset.bind) writeBound(target)
        else if (target instanceof HTMLInputElement && target.dataset.colorStop !== undefined) {
          const system = currentEmitter()?.system
          const stops = system && colorStops(system)
          const stop = stops?.colors[Number(target.dataset.colorStop)]
          if (!system || !stops || !stop) return
          if (target.dataset.colorPart === 'time') stop[0] = Number(target.value)
          else stop.splice(1, 3, ...fromHex(target.value))
          setColorGradient(system, stops.colors, stops.alphas)
          markEdit()
        } else if (target instanceof HTMLInputElement && target.dataset.alphaStop !== undefined) {
          const system = currentEmitter()?.system
          const stops = system && colorStops(system)
          const stop = stops?.alphas[Number(target.dataset.alphaStop)]
          if (!system || !stops || !stop) return
          if (target.dataset.alphaPart === 'time') stop[0] = Number(target.value)
          else stop[1] = Number(target.value)
          setColorGradient(system, stops.colors, stops.alphas)
          markEdit()
        } else if (target.matches('[data-timeline]')) {
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
      if (
        target.dataset.bind ||
        target.dataset.colorStop !== undefined ||
        target.dataset.alphaStop !== undefined
      )
        recordHistory()
    },
    { signal: events.signal },
  )
  root.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-curve-index]')) {
        const svg = target.closest<SVGSVGElement>('[data-curve]')
        if (svg) editCurvePointer(event as PointerEvent, svg)
      }
    },
    { signal: events.signal },
  )
  $<HTMLInputElement>('[data-file-input]').addEventListener(
    'change',
    (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (file) void importFile(file)
    },
    { signal: events.signal },
  )

  $<HTMLInputElement>('[data-unity-input]').addEventListener(
    'change',
    (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (file) void importUnityFile(file)
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
          validateNative(source)
          const geometries = new THREE.ObjectLoader().parseGeometries([source])
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
      const packages = files.filter((file) => /\.unitypackage$/i.test(file.name))
      if (packages.length) {
        if (files.length !== 1)
          flash('Drop one .unitypackage at a time, without other files.', true)
        else void importUnityFile(packages[0]!)
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
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'o') {
        event.preventDefault()
        $<HTMLButtonElement>('[data-action="import"]').click()
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
      for (const saved of stored) {
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
    }
  }

  window.addEventListener(
    'beforeunload',
    (event) => {
      if (dirty) {
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
      releasePreview()
      if (scene) disposeObjects(scene)
      controls?.dispose()
      renderer?.dispose()
      depthTarget?.dispose()
      host.remove()
    },
  }
}
