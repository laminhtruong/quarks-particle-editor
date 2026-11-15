import { gzipSync } from 'node:zlib'

export const prefabGuid = '11111111111111111111111111111111'
export const materialGuid = '22222222222222222222222222222222'
export const textureGuid = '33333333333333333333333333333333'
export const meshGuid = '55555555555555555555555555555555'

// Minimal original FBX, not copied from a Unity asset package. Tabs are required by FBXLoader.
export const meshFbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 7400
}
GlobalSettings:  {
\tProperties70:  {
\t\tP: "UnitScaleFactor", "double", "Number", "",100
\t}
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,1
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",10,20,30
\t\t}
\t}
\tMaterial: 3, "Material::Ignored", "" {
\t\tShadingModel: "phong"
\t}
\tTexture: 4, "Texture::Ignored", "" {
\t\tFileName: "https://untrusted.invalid/texture.png"
\t}
\tVideo: 5, "Video::Ignored", "Clip" {
\t\tRelativeFilename: "https://untrusted.invalid/texture.png"
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",2,0
\tC: "OO",3,2
\tC: "OP",4,3,"DiffuseColor"
\tC: "OO",5,4
}
`

export const meshObj = `mtllib https://untrusted.invalid/material.mtl
o Triangle
v 0 0 0
v 1 0 0
v 0 1 1
vt 0 0
vt 1 0
vt 0 1
f 1/1 2/2 3/3
`

// Hand-authored Unity text serialization; IDs intentionally exceed Number.MAX_SAFE_INTEGER.
export const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &9007199254740992
GameObject:
  m_Name: Fire
  m_IsActive: 1
--- !u!4 &9007199254740993
Transform:
  m_GameObject: {fileID: 9007199254740992}
  m_LocalPosition: {x: 1, y: 2, z: 3}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!198 &9007199254740994
ParticleSystem:
  m_GameObject: {fileID: 9007199254740992}
  lengthInSec: 4
  looping: 1
  prewarm: 0
  moveWithTransform: 1
  InitialModule:
    enabled: 1
    startLifetime: {minMaxState: 3, scalar: 3, minScalar: 2}
    startSpeed: {minMaxState: 0, scalar: 4}
    startSize: {minMaxState: 0, scalar: 0.5}
    startRotation: {minMaxState: 0, scalar: 0.3}
    startColor:
      minMaxState: 2
      minColor: {r: 1, g: 0, b: 0, a: 1}
      maxColor: {r: 1, g: 0.5, b: 0, a: 0.5}
  ShapeModule:
    enabled: 1
    type: 4
    angle: 30
    radius: {value: 0.25}
    arc: {value: 180}
  EmissionModule:
    enabled: 1
    rateOverTime: {minMaxState: 0, scalar: 20}
    rateOverDistance: {minMaxState: 0, scalar: 2}
    m_Bursts:
    - time: 0.5
      countCurve: {minMaxState: 3, scalar: 8, minScalar: 4}
      cycleCount: 2
      repeatInterval: 0.3
      probability: 0.8
  SizeModule:
    enabled: 1
    curve:
      minMaxState: 1
      scalar: 2
      maxCurve:
        m_Curve:
        - {time: 0, value: 0, inSlope: 0, outSlope: 1}
        - {time: 1, value: 1, inSlope: 1, outSlope: 0}
  ColorModule:
    enabled: 1
    gradient:
      minMaxState: 1
      maxGradient:
        m_NumColorKeys: 2
        m_NumAlphaKeys: 2
        key0: {r: 1, g: 0, b: 0, a: 1}
        key1: {r: 0, g: 1, b: 0, a: 0}
        ctime0: 0
        ctime1: 65535
        atime0: 0
        atime1: 65535
  RotationModule:
    enabled: 1
    curve: {minMaxState: 0, scalar: 0.2}
  UVModule:
    enabled: 1
    tilesX: 4
    tilesY: 2
    startFrame: {minMaxState: 0, scalar: 0.25}
    frameOverTime:
      minMaxState: 1
      scalar: 0.999
      maxCurve:
        m_Curve:
        - {time: 0, value: 0, outSlope: 1}
        - {time: 1, value: 1, inSlope: 1}
  NoiseModule: {enabled: 1}
--- !u!199 &9007199254740995
ParticleSystemRenderer:
  m_GameObject: {fileID: 9007199254740992}
  m_Enabled: 1
  m_RenderMode: 0
  m_Materials:
  - {fileID: 2100000, guid: ${materialGuid}, type: 2}
--- !u!1 &9007199254740996
GameObject:
  m_Name: Inactive child
  m_IsActive: 0
--- !u!4 &9007199254740997
Transform:
  m_GameObject: {fileID: 9007199254740996}
  m_LocalPosition: {x: 0, y: 1, z: 2}
  m_Father: {fileID: 9007199254740993}
--- !u!198 &9007199254740998
ParticleSystem:
  m_GameObject: {fileID: 9007199254740996}
  InitialModule:
    startLifetime: {scalar: 1}
    startSpeed: {scalar: 0}
  EmissionModule: {enabled: 0}
`

export const material = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  m_Name: Fire material
  m_Shader: {fileID: 4800000, guid: 44444444444444444444444444444444, type: 3}
  m_SavedProperties:
    m_Floats:
    - _SrcBlend: 5
    - _DstBlend: 1
    - _ZWrite: 0
    m_Colors:
    - _TintColor: {r: 1, g: 0.5, b: 0.2, a: 0.8}
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${textureGuid}, type: 3}
        m_Scale: {x: 2, y: 3}
        m_Offset: {x: 0.1, y: 0.2}
`

export function tar(entries: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  const encode = new TextEncoder()
  for (const [path, value] of Object.entries(entries)) {
    const data = typeof value === 'string' ? encode.encode(value) : value
    const header = new Uint8Array(512)
    const write = (value: string, offset: number) => header.set(encode.encode(value), offset)
    write(path, 0)
    write('0000644\0', 100)
    write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.fill(32, 148, 156)
    header[156] = 48
    write('ustar\0', 257)
    write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
    )
    chunks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function packageFile(entries: Record<string, string | Uint8Array>): File {
  return new File([new Uint8Array(gzipSync(tar(entries)))], 'effects.unitypackage')
}

export function packageEntries(text = prefab): Record<string, string> {
  return {
    [`${prefabGuid}/pathname`]: 'Assets/Effects/Fire.prefab',
    [`${prefabGuid}/asset`]: text,
    [`${materialGuid}/pathname`]: 'Assets/Materials/Fire.mat',
    [`${materialGuid}/asset`]: material,
    [`${textureGuid}/pathname`]: 'Assets/Textures/Fire.png',
    [`${textureGuid}/asset`]: 'test image; decoding is tested separately in local-files.test.ts',
    [`${textureGuid}/asset.meta`]:
      'TextureImporter:\n  sRGBTexture: 1\n  textureSettings: {wrapU: 0, wrapV: 1, filterMode: 0}',
    '44444444444444444444444444444444/pathname': 'Assets/Shaders/Particles.shader',
    '44444444444444444444444444444444/asset': 'Shader "Particles/Additive" {}',
  }
}
