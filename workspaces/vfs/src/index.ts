import { ErrorWithCause } from 'pony-cause'

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
  | 'EUNKNOWN'

export class VFSError extends ErrorWithCause<Error> {
  code: VFSErrorCode

  constructor (message: string, options: {
    code?: VFSErrorCode
    cause?: Error
  } = {}) {
    const code = options.code ?? 'EUNKNOWN'
    super(`${code}: ${message}`, { cause: options.cause })
    this.code = code
  }
}

export interface VFSReadStream<B extends Uint8Array = Uint8Array> extends ReadableStream<B> {}

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

export abstract class VFS<
  B extends Uint8Array = Uint8Array,
  R extends VFSReadStream<B> = VFSReadStream<B>,
  W extends VFSWriteStream = VFSWriteStream
> {
  protected abstract _readDir (dir: string): Promise<string[]>
  protected abstract _readDirent (dir: string): Promise<VFSDirent[]>
  protected abstract _readFile (file: string, signal?: AbortSignal): Promise<B>
  protected abstract _readFileStream (file: string, signal?: AbortSignal): R
  protected abstract _removeDir (
    dir: string,
    recursive: boolean,
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _removeFile (file: string, signal?: AbortSignal): Promise<void>
  protected abstract _appendFile (
    file: string,
    data: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _appendFileStream (file: string, signal?: AbortSignal): W
  protected abstract _writeFile (
    file: string,
    data: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>
  protected abstract _writeFileStream (file: string, signal?: AbortSignal): W
  protected abstract _truncate (file: string, to: number): Promise<void>
  protected abstract _copyDir (src: string, dst: string, signal?: AbortSignal): Promise<void>
  protected abstract _copyFile (src: string, dst: string, signal?: AbortSignal): Promise<void>
  protected abstract _openFile (file: string, read: boolean, write: boolean): Promise<VFSFileHandle>
  protected abstract _stat (file: string): Promise<VFSStats>
  protected abstract _lstat (file: string): Promise<VFSStats>
  protected abstract _exists (file: string): Promise<boolean>
  protected abstract _symlink (target: string, link: string): Promise<void>
  protected abstract _realPath (link: string): Promise<string>
  protected abstract _watch (
    glob: string,
    watcher: VFSWatchCallback,
    onError: VFSWatchErrorCallback
  ): Promise<VFSWatchUnsubscribe>

  readDir (dir: string, options?: { withFileTypes?: false }): Promise<string[]>
  readDir (dir: string, options: { withFileTypes: true }): Promise<VFSDirent[]>
  readDir (dir: string, options?: { withFileTypes: boolean }): Promise<string[] | VFSDirent[]>
  readDir (dir: string, options: { withFileTypes?: boolean } = {}) {
    return options.withFileTypes ? this._readDirent(dir) : this._readDir(dir)
  }

  readFile (file: string, options: { signal?: AbortSignal } = {}) {
    return this._readFile(file, options.signal)
  }

  readFileStream (file: string, options: { signal?: AbortSignal } = {}) {
    return this._readFileStream(file, options.signal)
  }

  removeDir (dir: string, options: { recursive?: boolean, signal?: AbortSignal } = {}) {
    return this._removeDir(dir, options.recursive ?? false, options.signal)
  }

  removeFile (file: string, options: { signal?: AbortSignal } = {}) {
    return this._removeFile(file, options.signal)
  }

  async remove (filepath: string, options: { signal?: AbortSignal } = {}) {
    try {
      await this.removeFile(filepath, { signal: options.signal })
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EISDIR') {
        await this.removeDir(filepath, { recursive: true, signal: options.signal })
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
      ? this._appendFile(file, data, options.signal)
      : this._writeFile(file, data, options.signal)
  }

  writeFileStream (file: string, options: { append?: boolean, signal?: AbortSignal } = {}) {
    return options.append
      ? this._appendFileStream(file, options.signal)
      : this._writeFileStream(file, options.signal)
  }

  truncate (file: string, to = 0) {
    return this._truncate(file, to)
  }

  copyDir (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    return this._copyDir(src, dst, options.signal)
  }

  copyFile (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    return this._copyFile(src, dst, options.signal)
  }

  async copy (src: string, dst: string, options: { signal?: AbortSignal } = {}) {
    try {
      await this.copyFile(src, dst, { signal: options.signal })
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EISDIR') {
        await this.copyDir(src, dst, { signal: options.signal })
      }
      throw err
    }
  }

  async open (file: string, options: { read?: boolean, write?: boolean } = {}) {
    return this._openFile(file, options.read || options.write == null, !!options.write)
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
    return this._stat(file)
  }

  lstat (file: string) {
    return this._lstat(file)
  }

  exists (file: string) {
    return this._exists(file)
  }

  realPath (link: string) {
    return this._realPath(link)
  }

  symlink (src: string, dst: string) {
    return this._symlink(src, dst)
  }
}

export * as path from './path'
