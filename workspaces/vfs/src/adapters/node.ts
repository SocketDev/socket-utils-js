import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable, Writable, addAbortSignal } from 'node:stream'
import { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { VFS, VFSError, path as vfsPath } from '..'

import type { VFSWriteStream, VFSDirent, VFSEntryType, VFSErrorCode, VFSReadStream } from '..'
import type { WritableStream as NodeWritableStream } from 'node:stream/web'

export function toNodeReadable (source: VFSReadStream) {
  return Readable.fromWeb(source as NodeReadableStream<Uint8Array>)
}

export function toNodeWritable (source: VFSWriteStream) {
  return Writable.fromWeb(source as NodeWritableStream<Uint8Array>)
}

const allowedErrorTypes = new Set([
  'ENOENT',
  'ENOSYS',
  'EISDIR',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'EUNKNOWN'
])

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`, { code: 'EUNKNOWN' })
  }
  if (err.name === 'AbortError') return err
  let code: VFSErrorCode = 'EUNKNOWN'
  let message = err.message
  if ('code' in err && allowedErrorTypes.has(err.code as string)) {
    code = err.code as VFSErrorCode
    if (message.startsWith(`${code}: `)) {
      message = message.slice(code.length + 2)
    }
  }
  return new VFSError(message, { code, cause: err })
}

const withVFSErr = <T>(promise: Promise<T>) => promise.catch(err => {
  throw wrapVFSErr(err)
})

const ensureDir = async (path: string) => {
  const statInfo = await withVFSErr(fs.promises.lstat(path))
  if (!statInfo.isDirectory()) {
    throw new VFSError(`${path} is not a directory`, { code: 'ENOTDIR' })
  }
  return path
}

const getEntryType = (entry: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): VFSEntryType | null => {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  if (entry.isSymbolicLink()) return 'symlink'
  return null
}

// needed for error wrapping vs Readable.toWeb
const nodeToVFSReadable = (stream: Readable): VFSReadStream<Buffer> => {
  const webStream = new NodeReadableStream({
    start (c) {
      stream.on('data', chunk => {
        c.enqueue(chunk as Buffer)
        if ((c.desiredSize || 0) <= 0) stream.pause()
      })
      stream.on('error', err => {
        c.error(wrapVFSErr(err))
      })
      stream.on('end', () => {
        c.close()
      })
    },
    pull () { stream.resume() },
    cancel (reason) { stream.destroy(reason) }
  }, { highWaterMark: stream.readableHighWaterMark })
  // cast basically assumes all Node Readable streams will have Node.js' extensions
  return webStream as VFSReadStream<Buffer>
}

const nodeToVFSWritable = (stream: Writable): VFSWriteStream => {
  const webStream = Writable.toWeb(stream)
  stream.prependListener('error', err => {
    void webStream.abort(wrapVFSErr(err))
  })
  return webStream
}

export default class NodeVFS extends VFS<
  Buffer
> {
  private base: string
  private enforceBase: boolean

  constructor (basePath?: string, lockToRoot = true) {
    super()
    this.base = basePath ? path.resolve(basePath) : path.parse(process.cwd()).root
    if (this.base.endsWith(path.sep)) {
      this.base = this.base.slice(0, this.base.length - path.sep.length)
    }
    this.enforceBase = lockToRoot
  }

  private fsPath (src: string) {
    const rel = vfsPath.parse(src)
    if (!rel.length) return this.base
    if (this.enforceBase && rel[0] === '..') {
      throw new VFSError('path outside base directory', { code: 'EPERM' })
    }
    return `${this.base}${path.sep}${rel.join(path.sep)}`
  }

  protected async _appendFile (file: string, data: Uint8Array, signal?: AbortSignal) {
    await withVFSErr(fs.promises.writeFile(this.fsPath(file), data, { flag: 'a', signal }))
  }

  protected _appendFileStream (file: string, signal?: AbortSignal | undefined) {
    const stream = fs.createWriteStream(this.fsPath(file), { flags: 'a' })
    if (signal) addAbortSignal(signal, stream)

    return nodeToVFSWritable(stream)
  }

  protected async _copyDir (src: string, dst: string, _signal?: AbortSignal | undefined) {
    // TODO: handle abort signal
    await withVFSErr(fs.promises.cp(await ensureDir(this.fsPath(src)), this.fsPath(dst), { recursive: true }))
  }

  protected async _copyFile (src: string, dst: string, _signal?: AbortSignal | undefined) {
    // TODO: handle abort signal
    await withVFSErr(fs.promises.copyFile(this.fsPath(src), this.fsPath(dst)))
  }

  protected async _exists (file: string) {
    // Node.js doesn't like this because it allows for race conditions
    // We accept that risk here - avoid existsSync to not block
    try {
      // no this.fsPath because this is a public API method
      await withVFSErr(fs.promises.lstat(this.fsPath(file)))
      return true
    } catch (err) {
      if (err instanceof VFSError && err.code === 'ENOENT') {
        return false
      }
      throw err
    }
  }

  protected async _readDir (dir: string) {
    return await withVFSErr(fs.promises.readdir(this.fsPath(dir)))
  }

  protected async _readDirent (dir: string) {
    const dirents = await withVFSErr(fs.promises.readdir(this.fsPath(dir), { withFileTypes: true }))
    return dirents.map<VFSDirent | null>(ent => {
      const type = getEntryType(ent)
      return type && {
        type,
        name: ent.name
      }
    }).filter((ent): ent is VFSDirent => ent !== null)
  }

  protected async _readFile (file: string, signal?: AbortSignal | undefined) {
    return await withVFSErr(fs.promises.readFile(this.fsPath(file), { signal }))
  }

  protected _readFileStream (file: string, signal?: AbortSignal | undefined) {
    const stream = fs.createReadStream(this.fsPath(file))
    if (signal) addAbortSignal(signal, stream)

    return nodeToVFSReadable(stream)
  }

  protected async _removeDir (dir: string, recursive: boolean, _signal?: AbortSignal | undefined) {
    // TODO: handle abort signal
    await withVFSErr(fs.promises.rm(await ensureDir(this.fsPath(dir)), { recursive }))
  }

  protected async _removeFile (file: string, _signal?: AbortSignal | undefined) {
    await withVFSErr(fs.promises.unlink(this.fsPath(file)))
  }

  protected async _stat (file: string) {
    const stat = await withVFSErr(fs.promises.stat(this.fsPath(file)))
    const type = getEntryType(stat)

    if (!type) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      size: stat.size,
      type
    }
  }

  protected async _lstat (file: string) {
    const stat = await withVFSErr(fs.promises.lstat(this.fsPath(file)))
    const type = getEntryType(stat)

    if (!type) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      size: stat.size,
      type
    }
  }

  protected async _writeFile (file: string, data: Uint8Array, signal?: AbortSignal | undefined) {
    await withVFSErr(fs.promises.writeFile(this.fsPath(file), data, { signal }))
  }

  protected _writeFileStream (file: string, signal?: AbortSignal | undefined) {
    const stream = fs.createWriteStream(this.fsPath(file))
    if (signal) addAbortSignal(signal, stream)

    return nodeToVFSWritable(stream)
  }

  protected async _truncate (file: string, to: number): Promise<void> {
    await withVFSErr(fs.promises.truncate(this.fsPath(file), to))
  }
}
