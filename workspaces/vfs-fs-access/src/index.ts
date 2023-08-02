/// <reference types="wicg-file-system-access" />
import { VFS, VFSError, VFSFileHandle, path } from '@socketsecurity/vfs'

import type { VFSDirent, VFSWatchCallback, VFSWatchErrorCallback } from '@socketsecurity/vfs'

interface MovableHandle extends FileSystemHandle {
  move (parent: FileSystemDirectoryHandle, name: string): Promise<void>
}

const isMovable = (handle: FileSystemHandle): handle is MovableHandle => 'move' in handle

// need to wrap with wrapVFSErr
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw wrapVFSErr(signal.reason)
  }
}

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`)
  }
  if (err.name === 'AbortError' || err.name === 'VFSError') return err
  if (err.name === 'NotFoundError') {
    return new VFSError('no such file or directory', { code: 'ENOENT', cause: err })
  }
  if (err.name === 'NotAllowedError') {
    return new VFSError('permission denied', { code: 'EPERM', cause: err })
  }
  return new VFSError(err.message, { cause: err })
}

const wrapWriteStream = (
  gen: () => Promise<WritableStream<Uint8Array>>,
  signal?: AbortSignal
): WritableStream<Uint8Array> => {
  let resolveWriter!: (writer: WritableStreamDefaultWriter<Uint8Array>) => void
  const writerPromise = new Promise<WritableStreamDefaultWriter<Uint8Array>>(resolve => {
    resolveWriter = resolve
  })

  throwIfAborted(signal)

  return new WritableStream({
    async start (controller) {
      let inner: WritableStream | undefined
      try {
        inner = await gen()
        throwIfAborted(signal)
        const writer = inner.getWriter()
        signal?.addEventListener('abort', () => {
          writer.abort(wrapVFSErr(signal.reason)).catch(() => {})
        }, { once: true })
        resolveWriter(writer)
      } catch (err) {
        controller.error(err)
        await inner?.abort(err).catch(() => {})
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
  gen: () => Promise<ReadableStream<Uint8Array>>,
  signal?: AbortSignal
): ReadableStream<Uint8Array> => {
  let resolveReader!: (writer: ReadableStreamDefaultReader<Uint8Array>) => void
  const readerPromise = new Promise<ReadableStreamDefaultReader<Uint8Array>>(resolve => {
    resolveReader = resolve
  })

  throwIfAborted(signal)

  return new ReadableStream({
    async start (controller) {
      let inner: ReadableStream | undefined
      try {
        inner = await gen()
        throwIfAborted(signal)
        // TODO: Chromium doesn't seem to support BYOB readers for files
        const reader = inner.getReader()
        signal?.addEventListener('abort', () => {
          reader.cancel(wrapVFSErr(signal.reason)).catch(() => {})
        }, { once: true })
        resolveReader(reader)
      } catch (err) {
        controller.error(err)
        await inner?.cancel(err).catch(() => {})
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
  private _writable?: FileSystemWritableFileStream

  private constructor (
    handle: FileSystemFileHandle,
    file: File,
    writable?: FileSystemWritableFileStream
  ) {
    super()
    this._handle = handle
    this._file = file
    this._writable = writable
  }

  protected async _close () {
    if (this._writable) {
      await withVFSErr(this._writable.close())
    }
  }

  protected async _flush (): Promise<void> {
    if (this._writable) {
      await withVFSErr(this._writable.close())
      this._writable = await withVFSErr(this._handle.createWritable({ keepExistingData: true }))
    }
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
    if (!this._writable) {
      throw new VFSError('cannot write to readonly file', {
        code: 'EINVAL'
      })
    }
    await withVFSErr(this._writable.write({
      type: 'truncate',
      size: to
    }))
  }

  protected async _write (data: Uint8Array, position: number) {
    if (!this._writable) {
      throw new VFSError('cannot write to readonly file', {
        code: 'EINVAL'
      })
    }
    await withVFSErr(this._writable.write({
      type: 'write',
      data,
      position
    }))
    return data.byteLength
  }

  static async open (
    handle: FileSystemFileHandle,
    write: boolean,
    truncate: boolean
  ) {
    let w: Promise<WritableStream> | undefined
    try {
      const [file, writable] = await withVFSErr(Promise.all([
        handle.getFile(),
        w = write ? handle.createWritable({ keepExistingData: !truncate }) : undefined
      ]))

      return new FSAccessVFSFileHandle(handle, file, writable)
    } catch (err) {
      await w?.then(s => s.abort(err)).catch(() => {})
      throw err
    }
  }
}

export class FSAccessVFS extends VFS {
  private _root: FileSystemFileHandle | FileSystemDirectoryHandle

  constructor (handle: FileSystemDirectoryHandle | FileSystemFileHandle) {
    super()
    this._root = handle
  }

  private async _partialLocate (path: string[], expectAll: boolean) {
    if (!path.length) return null
    if (this._root.kind !== 'directory') {
      throw new VFSError('cannot traverse single-file filesystem', { code: 'ENOTDIR' })
    }
    const parents: FileSystemDirectoryHandle[] = []
    let curDir = this._root
    for (let i = 0; i < path.length - 1; ++i) {
      if (!path[i] || path[i] === '.') continue
      if (path[i] === '..') {
        if (parents.length) {
          curDir = parents.pop()!
        }
        continue
      }
      try {
        curDir = await curDir.getDirectoryHandle(path[i])
        parents.push(curDir)
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'TypeMismatchError') {
            throw new VFSError('not a directory', { code: 'ENOTDIR', cause: err })
          }
          if (err.name === 'NotFoundError' && !expectAll) {
            return {
              last: curDir,
              rem: i
            }
          }
        }
        throw wrapVFSErr(err)
      }
    }
    if (path[path.length - 1] === '..') {
      if (parents.length < 2) return null
      return {
        last: parents[parents.length - 2],
        rem: parents.length - 1
      }
    }
    return {
      last: curDir,
      rem: path.length - 1
    }
  }

  private async _locate (path: string[]) {
    const partial = await this._partialLocate(path, true)
    return partial && {
      parent: partial.last,
      name: path[partial.rem]
    }
  }

  private async _file (path: string[], create?: boolean) {
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

  private async _dir (path: string[], create?: boolean) {
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

  protected async _appendFile (file: string[], data: Uint8Array, signal?: AbortSignal | undefined) {
    const f = await this._file(file, true)
    let w: Promise<WritableStream> | undefined
    try {
      const [fileObj, writable] = await withVFSErr(Promise.all([
        f.getFile(),
        w = f.createWritable({ keepExistingData: true })
      ]))
      if (signal) {
        throwIfAborted(signal)
        signal.addEventListener('abort', () => {
          writable.abort(signal.reason)
        }, { once: true })
      }
      await withVFSErr(writable.write({
        type: 'write',
        position: fileObj.size,
        data
      }))
      await withVFSErr(writable.close())
    } catch (err) {
      await w?.then(stream => stream.abort(err)).catch(() => {})
    }
  }

  protected _appendFileStream (file: string[], signal?: AbortSignal | undefined) {
    return wrapWriteStream(async () => {
      const f = await this._file(file, true)
      let w: Promise<WritableStream> | undefined
      try {
        const [fileObj, writable] = await withVFSErr(Promise.all([
          f.getFile(),
          w = f.createWritable({ keepExistingData: true })
        ]))
        await withVFSErr(writable.seek(fileObj.size))
        return writable
      } catch (err) {
        await w?.then(w => w.abort(err)).catch(() => {})
        throw err
      }
    }, signal)
  }

  protected async _copyFileRaw (
    src: FileSystemFileHandle,
    dst: FileSystemFileHandle,
    signal?: AbortSignal
  ) {
    throwIfAborted(signal)
    let srcRead: Promise<ReadableStream> | undefined
    let tgtWrite: Promise<WritableStream> | undefined
    try {
      // if either of these promises fail, must close the other in finally block
      const [srcStream, dstStream] = await Promise.all([
        srcRead = src.getFile().then(s => s.stream()),
        tgtWrite = dst.createWritable()
      ])
      await srcStream.pipeTo(dstStream, { signal })
    } catch (err) {
      await Promise.all([
        srcRead?.then(s => s.cancel(err)),
        tgtWrite?.then(w => w.abort(err))
      ]).catch(() => {})
    }
  }

  protected async _copyFile (src: string[], dst: string[], signal?: AbortSignal | undefined) {
    const [srcFile, dstFile] = await Promise.all([this._file(src), this._file(dst, true)])

    return await withVFSErr(this._copyFileRaw(srcFile, dstFile, signal))
  }

  protected async _copyDirRecurse (
    src: FileSystemDirectoryHandle,
    dst: FileSystemDirectoryHandle,
    signal: AbortSignal
  ) {
    throwIfAborted(signal)
    const copies: Promise<void>[] = []

    for await (const [name, sub] of src.entries()) {
      throwIfAborted(signal)
      const copy = sub.kind === 'file'
        ? dst.getFileHandle(name, { create: true })
          .then(f => this._copyFileRaw(sub, f, signal))
        : dst.getDirectoryHandle(name, { create: true })
          .then(d => this._copyDirRecurse(sub, d, signal))
      copies.push(copy)
    }
    await Promise.all(copies)
  }

  protected async _copyDirRaw (
    src: FileSystemDirectoryHandle,
    dst: FileSystemDirectoryHandle,
    signal?: AbortSignal
  ) {
    throwIfAborted(signal)
    const ctrl = new AbortController()
    signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })

    try {
      await this._copyDirRecurse(src, dst, ctrl.signal)
    } catch (err) {
      const wrapped = wrapVFSErr(err)
      ctrl.abort(wrapped)
      throw wrapped
    }
  }

  protected async _copyDir (src: string[], dst: string[], signal?: AbortSignal | undefined) {
    const [srcDir, dstDir] = await Promise.all([this._dir(src), this._dir(dst, true)])

    await this._copyDirRaw(srcDir, dstDir, signal)
  }

  protected async _exists (file: string[]) {
    try {
      const result = await this._locate(file)
      if (!result) return true
      try {
        await result.parent.getFileHandle(result.name)
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'TypeMismatchError') {
          throw wrapVFSErr(err)
        }
      }
      return true
    } catch (err) {
      if (err instanceof VFSError && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return false
      }
      throw err
    }
  }

  protected async _lstat (file: string[]) {
    return this._stat(file)
  }

  protected async _openFile (file: string[], _read: boolean, write: boolean, truncate: boolean) {
    // always must open for read to stat
    return await FSAccessVFSFileHandle.open(
      await this._file(file),
      write,
      truncate
    )
  }

  protected async _readDir (dir: string[]) {
    const names: string[] = []
    const vfsDir = await this._dir(dir)

    try {
      for await (const name of vfsDir.keys()) {
        names.push(name)
      }
    } catch (err) {
      throw wrapVFSErr(err)
    }

    return names
  }

  protected async _readDirent (dir: string[]) {
    const dirents: VFSDirent[] = []
    const vfsDir = await this._dir(dir)

    try {
      for await (const [name, entry] of vfsDir.entries()) {
        dirents.push({
          name,
          type: entry.kind === 'file' ? 'file' : 'dir'
        })
      }
    } catch (err) {
      throw wrapVFSErr(err)
    }

    return dirents
  }

  protected async _readFile (file: string[], _signal?: AbortSignal | undefined) {
    const vfsFile = await this._file(file)

    // No extra error handling needed here because only the file itself can cause an error
    const buf = await withVFSErr(vfsFile.getFile().then(f => f.arrayBuffer()))

    return new Uint8Array(buf)
  }

  protected _readFileStream (file: string[], signal?: AbortSignal | undefined) {
    return wrapReadStream(async () => {
      const vfsFile = await this._file(file)
      return await withVFSErr(vfsFile.getFile().then(f => f.stream()))
    }, signal)
  }

  protected async _realPath (link: string[]) {
    await this._locate(link)
    // no symlinks here
    return path.normalize(`/${link.join('/')}`)
  }

  protected async _removeDir (
    dir: string[],
    recursive: boolean,
    _signal?: AbortSignal | undefined
  ) {
    const loc = await this._locate(dir)
    if (!loc) {
      throw new VFSError('cannot remove root', { code: 'EPERM' })
    }

    try {
      await loc.parent.getDirectoryHandle(loc.name)
    } catch (err) {
      if (err instanceof Error && err.name === 'TypeMismatchError') {
        throw new VFSError('not a directory', { code: 'ENOTDIR', cause: err })
      }
      throw wrapVFSErr(err)
    }

    await withVFSErr(loc.parent.removeEntry(loc.name, { recursive }))
  }

  protected async _removeFile (
    file: string[],
    _signal?: AbortSignal | undefined
  ) {
    const loc = await this._locate(file)
    if (!loc) {
      throw new VFSError('cannot remove root', { code: 'EPERM' })
    }

    try {
      await loc.parent.getFileHandle(loc.name)
    } catch (err) {
      if (err instanceof Error && err.name === 'TypeMismatchError') {
        throw new VFSError('not a file', { code: 'EISDIR', cause: err })
      }
      throw wrapVFSErr(err)
    }

    await withVFSErr(loc.parent.removeEntry(loc.name))
  }

  protected async _stat (file: string[]) {
    const loc = await this._locate(file)
    if (!loc) {
      return this._root.kind === 'directory'
        ? { type: 'dir' as const, size: 0 }
        : { type: 'file' as const, size: (await this._root.getFile()).size }
    }
    try {
      const entry = await loc.parent.getFileHandle(loc.name)
      return {
        type: 'file' as const,
        size: (await entry.getFile()).size
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TypeMismatchError') {
        return { type: 'dir' as const, size: 0 }
      }
      throw wrapVFSErr(err)
    }
  }

  protected async _symlink (_target: string[], _link: string[]) {
    throw new VFSError('symlinks not supported in FS Access API', { code: 'ENOSYS' })
  }

  protected async _readSymlink (link: string[]): Promise<never> {
    throw new VFSError('symlinks not supported in FS Access API', { code: 'ENOSYS' })
  }

  // unfortunately, 'move' isn't widely available yet, so this method is long and slow
  protected async _rename (src: string[], dst: string[]) {
    const [srcLoc, tgtLoc] = await Promise.all([this._locate(src), this._locate(dst)])
    if (!srcLoc) {
      throw new VFSError('cannot rename root', { code: 'EINVAL' })
    }
    if (!tgtLoc) {
      throw new VFSError('cannot rename to root', { code: 'EINVAL' })
    }
    const handle = await withVFSErr(srcLoc.parent.getFileHandle(srcLoc.name)
      .catch(err => {
        if (err instanceof Error && err.name === 'TypeMismatchError') {
          return srcLoc.parent.getDirectoryHandle(srcLoc.name)
        }
        throw err
      })
    )

    try {
      if (isMovable(handle)) {
        await withVFSErr(handle.move(tgtLoc.parent, tgtLoc.name))
        return
      }
    } catch (err) {
      // this API is buggy - may have failed on a directory
      // pass for now
    }

    if (handle.kind === 'file') {
      const out = await tgtLoc.parent.getFileHandle(tgtLoc.name, { create: true })
        .catch(err => {
          if (err instanceof Error && err.name === 'TypeMismatchError') {
            throw new VFSError('not a file', { code: 'EISDIR', cause: err })
          }
          throw wrapVFSErr(err)
        })
      await withVFSErr(this._copyFileRaw(handle, out))
      await withVFSErr(srcLoc.parent.removeEntry(srcLoc.name))
    } else {
      try {
        await tgtLoc.parent.getDirectoryHandle(tgtLoc.name)
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'NotFoundError') {
            const entry = await withVFSErr(
              tgtLoc.parent.getDirectoryHandle(tgtLoc.name, { create: true })
            )
            await this._copyDirRaw(handle, entry)
            await withVFSErr(srcLoc.parent.removeEntry(srcLoc.name, { recursive: true }))
          } else if (err.name === 'TypeMismatchError') {
            throw new VFSError('file exists', { code: 'EEXIST' })
          }
        }
        throw wrapVFSErr(err)
      }
      throw new VFSError('directory already exists', { code: 'EEXIST' })
    }
  }

  protected async _mkdir (dir: string[], recursive: boolean) {
    const loc = await this._partialLocate(dir, !recursive)
    if (!loc) {
      throw new VFSError('cannot create root directory', { code: 'EINVAL' })
    }
    let cur = loc.last
    for (let i = loc.rem; i < dir.length; ++i) {
      try {
        await cur.getDirectoryHandle(dir[i], { create: recursive })
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'NotFoundError') {
            await withVFSErr(cur.getDirectoryHandle(dir[i], { create: true }))
            return
          } else if (err.name === 'TypeMismatchError') {
            throw new VFSError('file exists', { code: 'EEXIST' })
          }
        }
        throw wrapVFSErr(err)
      }
    }
    if (!recursive) {
      throw new VFSError('directory already exists', { code: 'EEXIST' })
    }
  }

  protected async _truncate (file: string[], to: number) {
    const f = await this._file(file)
    const writable = await withVFSErr(f.createWritable())
    // TODO: surely this closes the stream if this errors? if not we need a try block
    await withVFSErr(writable.truncate(to))
  }

  protected async _watch (
    _glob: string,
    _watcher: VFSWatchCallback,
    _onError: VFSWatchErrorCallback
  ): Promise<never> {
    throw new VFSError('watching not supported in FS Access API', { code: 'ENOSYS' })
  }

  protected async _writeFile (file: string[], data: Uint8Array, signal?: AbortSignal | undefined) {
    const f = await this._file(file, true)
    const writable = await withVFSErr(f.createWritable())
    await writable.write(data)
  }

  protected _writeFileStream (file: string[], signal?: AbortSignal | undefined) {
    return wrapWriteStream(async () => {
      const f = await this._file(file, true)
      return await withVFSErr(f.createWritable())
    }, signal)
  }
}
