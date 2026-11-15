import { vi } from 'vitest'

export function memoryFolder() {
  const files = new Map<string, Blob>()
  const directories = new Set<string>([''])
  const write = vi.fn(async (_path: string, _blob: Blob) => {})
  const abort = vi.fn(async () => {})
  const directoryAt = (prefix: string): FileSystemDirectoryHandle =>
    ({
      kind: 'directory',
      name: prefix.split('/').at(-2) || 'project',
      entries: async function* () {
        for (const path of files.keys()) {
          const name = path.slice(prefix.length)
          if (path.startsWith(prefix) && !name.includes('/'))
            yield [name, await directoryAt(prefix).getFileHandle(name)]
        }
      },
      removeEntry: async (name: string) => {
        if (!files.delete(`${prefix}${name}`))
          throw new DOMException('Missing file', 'NotFoundError')
      },
      getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
        const path = `${prefix}${name}/`
        if (
          !options?.create &&
          !directories.has(path) &&
          ![...files.keys()].some((file) => file.startsWith(path))
        )
          throw new DOMException('Missing directory', 'NotFoundError')
        directories.add(path)
        return directoryAt(path)
      },
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        const path = `${prefix}${name}`
        if (!options?.create && !files.has(path))
          throw new DOMException('Missing file', 'NotFoundError')
        return {
          kind: 'file',
          name,
          getFile: async () => new File([files.get(path)!], name, { type: files.get(path)!.type }),
          createWritable: async () => {
            let pending: Blob
            return {
              write: async (blob: Blob) => {
                await write(path, blob)
                pending = blob
              },
              close: async () => {
                files.set(path, pending)
              },
              abort,
            }
          },
        }
      },
    }) as unknown as FileSystemDirectoryHandle
  return { directory: directoryAt(''), files, write, abort }
}
