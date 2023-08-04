import { ErrorWithCause } from 'pony-cause'

import * as path from './path'

export type VFSErrorCode =
  | 'ENOENT'
  | 'ENOSYS'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EPERM'
  | 'EMFILE'
  | 'ENFILE'
  | 'EBADF'
  | 'EINVAL'
  | 'EEXIST'
  | 'EBUSY'
  | 'EUNKNOWN'

export class VFSError extends ErrorWithCause<Error> {
  code: VFSErrorCode

  constructor (message: string, options: {
    code?: VFSErrorCode
    cause?: Error
  } = {}) {
    const code = options.code ?? 'EUNKNOWN'
    super(`${code}: ${message}`, { cause: options.cause })
    this.name = 'VFSError'
    this.code = code
  }
}

export interface VFSReadStream extends ReadableStream<Uint8Array> {}

export interface VFSWriteStream extends WritableStream<Uint8Array> {}

export type VFSEntryType = 'file' | 'dir' | 'symlink'

export interface VFSDirent {
  type: VFSEntryType
  name: string
}

export interface VFSStats {
  size: number
  type: VFSEntryType
}

export abstract class VFSFileHandle {
  private _closed: boolean

  constructor () {
    this._closed = false
  }

  protected abstract _read (into: Uint8Array, position: number): Promise<number>
  protected abstract _write (data: Uint8Array, position: number): Promise<number>
  protected abstract _truncate (to: number): Promise<void>
  protected abstract _flush (): Promise<void>
  protected abstract _stat (): Promise<VFSStats>
  protected abstract _close (): Promise<void>

  private _assertOpen () {
    if (this._closed) {
      throw new VFSError('file handle is closed', { code: 'EINVAL' })
    }
  }

  async read (into: Uint8Array, position: number) {
    this._assertOpen()
    return this._read(into, position)
  }

  async write (into: Uint8Array, position: number) {
    this._assertOpen()
    return this._write(into, position)
  }

  async truncate (to: number) {
    this._assertOpen()
    return this._truncate(to)
  }

  async flush () {
    if (this._closed) return
    return this._flush()
  }

  async stat () {
    this._assertOpen()
    return this._stat()
  }

  async close () {
    if (this._closed) return
    this._closed = true
    return this._close()
  }
}

export type VFSWatchEventType = 'create' | 'update' | 'delete'

export interface VFSWatchEvent {
  type: VFSWatchEventType
  path: string
}

export type VFSWatchCallback = (event: VFSWatchEvent) => unknown
export type VFSWatchErrorCallback = (err: VFSError) => unknown

export interface VFSWatcher {
  onEvent (callback: VFSWatchCallback): this
  onError (callback: VFSWatchErrorCallback): this
  events (): AsyncIterableIterator<VFSWatchEvent>
  unsubscribe (): Promise<void>
}

export type VFSWatchUnsubscribe = () => Promise<void>

