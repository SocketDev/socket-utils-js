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

export abstract class VFS<
  B extends Uint8Array = Uint8Array,
  R extends VFSReadStream = VFSReadStream,
  W extends VFSWriteStream = VFSWriteStream
> {
  protected abstract _readDir (dir: string): Promise<string[]>
  protected abstract _readDirent (dir: string): Promise<VFSDirent[]>
  protected abstract _readFile (file: string, signal?: AbortSignal): Promise<B>
  protected abstract _readFileStream (file: string, signal?: AbortSignal): R
  protected abstract _removeDir (dir: string, recursive: boolean, signal?: AbortSignal): Promise<void>
  protected abstract _removeFile (file: string, signal?: AbortSignal): Promise<void>
  protected abstract _appendFile (file: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  protected abstract _appendFileStream (file: string, signal?: AbortSignal): W
  protected abstract _writeFile (file: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  protected abstract _writeFileStream (file: string, signal?: AbortSignal): W
  protected abstract _copyDir (src: string, dst: string, signal?: AbortSignal): Promise<void>
  protected abstract _copyFile (src: string, dst: string, signal?: AbortSignal): Promise<void>
  protected abstract _stat (file: string): Promise<VFSStats>
  protected abstract _lstat (file: string): Promise<VFSStats>
  protected abstract _exists (file: string): Promise<boolean>

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

  writeFile (file: string, data: Uint8Array, options: { append?: boolean, signal?: AbortSignal } = {}) {
    return options.append ? this._appendFile(file, data, options.signal) : this._writeFile(file, data, options.signal)
  }

  writeFileStream (file: string, options: { append?: boolean, signal?: AbortSignal } = {}) {
    return options.append ? this._appendFileStream(file, options.signal) : this._writeFileStream(file, options.signal)
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

  stat (file: string) {
    return this._stat(file)
  }

  lstat (file: string) {
    return this._lstat(file)
  }

  exists (file: string) {
    return this._exists(file)
  }
}

export * as path from './path'
