/// <reference types="vscode" />
/// <reference types="node" />

import { VFS, VFSError, VFSFileHandle, path as vfsPath } from '@socketsecurity/vfs'
import * as vscode from 'vscode'

import type {
  VFSWriteStream, VFSDirent, VFSEntryType, VFSErrorCode,
  VFSReadStream, VFSWatchCallback, VFSWatchErrorCallback, VFSStats
, VFSWatchUnsubscribe
} from '@socketsecurity/vfs'
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from 'node:stream/web'

// This adds some nonexistent properties to ReadableStream (Symbol.asyncIterator)
// that do not exist in browsers, but do in Node.js
// Unfortunately we need them
declare global {
  interface ReadableStream<R = any> extends NodeReadableStream<R> {}
  interface WritableStream<W = any> extends NodeWritableStream<W> {}
}

const vsErrorCodeMap: Record<string, VFSErrorCode> = {
  FileExists: 'EEXIST',
  FileIsADirectory: 'EISDIR',
  FileNotADirectory: 'ENOTDIR',
  FileNotFound: 'ENOENT',
  NoPermissions: 'EPERM',
  Unavailable: 'EBUSY',
  Unknown: 'EUNKNOWN'
}

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`)
  }
  if (err.name === 'AbortError') return err
  if (err.name === 'VFSError') return err
  let code: VFSErrorCode = 'EUNKNOWN'
  if (err instanceof vscode.FileSystemError) {
    code = vsErrorCodeMap[err.code] ?? 'EUNKNOWN'
  }
  return new VFSError(err.message, { code, cause: err })
}

const withVFSErr = <T>(thenable: Thenable<T>) => thenable.then(data => data, err => {
  throw wrapVFSErr(err)
})

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw wrapVFSErr(signal.reason)
  }
}

declare const ReadableStream: typeof NodeReadableStream
declare const WritableStream: typeof NodeWritableStream

const getNodeStreams = (): {
  ReadableStream: typeof ReadableStream
  WritableStream: typeof WritableStream
} => {
  try {
    const req = require('node:streams/web')
    if (!req?.ReadableStream || !req?.WritableStream) {
      throw new Error('missing webstreams module')
    }
    return req
  } catch (err) {
    // may work in modern Node; if not, shows an accurate error message
    return { ReadableStream, WritableStream }
  }
}

const createReadStream = (
  getURI: () => Promise<vscode.Uri>,
  signal?: AbortSignal
): VFSReadStream => {
  const RS = typeof ReadableStream === 'undefined'
    ? getNodeStreams().ReadableStream
    : ReadableStream
  throwIfAborted(signal)
  return new RS({
    async start (ctrl) {
      try {
        const uri = await getURI()
        throwIfAborted(signal)
        const data = await withVFSErr(vscode.workspace.fs.readFile(uri))
        ctrl.enqueue(data)
      } catch (err) {
        ctrl.error(err)
      }
    }
  })
}

const createWriteStream = (
  getURI: () => Promise<vscode.Uri>,
  append: boolean,
  signal?: AbortSignal
): VFSWriteStream => {
  const WS = typeof WritableStream === 'undefined'
    ? getNodeStreams().WritableStream
    : WritableStream
  throwIfAborted(signal)
  let doInit!: () => void
  const init = new Promise<void>(resolve => {
    doInit = resolve
  })
  let uri!: vscode.Uri
  let buf: Uint8Array = new Uint8Array(0)
  return new WS<Uint8Array>({
    async start (ctrl) {
      try {
        const useURI = await getURI()
        throwIfAborted(signal)
        if (append) {
          buf = await withVFSErr(vscode.workspace.fs.readFile(uri))
        }
        uri = useURI
        doInit()
      } catch (err) {
        ctrl.error(err)
      }
    },
    async write (chunk) {
      await init
      const needSize = chunk.byteLength + buf.byteLength
      if (buf.buffer.byteLength < needSize) {
        const newBuf = new Uint8Array(Math.max(needSize, buf.buffer.byteLength * 2))
        newBuf.set(buf)
        buf = newBuf
      }
      const oldLen = buf.byteLength
      buf = new Uint8Array(buf.buffer, 0, needSize)
      buf.set(chunk, oldLen)
      await withVFSErr(vscode.workspace.fs.writeFile(uri, buf))
    }
  }, { size: v => v!.byteLength, highWaterMark: 65536 })
}

const getEntryType = (ftype: vscode.FileType): VFSEntryType | null => {
  if (ftype & vscode.FileType.SymbolicLink) return 'symlink'
  if (ftype & vscode.FileType.Directory) return 'dir'
  if (ftype & vscode.FileType.File) return 'file'
  return null
}

const replaceGlobCasedChars = (chars: string) =>
  chars.replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)

// TODO: can VSCode do case insensitive match without this?
const caseDesensitizeGlob = (pattern: string) => {
  let out = ''
  const charGroup = /\[[^\]]+?\]/g
  let lastIndex = 0
  for (let match: RegExpExecArray | null = null; (match = charGroup.exec(pattern));) {
    out += replaceGlobCasedChars(pattern.slice(lastIndex, match.index)) + match[0]
    lastIndex = match.index + match[0].length
  }
  out += replaceGlobCasedChars(pattern.slice(lastIndex))
  return out
}

class VSCodeVFSFileHandle extends VFSFileHandle {
  private _uri: vscode.Uri

  private constructor (uri: vscode.Uri) {
    super()
    this._uri = uri
  }

  protected async _stat (): Promise<VFSStats> {
    const stats = await withVFSErr(vscode.workspace.fs.stat(this._uri))

    const entryType = getEntryType(stats.type)
    if (!entryType) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      type: entryType,
      size: stats.size
    }
  }

  protected async _truncate (to: number) {
    const readResult = await withVFSErr(
      vscode.workspace.fs.readFile(this._uri)
    )
    await withVFSErr(vscode.workspace.fs.writeFile(this._uri, readResult.subarray(0, to)))
  }

  protected async _flush () {
    // noop, auto flushed
  }

  protected async _read (into: Uint8Array, position: number): Promise<number> {
    const readResult = await withVFSErr(vscode.workspace.fs.readFile(this._uri))
    const sub = readResult.subarray(position, position + into.byteLength)
    into.set(sub)
    return sub.byteLength
  }

  protected async _write (data: Uint8Array, position: number) {
    let toWrite = await withVFSErr(vscode.workspace.fs.readFile(this._uri))
    const needSize = position + data.byteLength
    if (needSize > toWrite.buffer.byteLength) {
      const newBuf = new Uint8Array(needSize)
      newBuf.set(toWrite)
    } else {
      toWrite = new Uint8Array(toWrite.buffer, toWrite.byteOffset, needSize)
    }
    toWrite.set(data, position)
    await withVFSErr(vscode.workspace.fs.writeFile(this._uri, data))
    return data.byteLength
  }

  protected async _close () {
    // noop
  }

  static async open (uri: vscode.Uri) {
    return new VSCodeVFSFileHandle(uri)
  }
}

export class NodeVFS extends VFS {
  private _base: vscode.Uri

  constructor (baseUri: vscode.Uri) {
    super()
    this._base = baseUri.with({
      // No real way to resolve symlinks - assume the input path has none
      path: vfsPath.normalize(baseUri.path),
    })
  }

  private _getURI (src: string[]) {
    if (src.some(part => /\\|\//.test(part))) {
      throw new VFSError('no such file or directory', { code: 'ENOENT' })
    }
    return src.length ? this._base.with({
      path: this._base.path + '/' + src.join('/')
    }) : this._base
  }

  private _relURI (uri: vscode.Uri) {
    // TODO: do fragment and query matter here?
    const normalizedPath = vfsPath.normalize(uri.path)
    const rel = normalizedPath.startsWith(this._base.path)
      ? normalizedPath.length > this._base.path.length
        ? normalizedPath[this._base.path.length] === '/'
          ? normalizedPath.slice(this._base.path.length + 1)
          : null
        : '.'
      : null

    if (
      uri.scheme !== this._base.scheme ||
      uri.authority !== this._base.authority ||
      rel === null
    ) {
      throw new VFSError('cannot create relative path')
    }
    return rel
  }

  // don't use unless needed - vscode functions will error anyway
  private async _file (src: string[], noExistOK = false) {
    const uri = this._getURI(src)
    try {
      const stats = await withVFSErr(vscode.workspace.fs.stat(uri))
      if (!(stats.type & vscode.FileType.File)) {
        // TODO: handle unknowns
        throw new VFSError('not a file', { code: 'EISDIR' })
      }
    } catch (err) {
      if (!(err instanceof VFSError) || err.code !== 'ENOENT' || !noExistOK) {
        throw err
      }
    }
    return uri
  }

  // don't use unless needed - vscode functions will error anyway
  private async _dir (src: string[], noExistOK = false) {
    const uri = this._getURI(src)
    try {
      const stats = await withVFSErr(vscode.workspace.fs.stat(uri))
      if (!(stats.type & vscode.FileType.Directory)) {
        // TODO: handle unknowns
        throw new VFSError('not a directory', { code: 'ENOTDIR' })
      }
    } catch (err) {
      if (!(err instanceof VFSError) || err.code !== 'ENOENT' || !noExistOK) {
        throw err
      }
    }
    return uri
  }

  protected async _appendFile (file: string[], data: Uint8Array, signal?: AbortSignal) {
    const uri = this._getURI(file)
    let writeInto = await withVFSErr(vscode.workspace.fs.readFile(uri))
    const oldLen = writeInto.byteLength
    const needSize = writeInto.byteLength + data.byteLength
    if (writeInto.buffer.byteLength < needSize) {
      const newBuf = new Uint8Array(needSize)
      newBuf.set(writeInto)
      writeInto = newBuf
    } else {
      writeInto = new Uint8Array(writeInto.buffer, writeInto.byteOffset, needSize)
    }
    writeInto.set(data, oldLen)
    throwIfAborted(signal)
    await withVFSErr(vscode.workspace.fs.writeFile(uri, writeInto))
  }

  protected _appendFileStream (file: string[], signal?: AbortSignal | undefined) {
    return createWriteStream(() => this._file(file), true, signal)
  }

  protected async _copyDir (src: string[], dst: string[], signal?: AbortSignal | undefined) {
    const [srcURI, dstURI] = await Promise.all([
      this._dir(src),
      this._dir(dst, true)
    ])
    throwIfAborted(signal)
    await withVFSErr(vscode.workspace.fs.copy(srcURI, dstURI, { overwrite: true }))
  }

  protected async _copyFile (src: string[], dst: string[], signal?: AbortSignal | undefined) {
    const [srcURI, dstURI] = await Promise.all([
      this._file(src),
      this._file(dst, true)
    ])
    throwIfAborted(signal)
    await withVFSErr(vscode.workspace.fs.copy(srcURI, dstURI, { overwrite: true }))
  }

  protected async _exists (file: string[]) {
    // Node.js doesn't like this because it allows for race conditions
    // We accept that risk here - avoid existsSync to not block
    try {
      // no this.fsPath because this is a public API method
      await withVFSErr(vscode.workspace.fs.stat(this._getURI(file)))
      return true
    } catch (err) {
      if (err instanceof VFSError && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return false
      }
      throw err
    }
  }

  protected async _readDir (dir: string[]) {
    const dirents = await withVFSErr(vscode.workspace.fs.readDirectory(this._getURI(dir)))
    return dirents.map(v => v[0])
  }

  protected async _readDirent (dir: string[]) {
    const dirents = await withVFSErr(vscode.workspace.fs.readDirectory(this._getURI(dir)))

    return dirents.map<VFSDirent | null>(([name, entryType]) => {
      const type = getEntryType(entryType)
      return type && {
        type,
        name
      }
    }).filter((ent): ent is VFSDirent => ent !== null)
  }

  protected async _readFile (file: string[], signal?: AbortSignal | undefined) {
    return await withVFSErr(vscode.workspace.fs.readFile(this._getURI(file)))
  }

  protected _readFileStream (file: string[], signal?: AbortSignal | undefined) {
    return createReadStream(() => this._file(file), signal)
  }

  protected async _removeDir (
    dir: string[],
    recursive: boolean,
    _signal?: AbortSignal | undefined
  ) {
    // TODO: don't use trash? using it seems a good idea for user-facing VFS
    await withVFSErr(
      vscode.workspace.fs.delete(await this._dir(dir), {
        recursive,
        useTrash: true
      })
    )
  }

  protected async _removeFile (
    file: string[],
    _signal?: AbortSignal | undefined
  ) {
    // TODO: don't use trash? using it seems a good idea for user-facing VFS
    await withVFSErr(
      vscode.workspace.fs.delete(await this._file(file), {
        useTrash: true
      })
    )
  }

  protected async _stat (file: string[]) {
    const stat = await withVFSErr(vscode.workspace.fs.stat(this._getURI(file)))
    const type = getEntryType(stat.type)

    if (!type) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      size: stat.size,
      type
    }
  }

  protected async _lstat (file: string[]) {
    // TODO: this method seems impossible to implement correctly
    return this._stat(file)
  }

  protected async _writeFile (file: string[], data: Uint8Array, _signal?: AbortSignal | undefined) {
    await withVFSErr(vscode.workspace.fs.writeFile(this._getURI(file), data))
  }

  protected _writeFileStream (file: string[], _signal?: AbortSignal | undefined) {
    return createWriteStream(() => this._file(file), false)
  }

  protected async _truncate (file: string[], to: number) {
    const uri = this._getURI(file)
    const readResult = await withVFSErr(
      vscode.workspace.fs.readFile(uri)
    )
    await withVFSErr(vscode.workspace.fs.writeFile(uri, readResult.subarray(0, to)))
  }

  protected async _symlink (_target: string[], _link: string[], _relative: boolean) {
    throw new VFSError('cannot directly use symlinks in vscode', { code: 'ENOSYS' })
  }

  protected async _realPath (link: string[]) {
    // TODO: how to read symlinks?
    return vfsPath.normalize('/' + link.join('/'))
  }

  protected async _readSymlink (_link: string[]): Promise<never> {
    throw new VFSError('cannot directly use symlinks in vscode', { code: 'ENOSYS' })
  }

  protected async _rename (src: string[], dst: string[]) {
    await withVFSErr(vscode.workspace.fs.rename(this._getURI(src), this._getURI(dst)))
  }

  protected async _mkdir (dir: string[], recursive: boolean) {
    if (!recursive) {
      try {
        const dirents = await this._readDir(dir)
        if (dirents.length !== 0) {
          throw new VFSError('directory not empty', { code: 'ENOTEMPTY' })
        }
      } catch (err) {
        if (!(err instanceof VFSError) || err.code !== 'ENOENT') {
          throw err
        }
        // annoyingly, have to try to find a parent
        // TODO: we can't handle symlink resolution here - probably doesn't matter
        const normalizedDir = vfsPath.normalize(dir.join('/')).split('/')
        normalizedDir.pop()
        await this._dir(normalizedDir)
        // hopefully now we've verified the parent exists
      }
    }
    await withVFSErr(vscode.workspace.fs.createDirectory(this._getURI(dir)))
  }

  protected async _openFile (file: string[], _read: boolean, _write: boolean, _truncate: boolean) {
    // TODO: this doesn't actually open the file, just a fake wrapper
    // Maybe factor this out to a dedicated wrapper package like @socketsecurity/vfs-readonly
    return await VSCodeVFSFileHandle.open(await this._file(file))
  }

  protected async _watch (
    glob: string,
    onEvent: VFSWatchCallback,
    _onError: VFSWatchErrorCallback
  ): Promise<VFSWatchUnsubscribe> {
    // hackery to disable case sensitivity
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._base, caseDesensitizeGlob(glob))
    )

    watcher.onDidCreate(uri => onEvent({
      type: 'create',
      path: this._relURI(uri)
    }))
    watcher.onDidDelete(uri => onEvent({
      type: 'delete',
      path: this._relURI(uri)
    }))
    watcher.onDidChange(uri => onEvent({
      type: 'update',
      path: this._relURI(uri)
    }))

    return async () => {
      watcher.dispose()
    }
  }
}