export abstract class VFS {
  // functions that don't go through final link:
  // _symlink, _readSymlink, _rename, _removeFile, _lstat
  protected abstract _readDir (dir: string[]): Promise<string[]>
  protected abstract _readDirent (dir: string[]): Promise<VFSDirent[]>
  // always makes dir through symlinks
  protected abstract _mkdir (dir: string[], recursive: boolean): Promise<void>
  protected abstract _readFile (file: string[], signal?: AbortSignal): Promise<Uint8Array>
  protected abstract _readFileStream (file: string[], signal?: AbortSignal): VFSReadStream
  protected abstract _removeDir (
    dir: string[],
    recursive: boolean,
    signal?: AbortSignal
  ): Promise<void>
  // may or may not remove through symlink
  protected abstract _removeFile (
    file: string[],
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _appendFile (
    file: string[],
    data: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _appendFileStream (file: string[], signal?: AbortSignal): VFSWriteStream
  protected abstract _writeFile (
    file: string[],
    data: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _writeFileStream (file: string[], signal?: AbortSignal): VFSWriteStream
  protected abstract _truncate (file: string[], to: number): Promise<void>
  // copyDir and copyFile always copy through symlinks
  protected abstract _copyDir (src: string[], dst: string[], signal?: AbortSignal): Promise<void>
  protected abstract _copyFile (src: string[], dst: string[], signal?: AbortSignal): Promise<void>
  protected abstract _openFile (
    file: string[],
    read: boolean,
    write: boolean,
    truncate: boolean
  ): Promise<VFSFileHandle>
  protected abstract _stat (file: string[]): Promise<VFSStats>
  protected abstract _lstat (file: string[]): Promise<VFSStats>
  protected abstract _exists (file: string[]): Promise<boolean>
  protected abstract _symlink (target: string[], link: string[], relative: boolean): Promise<void>
  protected abstract _readSymlink (link: string[]): Promise<string>
  protected abstract _realPath (link: string[]): Promise<string>
  protected abstract _rename (src: string[], dst: string[]): Promise<void>
  protected abstract _watch (
    glob: string,
    watcher: VFSWatchCallback,
    onError: VFSWatchErrorCallback
  ): Promise<VFSWatchUnsubscribe>

  readDir (dir: string, options?: { withFileTypes?: false }): Promise<string[]>
  readDir (dir: string, options: { withFileTypes: true }): Promise<VFSDirent[]>
  readDir (dir: string, options?: { withFileTypes: boolean }): Promise<string[] | VFSDirent[]>
  readDir (dir: string, options: { withFileTypes?: boolean } = {}) {
    return options.withFileTypes
      ? this._readDirent(path.parse(dir).parts)
      : this._readDir(path.parse(dir).parts)
  }

  readFile (file: string, options: { signal?: AbortSignal } = {}) {
    return this._readFile(path.parse(file).parts, options.signal)
  }

  readFileStream (file: string, options: { signal?: AbortSignal } = {}) {
    return this._readFileStream(path.parse(file).parts, options.signal)
  }

  removeDir (dir: string, options: { recursive?: boolean, signal?: AbortSignal } = {}) {
    return this._removeDir(path.parse(dir).parts, options.recursive ?? false, options.signal)
  }

  removeFile (file: string, options: { signal?: AbortSignal } = {}) {
    return this._removeFile(path.parse(file).parts, options.signal)
  }

  async remove (filepath: string, options: { signal?: AbortSignal } = {}) {
    const parts = path.parse(filepath).parts
    try {
      await this._removeFile(parts, options.signal)
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EISDIR') {
        await this._removeDir(parts, true, options.signal)
      }
      throw err
    }
  }

  writeFile (
    file: string,
    data: Uint8Array,
    options: { append?: boolean, signal?: AbortSignal } = {}
  ) {
    return options.append
      ? this._appendFile(path.parse(file).parts, data, options.signal)
      : this._writeFile(path.parse(file).parts, data, options.signal)
  }

  writeFileStream (file: string, options: { append?: boolean, signal?: AbortSignal } = {}) {
    return options.append
      ? this._appendFileStream(path.parse(file).parts, options.signal)
      : this._writeFileStream(path.parse(file).parts, options.signal)
  }

  truncate (file: string, to = 0) {
    return this._truncate(path.parse(file).parts, to)
  }

  copyDir (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    return this._copyDir(path.parse(src).parts, path.parse(dst).parts, options.signal)
  }

  copyFile (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    return this._copyFile(path.parse(src).parts, path.parse(dst).parts, options.signal)
  }

  async copy (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    const srcParsed = path.parse(src).parts
    const dstParsed = path.parse(dst).parts
    try {
      await this._copyFile(srcParsed, dstParsed, options.signal)
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EISDIR') {
        await this._copyDir(srcParsed, dstParsed, options.signal)
      }
      throw err
    }
  }

  async open (file: string, options: { read?: boolean, write?: boolean, truncate?: boolean } = {}) {
    return this._openFile(
      path.parse(file).parts,
      options.read || options.write == null,
      !!options.write,
      !!options.write && (options.truncate == null || options.truncate)
    )
  }

  async watch (glob: string): Promise<VFSWatcher> {
    const callbacks: VFSWatchCallback[] = []
    const errCallbacks: VFSWatchErrorCallback[] = []
    let done = false

    const finish = () => {
      done = true
      callbacks.length = 0
      errCallbacks.length = 0
      unsub = () => Promise.resolve()
    }

    let unsub = await this._watch(
      glob,
      evt => {
        for (const cb of callbacks) cb(evt)
      },
      err => {
        for (const cb of errCallbacks) cb(err)
        finish()
      }
    )

    const watcher: VFSWatcher = {
      onEvent (cb: VFSWatchCallback) {
        if (!done) callbacks.push(cb)
        return watcher
      },
      onError (cb: VFSWatchErrorCallback) {
        if (!done) errCallbacks.push(cb)
        return watcher
      },
      async * events () {
        if (done) return

        let results: VFSWatchEvent[] = []

        let curResolve!: () => void
        let curReject!: (err: Error) => void
        let next = new Promise<void>((resolve, reject) => {
          curResolve = resolve
          curReject = reject
        })
        callbacks.push(evt => {
          curResolve()
          results.push(evt)
          next = new Promise<void>((resolve, reject) => {
            curResolve = resolve
            curReject = reject
          })
        })
        errCallbacks.push(err => {
          curReject(err)
        })

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!done) {
          if (!results.length) await next
          const oldResults = results
          results = []
          yield * oldResults
        }
      },
      async unsubscribe () {
        try {
          await unsub()
        } finally {
          finish()
        }
      }
    }

    return watcher
  }

  stat (file: string) {
    return this._stat(path.parse(file).parts)
  }

  lstat (file: string) {
    return this._lstat(path.parse(file).parts)
  }

  exists (file: string) {
    return this._exists(path.parse(file).parts)
  }

  realPath (link: string) {
    return this._realPath(path.parse(link).parts)
  }

  symlink (target: string, link: string) {
    const targetParsed = path.parse(target)
    return this._symlink(targetParsed.parts, path.parse(link).parts, !targetParsed.absolute)
  }

  readSymlink (link: string) {
    return this._readSymlink(path.parse(link).parts)
  }

  rename (src: string, dst: string) {
    return this._rename(path.parse(src).parts, path.parse(dst).parts)
  }

  mkdir (dir: string, options: { recursive?: boolean } = {}) {
    return this._mkdir(path.parse(dir).parts, options.recursive ?? false)
  }
}

export { path }
