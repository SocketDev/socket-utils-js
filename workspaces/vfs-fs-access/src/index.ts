/// <reference types="wicg-file-system-access" />
import { VFS, VFSError, VFSErrorCode, VFSFileHandle, VFSStats, VFSWriteStream, path as vfsPath } from '@socketsecurity/vfs'

// many 2020ish browsers don't have throwIfAborted
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.throwIfAborted) signal.throwIfAborted()
  else if (signal?.aborted) {
    throw wrapVFSErr(signal.reason)
  }
}

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`)
  }
  if (err.name === 'AbortError') return err
  if (err.name === 'NotFoundError') {
    return new VFSError('no such file or directory', { code: 'ENOENT', cause: err })
  }
  if (err.name === 'NotAllowedError') {
    return new VFSError('permission denied', { code: 'EPERM', cause: err })
  }
  return new VFSError(err.message, { cause: err })
}

const wrapWriteStream = (
  gen: () => Promise<WritableStream<Uint8Array>>
): WritableStream<Uint8Array> => {
  let resolveWriter!: (writer: WritableStreamDefaultWriter<Uint8Array>) => void
  const writerPromise = new Promise<WritableStreamDefaultWriter<Uint8Array>>(resolve => {
    resolveWriter = resolve
  })

  return new WritableStream({
    async start (controller) {
      try {
        const inner = await gen()
        const writer = inner.getWriter()
        resolveWriter(writer)
      } catch (err) {
        controller.error(err)
      }
    },
    async write (chunk) {
      return withVFSErr((await writerPromise).write(chunk))
    },
    async abort (reason) {
      return withVFSErr((await writerPromise).abort(reason))
    },
    async close () {
      return withVFSErr((await writerPromise).close())
    }
  })
}

const wrapReadStream = (
  gen: () => Promise<ReadableStream<Uint8Array>>
): ReadableStream<Uint8Array> => {
  let resolveReader!: (writer: ReadableStreamDefaultReader<Uint8Array>) => void
  const readerPromise = new Promise<ReadableStreamDefaultReader<Uint8Array>>(resolve => {
    resolveReader = resolve
  })

  return new ReadableStream({
    async start (controller) {
      try {
        const inner = await gen()
        // TODO: Chromium doesn't seem to support BYOB readers for files
        const reader = inner.getReader()
        resolveReader(reader)
      } catch (err) {
        controller.error(err)
      }
    },
    async pull (controller) {
      const reader = await readerPromise
      const chunk = await withVFSErr(reader.read())
      if (chunk.done) {
        controller.close()
        return
      }
      controller.enqueue(chunk.value)
    },
    async cancel (reason) {
      await withVFSErr((await readerPromise).cancel(reason))
    }
  })
}

const withVFSErr = <T>(promise: Promise<T>) => promise.catch(err => {
  throw wrapVFSErr(err)
})

class FSAccessVFSFileHandle extends VFSFileHandle {
  private _handle: FileSystemFileHandle
  private _file: File
  private _writable: FileSystemWritableFileStream

  private constructor (
    handle: FileSystemFileHandle,
    file: File,
    writable: FileSystemWritableFileStream
  ) {
    super()
    this._handle = handle
    this._file = file
    this._writable = writable
  }

  protected async _close () {
    await withVFSErr(this._writable.close())
  }

  protected async _flush (): Promise<void> {
    await withVFSErr(this._writable.close())
    this._writable = await withVFSErr(this._handle.createWritable({ keepExistingData: true }))
  }

  protected async _read (into: Uint8Array, position: number) {
    const buf = await withVFSErr(this._file.slice(position, position + into.length).arrayBuffer())
    into.set(new Uint8Array(buf))
    return into.byteLength
  }

  protected async _stat () {
    this._file = await withVFSErr(this._handle.getFile())
    return {
      type: 'file' as const,
      size: this._file.size
    }
  }

  protected async _truncate (to: number) {
    await withVFSErr(this._writable.write({
      type: 'truncate',
      size: to
    }))
  }

  protected async _write (data: Uint8Array, position: number) {
    await withVFSErr(this._writable.write({
      type: 'write',
      data,
      position
    }))
    return data.byteLength
  }

  static async open (handle: FileSystemFileHandle) {
    const [file, writable] = await withVFSErr(Promise.all([
      handle.getFile(),
      handle.createWritable({ keepExistingData: true })
    ]))

    return new FSAccessVFSFileHandle(handle, file, writable)
  }
}

export class FSAccessVFS extends VFS {
  private _root: FileSystemFileHandle | FileSystemDirectoryHandle

  constructor (handle: FileSystemDirectoryHandle | FileSystemFileHandle) {
    super()
    this._root = handle
  }

  private async _locate (path: string) {
    const normalized = vfsPath.normalize(path)
    if (normalized === '.') return null
    if (this._root.kind !== 'directory') {
      throw new VFSError('cannot traverse single-file filesystem', { code: 'ENOTDIR' })
    }
    const parts = normalized.split('/')
    let curDir = this._root
    for (let i = 0; i < parts.length - 1; ++i) {
      try {
        curDir = await curDir.getDirectoryHandle(parts[i])
      } catch (err) {
        if (err instanceof Error && err.name === 'TypeMismatchError') {
          throw new VFSError('not a directory', { code: 'ENOTDIR', cause: err })
        }
        throw wrapVFSErr(err)
      }
    }

    return {
      parent: curDir,
      name: parts[parts.length - 1]
    }
  }

  private async _file (path: string, create?: boolean) {
    const located = await this._locate(path)
    if (!located) {
      if (this._root.kind === 'file') return this._root
      throw new VFSError('filesystem root is not a file', { code: 'EISDIR' })
    }
    try {
      return await located.parent.getFileHandle(located.name, { create })
    } catch (err) {
      if (err instanceof Error && err.name === 'TypeMismatchError') {
        throw new VFSError('not a file', { code: 'EISDIR', cause: err })
      }
      throw wrapVFSErr(err)
    }
  }

  private async _dir (path: string, create?: boolean) {
    const located = await this._locate(path)
    if (!located) {
      if (this._root.kind === 'directory') return this._root
      throw new VFSError('filesystem root is not a directory', { code: 'ENOTDIR' })
    }
    try {
      return await located.parent.getDirectoryHandle(located.name, { create })
    } catch (err) {
      if (err instanceof Error && err.name === 'TypeMismatchError') {
        throw new VFSError('not a directory', { code: 'ENOTDIR', cause: err })
      }
      throw wrapVFSErr(err)
    }
  }

  protected async _appendFile (file: string, data: Uint8Array, signal?: AbortSignal | undefined) {
    const f = await this._file(file, true)
    const [fileObj, writable] = await withVFSErr(Promise.all([
      f.getFile(),
      f.createWritable({ keepExistingData: true })
    ]))
    if (signal) {
      throwIfAborted(signal)
      signal.addEventListener('abort', err => {
        writable.abort(wrapVFSErr(err))
      }, { once: true })
    }
    await withVFSErr(writable.write({
      type: 'write',
      position: fileObj.size,
      data
    }))
  }

  protected _appendFileStream (file: string, signal?: AbortSignal | undefined) {
    return wrapWriteStream(async () => {
      const f = await this._file(file, true)
      const [fileObj, writable] = await withVFSErr(Promise.all([
        f.getFile(),
        f.createWritable({ keepExistingData: true })
      ]))
      if (signal) {
        throwIfAborted(signal)
        signal.addEventListener('abort', err => {
          writable.abort(wrapVFSErr(err))
        }, { once: true })
      }
      await withVFSErr(writable.seek(fileObj.size))
      return writable
    })
  }

  protected async _copyFileRaw (
    src: FileSystemFileHandle,
    dst: FileSystemFileHandle,
    signal?: AbortSignal
  ) {
    const [srcFile, dstStream] = await withVFSErr(
      Promise.all([src.getFile(), dst.createWritable()])
    )
    await withVFSErr(srcFile.stream().pipeTo(dstStream, { signal }))
  }

  protected async _copyFile (src: string, dst: string, signal?: AbortSignal | undefined) {
    const [srcFile, dstFile] = await Promise.all([this._file(src), this._file(dst, true)])

    return this._copyFileRaw(srcFile, dstFile, signal)
  }

  protected async _copyDirRecurse (
    src: FileSystemDirectoryHandle,
    dst: FileSystemDirectoryHandle,
    ctrl: AbortController
  ) {
    const copies: Promise<void>[] = []

    try {
      for await (const [name, sub] of src.entries()) {
        const copy = sub.kind === 'file'
          ? this._copyFileRaw(sub, await dst.getFileHandle(name, { create: true }), ctrl.signal)
          : this._copyDirRecurse(sub, await dst.getDirectoryHandle(name, { create: true }), ctrl)
        copies.push(copy)
      }
    } catch (err) {
      ctrl.abort(wrapVFSErr(err))
    }

    await Promise.all(copies)
  }

  protected async _copyDir (src: string, dst: string, signal?: AbortSignal | undefined) {
    const [srcDir, dstDir] = await Promise.all([this._dir(src), this._dir(dst, true)])

    throwIfAborted(signal)
    const ctrl = new AbortController()
    signal?.addEventListener('abort', reason => ctrl.abort(reason), { once: true })

    await this._copyDirRecurse(srcDir, dstDir, ctrl)
  }

  protected async _exists (file: string) {
    try {
      await this._locate(file)
      return true
    } catch (err) {
      return false
    }
  }

  protected async _lstat (file: string) {
    return this._stat(file)
  }

  protected async _openFile (file: string, _read: boolean, _write: boolean) {
    return await FSAccessVFSFileHandle.open(await this._file(file))
  }
}
