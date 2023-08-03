import { VFS, VFSError, VFSFileHandle } from '@socketsecurity/vfs'

import type { VFSWatchCallback, VFSWatchErrorCallback } from '@socketsecurity/vfs'

const noWrite = () => {
  throw new VFSError('cannot write to readonly filesystem', { code: 'ENOSYS' })
}

export abstract class ReadonlyVFSFileHandle extends VFSFileHandle {
  protected async _flush () {}
  protected async _truncate () { return noWrite() }
  protected async _write () { return noWrite() }
}

class ReadonlyVFSFileHandleWrapper extends ReadonlyVFSFileHandle {
  private _inner: VFSFileHandle

  constructor (handle: VFSFileHandle) {
    super()
    this._inner = handle
  }

  protected _close () {
    return this._inner['_close']()
  }

  protected _read (into: Uint8Array, position: number) {
    return this._inner['_read'](into, position)
  }

  protected _stat () {
    return this._inner['_stat']()
  }
}

export abstract class ReadonlyVFS extends VFS {
  protected abstract _openFileReadonly (file: string[]): Promise<ReadonlyVFSFileHandle>
  protected async _appendFile () { return noWrite() }
  protected _appendFileStream () { return noWrite() }
  protected async _copyDir () { return noWrite() }
  protected async _copyFile () { return noWrite() }
  protected async _mkdir () { return noWrite() }
  protected async _openFile (file: string[], _read: boolean, write: boolean, truncate: boolean) {
    if (write || truncate) {
      return noWrite()
    }
    return this._openFileReadonly(file)
  }

  protected async _removeDir () { return noWrite() }
  protected async _removeFile () { return noWrite() }
  protected async _rename () { return noWrite() }
  protected async _truncate () { return noWrite() }
  protected async _symlink () { return noWrite() }
  protected async _writeFile () { return noWrite() }
  protected _writeFileStream () { return noWrite() }
}

class ReadonlyVFSWrapper extends ReadonlyVFS {
  private _inner: VFS

  constructor (vfs: VFS) {
    super()
    this._inner = vfs
  }

  protected _exists (file: string[]) {
    return this._inner['_exists'](file)
  }

  protected _lstat (file: string[]) {
    return this._inner['_lstat'](file)
  }

  protected async _openFileReadonly (file: string[]) {
    return new ReadonlyVFSFileHandleWrapper(
      await this._inner['_openFile'](file, true, false, false)
    )
  }

  protected _readDir (dir: string[]) {
    return this._inner['_readDir'](dir)
  }

  protected _readDirent (dir: string[]) {
    return this._inner['_readDirent'](dir)
  }

  protected _readFile (file: string[], signal?: AbortSignal) {
    return this._inner['_readFile'](file, signal)
  }

  protected _readFileStream (file: string[], signal?: AbortSignal) {
    return this._inner['_readFileStream'](file, signal)
  }

  protected _readSymlink (link: string[]) {
    return this._inner['_readSymlink'](link)
  }

  protected _realPath (link: string[]) {
    return this._inner['_realPath'](link)
  }

  protected _stat (file: string[]) {
    return this._inner['_stat'](file)
  }

  protected _watch (glob: string, watcher: VFSWatchCallback, onError: VFSWatchErrorCallback) {
    return this._inner['_watch'](glob, watcher, onError)
  }
}

export function makeReadonly (fs: VFS): ReadonlyVFS {
  return new ReadonlyVFSWrapper(fs)
}
