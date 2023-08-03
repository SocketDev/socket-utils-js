import { VFS, VFSError, VFSFileHandle, path as vfsPath } from '@socketsecurity/vfs'

import type {
  VFSDirent, VFSEntryType, VFSStats, VFSReadStream,
  VFSWriteStream, VFSWatchCallback, VFSWatchErrorCallback
} from '@socketsecurity/vfs'

const enum FileNodeType {
  File = 0,
  Dir = 1,
  Symlink = 2,
  Mount = 3
}

const enum FileBackingType {
  Pool = 0,
  Raw = 1
}

type BufferPoolRef = {
  src: FileBackingType.Pool
  pool: number
  start: number
  len: number
}

type RawRef = {
  src: FileBackingType.Raw
  // protect against accidentally assigning Uint8Array
  buf: ArrayBuffer & { buffer?: undefined }
  len: number
}

type ContentRef = BufferPoolRef | RawRef

type FileNode = {
  type: FileNodeType.File
  // null = empty file
  content: ContentRef | null
}

type DirNode = {
  type: FileNodeType.Dir
  children: Map<string, FSNode>
}

type SymlinkNode = {
  type: FileNodeType.Symlink
  to: string[]
  relative: boolean
}

type MountNode = {
  type: FileNodeType.Mount
  mountPath: string[]
  vfs: VFS
}

type FSNode = FileNode | DirNode | SymlinkNode | MountNode

const enum FindContextCreateMode {
  None = 0,
  File = 1,
  Dir = 2,
  Symlink = 4,
  Recurse = 8,
  DidCreate = 16
}

type FindContext = {
  node: FSNode
  path: ReadonlyArray<string>
  parents: DirNode[]
  thruLast: boolean
  create: FindContextCreateMode
  i: number
  depth: number
}

type BaseFindResult = {
  ctx: FindContext
}

type MountFindResult = BaseFindResult & {
  mount: true
  vfs: VFS
  path: string[]
}

type NonMountFindResult = BaseFindResult & {
  mount: false
  node: FSNode
}

type FileFindResult = NonMountFindResult & {
  node: FileNode
}

type DirFindResult = NonMountFindResult & {
  node: DirNode
}

export interface MemVFSPoolSpec {
  blockSize: number
  count: number
}

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`)
  }
  if (err.name === 'VFSError') return err
  if (err.name === 'AbortError') return err
  return new VFSError(err.message, { cause: err })
}

const withVFSErr = <T>(prom: Promise<T>) => prom.catch(err => {
  throw wrapVFSErr(err)
})

type FSFilePool = {
  buf: ArrayBuffer & { buffer?: undefined }
  // current byte index in pool
  ind: number
  // block size
  block: number
  // free blocks (only used after ind == buf.length)
  free: number[]
  // allocated blocks - should be relatively cheap as these are pointers to existing objects
  allocated: Set<BufferPoolRef>
  // flag to determine if the pool has grown beyond its initial capacity yet
  hasGrown: boolean
}

// mutates entry.start
const allocPool = (pool: FSFilePool, entry: BufferPoolRef, growthFactor: number) => {
  pool.allocated.add(entry)
  if (pool.free.length) {
    entry.start = pool.free.pop()!
    return entry
  }
  if (pool.ind < pool.buf.byteLength) {
    entry.start = pool.ind
    pool.ind += pool.block
    return entry
  }
  const newCount = Math.floor(pool.buf.byteLength / pool.block * growthFactor) + 1
  const newBuf = new Uint8Array(newCount * pool.block)
  newBuf.set(new Uint8Array(pool.buf))
  pool.buf = newBuf.buffer
  pool.hasGrown = true
  entry.start = pool.ind
  pool.ind += pool.block
  return entry
}

const freePool = (
  pool: FSFilePool,
  entry: BufferPoolRef,
  shrinkRatio: number,
  shrinkRetain: number
) => {
  pool.free.push(entry.start)
  pool.allocated.delete(entry)
  const freeBytes = pool.buf.byteLength - pool.allocated.size * pool.block
  if (pool.hasGrown && freeBytes * shrinkRatio < pool.buf.byteLength) {
    const newCount = Math.ceil(pool.allocated.size * shrinkRetain)
    const newBuf = new Uint8Array(newCount * pool.block)
    let ind = 0
    // optimization: majority of these should be contiguous, only interrupted by frees
    // batch the .set calls together for those cases
    let oldContiguousStart = -1
    let oldDelta = -1
    for (const allocRef of pool.allocated) {
      if (ind + oldDelta !== allocRef.start) {
        if (oldContiguousStart !== -1) {
          newBuf.set(
            new Uint8Array(pool.buf, oldContiguousStart, ind + oldDelta),
            oldContiguousStart - oldDelta
          )
        }
        oldContiguousStart = allocRef.start
        oldDelta = oldContiguousStart - ind
      }
      allocRef.start = ind
      ind += pool.block
    }
    if (oldContiguousStart !== -1) {
      newBuf.set(
        new Uint8Array(pool.buf, oldContiguousStart, ind + oldDelta),
        oldContiguousStart - oldDelta
      )
    }
    pool.buf = newBuf.buffer
    pool.free.length = 0
    pool.ind = ind
  }
}

class MemVFSFileHandle extends VFSFileHandle {
  private _fs: MemVFS | null
  private _node: FileNode | null

  private constructor (fs: MemVFS, node: FileNode) {
    super()
    this._fs = fs
    this._node = node
  }

  protected async _close () {
    this._node = null
    this._fs = null
  }

  protected async _flush () {
    // noop, all writes automatically flushed
  }

  protected async _read (into: Uint8Array, position: number) {
    const value = this._fs!['_readRaw'](this._node!.content)
    into.set(value.subarray(position, position + into.byteLength))
    return into.byteLength
  }

  protected async _stat (): Promise<VFSStats> {
    return {
      type: 'file',
      size: this._node!.content ? this._node!.content.len : 0
    }
  }

  protected async _truncate (to: number) {
    this._fs!['_truncateRaw'](this._node!, to, true)
  }

  protected async _write (data: Uint8Array, position: number) {
    this._fs!['_writeRaw'](this._node!, data, position)
    return data.byteLength
  }

  static open (fs: MemVFS, node: FileNode) {
    return new MemVFSFileHandle(fs, node)
  }
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw wrapVFSErr(signal.reason)
  }
}

const entryTypes: VFSEntryType[] = ['file', 'dir', 'symlink']

const getEntryType = (fileType: FileNodeType) => entryTypes[fileType]

export interface MemVFSOptions {
  pools?: MemVFSPoolSpec[]
  // ratio of file size to allocated size before it can shrink
  fileShrinkRatio?: number
  // ratio of file size to retain when shrinking
  fileShrinkPadding?: number
  // ratio of pool size to allocated size before it can shrink
  poolShrinkRatio?: number
  // ratio of pool size to retain while shrinking
  poolShrinkPadding?: number
  // growth factor for pools when needed
  poolGrowthFactor?: number
  // max symlinks to enter before giving up
  maxLinkDepth?: number
}

// follow unix standards
const MAX_SYMLINKS = 40
const FILE_SHRINK_RATIO = 2
const FILE_SHRINK_PADDING = 0.3
const POOL_SHRINK_RATIO = 3
const POOL_SHRINK_PADDING = 0.5
const POOL_GROWTH_FACTOR = 1.5
const EMPTY_BUF = new Uint8Array(0)

const DEFAULT_POOLS: MemVFSPoolSpec[] = [
  { blockSize: 256, count: 1000 },
  { blockSize: 1024, count: 500 },
  { blockSize: 4096, count: 250 }
]

export class MemVFS extends VFS {
  private _root?: FSNode
  private _pools: FSFilePool[]
  private _shrinkRatio: number
  private _shrinkRetainFactor: number
  private _poolShrinkRatio: number
  private _poolShrinkRetainFactor: number
  private _poolGrowthFactor: number
  private _maxLinkDepth: number

  constructor (options: MemVFSOptions = {}) {
    super()
    this._maxLinkDepth = options.maxLinkDepth ?? MAX_SYMLINKS
    this._shrinkRatio = options.fileShrinkRatio ?? FILE_SHRINK_RATIO
    this._shrinkRetainFactor = (options.fileShrinkPadding ?? FILE_SHRINK_PADDING) + 1
    if (this._shrinkRetainFactor >= this._shrinkRatio) {
      throw new TypeError('file shrink ratio must be less than (1 + file shrink padding)')
    }
    this._poolShrinkRatio = options.poolShrinkRatio ?? POOL_SHRINK_RATIO
    this._poolShrinkRetainFactor = (options.poolShrinkPadding ?? POOL_SHRINK_PADDING) + 1
    if (this._poolShrinkRetainFactor >= this._poolShrinkRatio) {
      throw new TypeError('pool shrink ratio must be less than (1 + pool shrink padding)')
    }
    this._poolGrowthFactor = options.poolGrowthFactor ?? POOL_GROWTH_FACTOR
    if (this._poolGrowthFactor <= 1) {
      throw new TypeError('pool growth factor must be greater than 1')
    }
    this._pools = (options.pools ?? DEFAULT_POOLS).map(pool => {
      const initSize = pool.blockSize * pool.count
      return {
        buf: new ArrayBuffer(initSize),
        ind: 0,
        block: pool.blockSize,
        free: [],
        allocated: new Set<BufferPoolRef>(),
        hasGrown: false
      }
    }).sort((a, b) => a.block - b.block)
    if (this._pools.some((a, i) => i && a.block === this._pools[i - 1].block)) {
      throw new TypeError('each pool must have a distinct block size')
    }
  }

  private _lfind (ctx: FindContext) {
    for (; ctx.i < ctx.path.length; ++ctx.i) {
      const part = ctx.path[ctx.i]
      if (ctx.node.type === FileNodeType.Dir) {
        if (!part || part === '.') continue
        if (part === '..') {
          if (ctx.parents.length) {
            ctx.node = ctx.parents.pop()!
          }
        } else {
          let child = ctx.node.children.get(part)
          if (!child) {
            if (ctx.create & FindContextCreateMode.Recurse || ctx.i === ctx.path.length - 1) {
              if (ctx.create & FindContextCreateMode.Dir) {
                ctx.create |= FindContextCreateMode.DidCreate
                child = {
                  type: FileNodeType.Dir,
                  children: new Map()
                }
              } else if (ctx.create & FindContextCreateMode.File) {
                ctx.create |= FindContextCreateMode.DidCreate
                child = {
                  type: FileNodeType.File,
                  content: null
                }
              } else if (ctx.create & FindContextCreateMode.Symlink) {
                ctx.create |= FindContextCreateMode.DidCreate
                child = {
                  type: FileNodeType.Symlink,
                  to: [],
                  relative: false
                }
              }
            }
            if (!child) {
              throw new VFSError('no such file or directory', { code: 'ENOENT' })
            }
            ctx.node.children.set(part, child)
          }
          ctx.parents.push(ctx.node)
          ctx.node = child
        }
      } else if (ctx.node.type === FileNodeType.File) {
        throw new VFSError('not a directory', { code: 'ENOTDIR' })
      } else {
        return
      }
    }
  }

  private _thrulink (ctx: FindContext) {
    if (
      ctx.node.type === FileNodeType.Symlink &&
      (ctx.i !== ctx.path.length || ctx.thruLast)
    ) {
      if (++ctx.depth >= this._maxLinkDepth) {
        throw new VFSError('symlink depth too high', { code: 'EINVAL' })
      }

      if (ctx.node.relative) {
        const to = ctx.node.to
        if (!ctx.i--) {
          throw new VFSError('cannot read symlink out of root', { code: 'ENOENT' })
        }
        ctx.node = ctx.parents.pop()!
        const newPath = ctx.path.slice(0, ctx.i)
        for (let i = 0; i < to.length; ++i) {
          newPath.push(to[i])
        }
        for (let tail = ctx.i + 1; tail < ctx.path.length; ++tail) {
          newPath.push(ctx.path[tail])
        }
        ctx.path = newPath
      } else {
        const newPath = ctx.node.to.slice()
        for (; ctx.i < ctx.path.length; ++ctx.i) {
          newPath.push(ctx.path[ctx.i])
        }
        if (!ctx.parents.length) {
          // should only ever happen for root symlink / -> /
          throw new VFSError('cannot read symlink out of root', { code: 'ENOENT' })
        }
        ctx.node = ctx.parents[0]
        ctx.path = newPath
        ctx.i = 0
        ctx.parents.length = 0
      }
    }
  }

  private _find (ctx: FindContext) {
    while (ctx.i < ctx.path.length && ctx.node.type !== FileNodeType.Mount) {
      this._lfind(ctx)
      this._thrulink(ctx)
    }
  }

  private _entry (
    path: string[],
    thruLast: boolean,
    create: FindContextCreateMode
  ): MountFindResult | NonMountFindResult {
    if (!this._root) {
      if (create && (create & FindContextCreateMode.Recurse || !path.length)) {
        this._root = create & FindContextCreateMode.Dir
          ? { type: FileNodeType.Dir, children: new Map() }
            : create & FindContextCreateMode.File
              ? { type: FileNodeType.File, content: null }
              : { type: FileNodeType.Symlink, to: [], relative: false }
        create |= FindContextCreateMode.DidCreate
      } else {
        throw new VFSError('no such file or directory', { code: 'ENOENT' })
      }
    }
    const ctx: FindContext = {
      node: this._root,
      path,
      parents: [],
      create,
      thruLast,
      i: 0,
      depth: 0
    }
    this._find(ctx)
    if (ctx.node.type === FileNodeType.Mount) {
      const outPath = ctx.node.mountPath.slice()
      for (let i = ctx.i; i < ctx.path.length; ++i) {
        outPath.push(ctx.path[i])
      }
      return {
        mount: true,
        ctx,
        vfs: ctx.node.vfs,
        path: outPath
      }
    }
    return {
      mount: false,
      ctx,
      node: ctx.node
    }
  }

  private _file (path: string[], create = false): MountFindResult | FileFindResult {
    const result = this._entry(path, true, create ? FindContextCreateMode.File : 0)
    if (!result.mount && result.node.type !== FileNodeType.File) {
      throw new VFSError('not a file', { code: 'EISDIR' })
    }
    return result as MountFindResult | FileFindResult
  }

  private _dir (path: string[], create = false): MountFindResult | DirFindResult {
    const result = this._entry(path, true, create ? FindContextCreateMode.Dir : 0)
    if (!result.mount && result.node.type !== FileNodeType.Dir) {
      throw new VFSError('not a directory', { code: 'ENOTDIR' })
    }
    return result as MountFindResult | DirFindResult
  }

  private _poolRealloc (ref: BufferPoolRef, poolIndex: number) {
    const oldPos = ref.start
    allocPool(
      this._pools[poolIndex],
      ref,
      this._poolGrowthFactor
    )
    new Uint8Array(this._pools[poolIndex].buf, ref.start, ref.len).set(
      new Uint8Array(this._pools[ref.pool].buf, oldPos, ref.len)
    )
    const newPos = ref.start
    // this helps avoid weirdness when downsizing pools
    ref.start = oldPos
    freePool(
      this._pools[ref.pool],
      ref,
      this._poolShrinkRatio,
      this._poolShrinkRetainFactor
    )
    ref.start = newPos
    ref.pool = poolIndex
  }

  private _truncateRaw (node: FileNode, to: number, shrink: boolean) {
    if (!node.content || to >= node.content.len) return
    node.content.len = to
    if (shrink) {
      if (to === 0) {
        if (node.content.src === FileBackingType.Pool) {
          freePool(
            this._pools[node.content.pool],
            node.content,
            this._poolShrinkRatio,
            this._poolShrinkRetainFactor
          )
        }
        node.content = null
        return
      }
      let poolIndex = this._pools.length - 1
      // find smallest pool that fits
      while (poolIndex >= 0 && this._pools[poolIndex].block >= this._shrinkRetainFactor * to) {
        --poolIndex
      }
      poolIndex += 1
      if (node.content.src === FileBackingType.Pool) {
        if (
          to * this._shrinkRatio < this._pools[node.content.pool].block &&
          poolIndex !== node.content.pool
        ) {
          this._poolRealloc(node.content, poolIndex)
        }
      } else if (node.content.src === FileBackingType.Raw) {
        if (to * this._shrinkRatio < node.content.buf.byteLength) {
          if (poolIndex < this._pools.length) {
            const entry: BufferPoolRef = {
              src: FileBackingType.Pool,
              pool: poolIndex,
              start: 0,
              len: to
            }
            allocPool(
              this._pools[poolIndex],
              entry,
              this._poolGrowthFactor
            )
            node.content = entry
          } else {
            const buffer = new Uint8Array(Math.ceil(this._shrinkRetainFactor * to))
            buffer.set(new Uint8Array(node.content.buf, 0, to))
            node.content.buf = buffer.buffer
          }
        }
      }
    }
  }

  private _reserve (node: FileNode, space: number) {
    const allocSize = node.content
      ? node.content.src === FileBackingType.Pool
        ? this._pools[node.content.pool].block
        : node.content.buf.byteLength
      : 0

    if (allocSize >= space) {
      return
    }

    if (!node.content || node.content.src === FileBackingType.Pool) {
      let poolIndex = 0
      while (poolIndex < this._pools.length && this._pools[poolIndex].block < space) {
        ++poolIndex
      }
      if (poolIndex < this._pools.length) {
        if (!node.content) {
          const entry: BufferPoolRef = {
            src: FileBackingType.Pool,
            pool: poolIndex,
            start: 0,
            len: 0
          }
          allocPool(this._pools[poolIndex], entry, this._poolGrowthFactor)
          node.content = entry
        } else {
          this._poolRealloc(node.content, poolIndex)
        }
      } else {
        const newBuf = new Uint8Array(space)
        if (node.content && node.content.len) {
          newBuf.set(new Uint8Array(
            this._pools[node.content.pool].buf,
            node.content.start,
            node.content.len
          ))
        }
        node.content = {
          src: FileBackingType.Raw,
          buf: newBuf.buffer,
          len: 0
        }
      }
    } else {
      const newBuf = new Uint8Array(space)
      newBuf.set(new Uint8Array(node.content.buf, 0, node.content.len))
      node.content.buf = newBuf.buffer
    }
  }

  private _writeRaw (node: FileNode, data: Uint8Array, at: number) {
    const newLen = Math.max(
      at + data.byteLength,
      node.content ? node.content.len : 0
    )
    const allocSize = node.content
      ? node.content.src === FileBackingType.Pool
        ? this._pools[node.content.pool].block
        : node.content.buf.byteLength
      : 0
    if (newLen > allocSize) {
      if (!node.content || node.content.src === FileBackingType.Pool) {
        let poolIndex = 0
        while (poolIndex < this._pools.length && this._pools[poolIndex].block < newLen) {
          ++poolIndex
        }
        if (!node.content) {
          if (poolIndex >= this._pools.length) {
            // no room to grow buffer - optimized for write-once filesystems
            const buf = new Uint8Array(newLen)
            buf.set(data, at)
            node.content = {
              src: FileBackingType.Raw,
              buf: buf.buffer,
              len: newLen
            }
          } else {
            const content: BufferPoolRef = {
              src: FileBackingType.Pool,
              pool: poolIndex,
              start: 0,
              len: newLen
            }
            allocPool(
              this._pools[poolIndex],
              content,
              this._poolGrowthFactor
            )
            const poolBuf = new Uint8Array(
              this._pools[poolIndex].buf,
              content.start,
              this._pools[poolIndex].block
            )
            // pools may have prior data
            if (at) {
              poolBuf.fill(0, 0, at)
            }
            poolBuf.set(data, at)
            node.content = content
          }
        } else {
          if (poolIndex >= this._pools.length) {
            // this has already been written to, so offer shrinkRetainFactor overhead
            const buf = new Uint8Array(Math.ceil(newLen * this._shrinkRetainFactor))
            buf.set(new Uint8Array(
              this._pools[node.content.pool].buf,
              node.content.start,
              node.content.len
            ))
            buf.set(data, at)
            freePool(
              this._pools[node.content.pool],
              node.content,
              this._poolShrinkRatio,
              this._poolShrinkRetainFactor
            )
            node.content = {
              src: FileBackingType.Raw,
              buf: buf.buffer,
              len: newLen
            }
          } else {
            this._poolRealloc(node.content, poolIndex)
            const poolBuf = new Uint8Array(
              this._pools[poolIndex].buf,
              node.content.start,
              this._pools[poolIndex].block
            )
            if (at > node.content.len) {
              // set zeros on the potentially dirty pool space
              poolBuf.fill(0, node.content.len, at)
            }
            node.content.len = newLen
            poolBuf.set(data, at)
          }
        }
      } else {
        const buf = new Uint8Array(Math.ceil(newLen * this._shrinkRetainFactor))
        buf.set(new Uint8Array(node.content.buf, 0, Math.min(node.content.len, at)))
        buf.set(data, at)
        node.content.buf = buf.buffer
        node.content.len = newLen
      }
    } else if (node.content) {
      node.content.len = newLen
      if (node.content.src === FileBackingType.Pool) {
        new Uint8Array(
          this._pools[node.content.pool].buf,
          node.content.start,
          allocSize
        ).set(data, at)
      } else {
        new Uint8Array(node.content.buf).set(data, at)
      }
    }
  }

  private _readRaw (content: ContentRef | null) {
    if (!content) return EMPTY_BUF
    if (content.src === FileBackingType.Pool) {
      return new Uint8Array(this._pools[content.pool].buf,
        content.start,
        content.len
      )
    } else {
      return new Uint8Array(content.buf, 0, content.len)
    }
  }

  private _writeRawStream (node: FileNode | null, offset = 0, signal?: AbortSignal) {
    throwIfAborted(signal)
    return new WritableStream<Uint8Array>({
      start: ctrl => {
        signal?.addEventListener('abort', err => {
          ctrl.error(wrapVFSErr(err))
        }, { once: true })
      },
      write: chunk => {
        this._writeRaw(node!, chunk, offset)
        offset += chunk.byteLength
      },
      close: () => {
        // release reference for GC
        node = null
      },
      abort: () => {
        node = null
      }
    }, new ByteLengthQueuingStrategy({ highWaterMark: 65536 }))
  }

  private _readRawStream (node: FileNode | null, signal?: AbortSignal) {
    const hasBYOB = typeof ReadableByteStreamController !== 'undefined'
    throwIfAborted(signal)
    let bytesRead = 0
    if (!hasBYOB) {
      return new ReadableStream<Uint8Array>({
        start: ctrl => {
          signal?.addEventListener('abort', err => {
            ctrl.error(wrapVFSErr(err))
          }, { once: true })
        },
        pull: ctrl => {
          const readResult = this._readRaw(node!.content)
          const endSize = Math.min(readResult.byteLength, bytesRead + ctrl.desiredSize!)
          ctrl.enqueue(readResult.slice(bytesRead, bytesRead = endSize))
          if (endSize === readResult.byteLength) ctrl.close()
        },
        cancel: () => {
          // release reference for GC
          node = null
        }
      }, new ByteLengthQueuingStrategy({ highWaterMark: 65536 }))
    }
    // we avoid just returning the entire raw chunk here because it would need to be copied
    // for huge files this doesn't have any memory overhead
    return new ReadableStream({
      start: ctrl => {
        signal?.addEventListener('abort', err => {
          ctrl.error(wrapVFSErr(err))
        }, { once: true })
      },
      pull: ctrl => {
        const readResult = this._readRaw(node!.content)
        if (ctrl.byobRequest) {
          const view = ctrl.byobRequest.view!
          const desiredSize = Math.min(ctrl.desiredSize!, view.byteLength)
          const writeInto = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
          if (desiredSize + bytesRead >= readResult.byteLength) {
            writeInto.set(readResult.subarray(bytesRead))
            ctrl.byobRequest.respond(readResult.byteLength - bytesRead)
            ctrl.close()
            bytesRead = readResult.byteLength
          } else {
            writeInto.set(readResult.subarray(bytesRead, bytesRead += desiredSize))
            ctrl.byobRequest.respond(desiredSize)
          }
        } else {
          const endSize = Math.min(readResult.byteLength, bytesRead + ctrl.desiredSize!)
          ctrl.enqueue(readResult.slice(bytesRead, bytesRead = endSize))
          if (endSize === readResult.byteLength) ctrl.close()
        }
      },
      cancel: () => {
        // release reference for GC
        node = null
      },
      autoAllocateChunkSize: 65536,
      type: 'bytes'
    }, { highWaterMark: 65536 })
  }

  protected async _truncate (file: string[], to: number) {
    const node = this._file(file)
    if (node.mount) {
      return node.vfs['_truncate'](node.path, to)
    }
    this._truncateRaw(node.node, to, true)
  }

  protected async _appendFile (file: string[], data: Uint8Array, signal?: AbortSignal) {
    const result = this._file(file, true)
    if (result.mount) {
      return result.vfs['_appendFile'](result.path, data, signal)
    }
    throwIfAborted(signal)
    this._writeRaw(result.node, data, result.node.content ? result.node.content.len : 0)
  }

  protected _appendFileStream (file: string[], signal?: AbortSignal): VFSWriteStream {
    const result = this._file(file, true)
    if (result.mount) {
      return result.vfs['_appendFileStream'](result.path, signal)
    }
    const len = result.node.content ? result.node.content.len : 0
    return this._writeRawStream(result.node, len, signal)
  }

  private async _copyFileFromMount (
    into: FileNode,
    vfs: VFS,
    path: string[],
    signal?: AbortSignal
  ) {
    // for pathologically slow stat
    let cancelReserve = false
    vfs['_stat'](path).then(stats => {
      if (cancelReserve) return
      this._reserve(into, stats.size)
    }).catch(() => {})
    const readStream = vfs['_readFileStream'](path)
    try {
      await withVFSErr(
        readStream.pipeTo(this._writeRawStream(into), { signal })
      )
    } finally {
      cancelReserve = true
    }
  }

  private async _copyFileToMount (
    into: VFS,
    path: string[],
    from: FileNode,
    signal?: AbortSignal
  ) {
    await withVFSErr(
      this._readRawStream(from).pipeTo(into['_writeFileStream'](path), { signal })
    )
  }

  private async _copyFileBetweenMounts (
    into: VFS,
    intoPath: string[],
    from: VFS,
    fromPath: string[],
    signal?: AbortSignal
  ) {
    await withVFSErr(
      from['_readFileStream'](fromPath).pipeTo(
        into['_writeFileStream'](intoPath),
        { signal }
      )
    )
  }

  private async _copyDirFromMount (
    into: DirNode,
    from: VFS,
    path: string[],
    signal: AbortSignal
  ) {
    const childCopies: Promise<void>[] = []
    const dirents = await from['_readDirent'](path)
    throwIfAborted(signal)
    for (const entry of dirents) {
      const curChild = into.children.get(entry.name)
      const curResolvedType = curChild && (
        curChild.type === FileNodeType.Mount
          ? 'mount'
          : getEntryType(curChild.type)
      )
      if (curResolvedType && ((curResolvedType === 'dir') !== (entry.type === 'dir'))) {
        throw new VFSError(`cannot overwrite ${curResolvedType} with ${entry.type}`, {
          code: curResolvedType === 'dir' ? 'ENOTDIR' : 'EISDIR'
        })
      }
      const subPath = path.concat(entry.name)
      if (entry.type === 'dir') {
        const childNode: DirNode = curChild && curChild.type === FileNodeType.Dir
          ? curChild
          : { type: FileNodeType.Dir, children: new Map() }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        into.children.set(entry.name, childNode)
        childCopies.push(this._copyDirFromMount(
          childNode,
          from,
          subPath,
          signal
        ))
      } else if (entry.type === 'file') {
        const childNode: FileNode = curChild && curChild.type === FileNodeType.File
          ? curChild
          : { type: FileNodeType.File, content: null }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        into.children.set(entry.name, childNode)
        childCopies.push(this._copyFileFromMount(
          childNode,
          from,
          subPath,
          signal
        ))
      } else if (entry.type === 'symlink') {
        if (curChild) this._cleanup(curChild)
        childCopies.push(from['_readSymlink'](subPath).then(resolved => {
          const parsed = vfsPath.parse(resolved)
          // verbatim symlinks
          // TODO: these almost always break
          // best used to copy mount -> local -> another mount
          const childNode: SymlinkNode = {
            type: FileNodeType.Symlink,
            to: parsed.parts,
            relative: !parsed.absolute
          }
          into.children.set(entry.name, childNode)
        }))
      }
    }
    await Promise.all(childCopies)
  }

  private async _copyDirToMount (
    into: VFS,
    path: string[],
    from: DirNode,
    signal: AbortSignal
  ) {
    const childCopies: Promise<void>[] = []
    for (const [name, node] of from.children) {
      const mountPath = path.concat(name)
      if (node.type === FileNodeType.Dir) {
        childCopies.push(this._copyDirToMount(into, mountPath, node, signal))
      } else if (node.type === FileNodeType.File) {
        childCopies.push(this._copyFileToMount(into, mountPath, node, signal))
      } else if (node.type === FileNodeType.Symlink) {
        // verbatim symlinks
        childCopies.push(into['_symlink'](node.to, mountPath, node.relative))
      } else if (node.type === FileNodeType.Mount) {
        childCopies.push(this._copyDirBetweenMounts(
          into,
          mountPath,
          node.vfs,
          node.mountPath,
          signal
        ))
      }
    }
    await Promise.all(childCopies)
  }

  private async _copyDirBetweenMounts (
    into: VFS,
    intoPath: string[],
    from: VFS,
    fromPath: string[],
    signal: AbortSignal
  ) {
    const childCopies: Promise<void>[] = []
    const dirents = await from['_readDirent'](fromPath)
    throwIfAborted(signal)
    for (const entry of dirents) {
      const newIntoPath = intoPath.concat(entry.name)
      const newFromPath = fromPath.concat(entry.name)
      if (entry.type === 'dir') {
        childCopies.push(this._copyDirBetweenMounts(into, newIntoPath, from, newFromPath, signal))
      } else if (entry.type === 'file') {
        childCopies.push(this._copyFileBetweenMounts(into, newIntoPath, from, newFromPath, signal))
      } else if (entry.type === 'symlink') {
        // verbatim symlinks
        // probably breaks... TODO
        childCopies.push(from['_readSymlink'](newFromPath).then(link => {
          const parsed = vfsPath.parse(link)
          return into['_symlink'](parsed.parts, newIntoPath, !parsed.absolute)
        }))
      }
    }
    await Promise.all(childCopies)
  }

  private _copyFileNodes (src: FileNode, dst: FileNode) {
    this._truncateRaw(dst, 0, false)
    const buf = this._readRaw(src.content)
    this._writeRaw(dst, buf, 0)
  }

  private async _copyDirNodes (src: DirNode, dst: DirNode, signal: AbortSignal) {
    const childCopies: Promise<void>[] = []
    for (const [name, node] of src.children) {
      const curChild = dst.children.get(name)
      const curResolvedType = curChild && (
        // mounts act as symlinks when targets of overwriting
        curChild.type === FileNodeType.Mount
          ? 'mount'
          : getEntryType(curChild.type)
      )
      const srcResolvedType = node.type === FileNodeType.Mount
        ? (await node.vfs['_stat'](node.mountPath)).type
        : getEntryType(node.type)

      if (curResolvedType && ((curResolvedType === 'dir') !== (srcResolvedType === 'dir'))) {
        throw new VFSError(`cannot overwrite ${curResolvedType} with ${srcResolvedType}`, {
          code: curResolvedType === 'dir' ? 'ENOTDIR' : 'EISDIR'
        })
      }
      if (node.type === FileNodeType.Dir) {
        const childNode: DirNode = curChild && curChild.type === FileNodeType.Dir
          ? curChild
          : { type: FileNodeType.Dir, children: new Map() }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        dst.children.set(name, childNode)
        childCopies.push(this._copyDirNodes(node, childNode, signal))
      } else if (node.type === FileNodeType.File) {
        const childNode: FileNode = curChild && curChild.type === FileNodeType.File
          ? curChild
          : { type: FileNodeType.File, content: null }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        dst.children.set(name, childNode)
        this._copyFileNodes(node, childNode)
      } else if (node.type === FileNodeType.Symlink) {
        if (curChild) this._cleanup(curChild)
        const childNode: SymlinkNode = {
          type: FileNodeType.Symlink,
          to: node.to,
          relative: node.relative
        }
        dst.children.set(name, childNode)
      } else if (srcResolvedType === 'dir') {
        const childNode: DirNode = curChild && curChild.type === FileNodeType.Dir
          ? curChild
          : { type: FileNodeType.Dir, children: new Map() }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        dst.children.set(name, childNode)
        childCopies.push(this._copyDirFromMount(
          childNode,
          node.vfs,
          node.mountPath,
          signal
        ))
      } else if (srcResolvedType === 'file') {
        const childNode: FileNode = curChild && curChild.type === FileNodeType.File
          ? curChild
          : { type: FileNodeType.File, content: null }
        if (curChild && childNode !== curChild) this._cleanup(curChild)
        dst.children.set(name, childNode)
        childCopies.push(this._copyFileFromMount(childNode, node.vfs, node.mountPath, signal))
      } else {
        // symlink-rooted mount should be impossible
        // just ignore for now
        // TODO: verify this is true
      }
    }
  }

  protected async _copyDir (src: string[], dst: string[], signal?: AbortSignal) {
    const srcNode = this._dir(src)
    const dstNode = this._dir(dst, true)
    const ctrl = new AbortController()
    signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
    try {
      if (srcNode.mount) {
        if (dstNode.mount) {
          return await this._copyDirBetweenMounts(
            dstNode.vfs,
            dstNode.path,
            srcNode.vfs,
            srcNode.path,
            ctrl.signal
          )
        }
        return await this._copyDirFromMount(
          dstNode.node,
          srcNode.vfs,
          srcNode.path,
          ctrl.signal
        )
      }
      if (dstNode.mount) {
        return await this._copyDirToMount(
          dstNode.vfs,
          dstNode.path,
          srcNode.node,
          ctrl.signal
        )
      }
      return await this._copyDirNodes(
        srcNode.node,
        dstNode.node,
        ctrl.signal
      )
    } catch (err) {
      ctrl.abort(err)
      throw err
    }
  }

  protected async _copyFile (src: string[], dst: string[], signal?: AbortSignal) {
    const srcNode = this._file(src)
    const dstNode = this._file(dst, true)
    if (srcNode.mount) {
      if (dstNode.mount) {
        return await this._copyFileBetweenMounts(
          dstNode.vfs,
          dstNode.path,
          srcNode.vfs,
          srcNode.path,
          signal
        )
      }
      return await this._copyFileFromMount(
        dstNode.node,
        srcNode.vfs,
        srcNode.path,
        signal
      )
    }
    if (dstNode.mount) {
      return await this._copyFileToMount(
        dstNode.vfs,
        dstNode.path,
        srcNode.node,
        signal
      )
    }
    return this._copyFileNodes(srcNode.node, dstNode.node)
  }

  protected async _exists (file: string[]) {
    try {
      const result = this._entry(file, true, 0)
      if (result.mount) {
        return result.vfs['_exists'](result.path)
      }
      return true
    } catch (err) {
      if (err instanceof VFSError && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return false
      }
      throw err
    }
  }

  protected async _lstat (file: string[]): Promise<VFSStats> {
    const result = this._entry(file, false, 0)
    if (result.mount) {
      return result.vfs['_lstat'](result.path)
    }
    if (result.node.type === FileNodeType.File) {
      return {
        type: 'file',
        size: result.node.content ? result.node.content.len : 0
      }
    }
    if (result.node.type === FileNodeType.Dir) {
      return {
        type: 'dir',
        size: 0
      }
    }
    return {
      type: 'symlink',
      size: 0
    }
  }

  protected async _mkdir (dir: string[], recursive: boolean) {
    if (recursive) {
      const result = this._entry(
        dir,
        true,
        FindContextCreateMode.Dir | FindContextCreateMode.Recurse
      )
      if (result.mount) {
        return result.vfs['_mkdir'](result.path, true)
      }
    } else {
      const result = this._entry(dir, true, FindContextCreateMode.Dir)
      if (result.mount) {
        return result.vfs['_mkdir'](result.path, false)
      }
      if (!(result.ctx.create & FindContextCreateMode.DidCreate)) {
        throw new VFSError('path exists', { code: 'EEXIST' })
      }
    }
  }

  protected async _openFile (file: string[], read: boolean, write: boolean, truncate: boolean) {
    const result = this._file(file, write)
    if (result.mount) {
      return result.vfs['_openFile'](result.path, read, write, truncate)
    }
    if (truncate) {
      this._truncateRaw(result.node, 0, true)
    }
    return MemVFSFileHandle.open(this, result.node)
  }

  protected async _readDir (dir: string[]) {
    const result = this._dir(dir)
    if (result.mount) {
      return result.vfs['_readDir'](result.path)
    }
    return Array.from(result.node.children.keys())
  }

  protected async _readDirent (dir: string[]) {
    const result = this._dir(dir)
    if (result.mount) {
      return result.vfs['_readDirent'](result.path)
    }
    const results: (VFSDirent | Promise<VFSDirent>)[] = []
    for (const [key, node] of result.node.children) {
      if (node.type === FileNodeType.Mount) {
        results.push(
          node.vfs['_lstat'](node.mountPath).then(info => ({
            type: info.type,
            name: key
          }))
        )
      } else {
        results.push({
          type: getEntryType(node.type),
          name: key
        })
      }
    }
    return await Promise.all(results)
  }

  protected async _readFile (file: string[], signal?: AbortSignal) {
    const result = this._file(file)
    if (result.mount) {
      return result.vfs['_readFile'](result.path, signal)
    }
    // copy to prevent modifying original source
    return this._readRaw(result.node.content).slice()
  }

  protected _readFileStream (file: string[], signal?: AbortSignal): VFSReadStream {
    const result = this._file(file)
    if (result.mount) {
      return result.vfs['_readFileStream'](result.path, signal)
    }
    return this._readRawStream(result.node, signal)
  }

  protected async _readSymlink (link: string[]) {
    const result = this._entry(link, false, 0)
    if (result.mount) {
      let symResult = await result.vfs['_readSymlink'](result.path)
      // try to patch absolute paths
      if (symResult.startsWith('/') && result.ctx.path.length) {
        symResult = '/' + result.ctx.path.slice(0, result.ctx.i).join('/') + symResult
      }
      return symResult
    }
    if (result.node.type !== FileNodeType.Symlink) {
      throw new VFSError('not a symlink', {
        code: 'EINVAL'
      })
    }

    return (result.node.relative ? '' : '/') + result.node.to.join('/')
  }

  protected async _realPath (link: string[]) {
    const result = this._entry(link, true, 0)
    if (result.mount) {
      let realResult = await result.vfs['_realPath'](result.path)
      // try to patch absolute paths
      if (result.ctx.path.length) {
        realResult = '/' + result.ctx.path.slice(0, result.ctx.i).join('/') + realResult
      }
      return realResult
    }
    return '/' + result.ctx.path.join('/')
  }

  private _cleanup (node: FSNode) {
    if (node.type === FileNodeType.Dir) {
      for (const child of node.children.values()) this._cleanup(child)
      node.children.clear()
    } else if (node.type === FileNodeType.File) {
      this._truncateRaw(node, 0, true)
    }
  }

  private _removeFromParent (ctx: FindContext, replaceWith?: FSNode) {
    const parents = ctx.parents
    if (!parents.length) {
      this._root = replaceWith
    } else {
      const children = parents[parents.length - 1].children
      const name = ctx.path[ctx.path.length - 1]
      // TODO: does this always work?
      if (replaceWith) children.set(name, replaceWith)
      else children.delete(name)
    }
  }

  protected async _removeDir (dir: string[], recursive: boolean, signal?: AbortSignal) {
    const result = this._dir(dir)
    if (result.mount) {
      return result.vfs['_removeDir'](result.path, recursive, signal)
    }
    if (recursive) {
      this._cleanup(result.node)
    } else if (result.node.children.size) {
      throw new VFSError('directory not empty', { code: 'ENOTEMPTY' })
    }
    this._removeFromParent(result.ctx)
  }

  protected async _removeFile (file: string[], signal?: AbortSignal) {
    // don't resolve last to unlink instead of delete
    const result = this._entry(file, false, 0)
    if (result.mount && result.ctx.i !== result.ctx.path.length) {
      return result.vfs['_removeFile'](result.path, signal)
    }
    if (!result.mount && result.node.type === FileNodeType.Dir) {
      throw new VFSError('not a file', { code: 'EISDIR' })
    }
    this._cleanup(result.mount ? result.ctx.node : result.node)
    this._removeFromParent(result.ctx)
  }

  private async _renameSlowFromMount (srcResult: MountFindResult, dst: string[]) {
    const srcType = (await srcResult.vfs['_lstat'](srcResult.path)).type
    const dstResult = this._entry(
      dst,
      false,
      srcType === 'dir'
        ? FindContextCreateMode.Dir
        : srcType === 'file'
          ? FindContextCreateMode.File
          : FindContextCreateMode.Symlink
    )
    if (dstResult.mount && dstResult.ctx.i !== dstResult.ctx.path.length) {
      if (dstResult.vfs === srcResult.vfs) {
        return srcResult.vfs['_rename'](srcResult.path, dstResult.path)
      }
      // need to copy and delete if they're on different VFS instances
      if (srcType === 'dir') {
        const ctrl = new AbortController()
        await this._copyDirBetweenMounts(
          dstResult.vfs,
          dstResult.path,
          srcResult.vfs,
          srcResult.path,
          ctrl.signal
        ).catch(err => {
          ctrl.abort(err)
          throw err
        })
        await srcResult.vfs['_removeDir'](srcResult.path, true)
      } else if (srcType === 'file') {
        await this._copyFileBetweenMounts(
          dstResult.vfs,
          dstResult.path,
          srcResult.vfs,
          srcResult.path
        )
        await srcResult.vfs['_removeFile'](srcResult.path)
      } else {
        const srcLink = await srcResult.vfs['_readSymlink'](srcResult.path)
        const parsedLink = vfsPath.parse(srcLink)
        // copy pasting symlinks verbatim probably breaks, TODO
        await dstResult.vfs['_symlink'](parsedLink.parts, dstResult.path, !parsedLink.absolute)
      }
      return
    }

    if (srcType === 'dir') {
      if (dstResult.mount || dstResult.node.type !== FileNodeType.Dir) {
        throw new VFSError('cannot overwrite non-directory with directory', { code: 'ENOTDIR' })
      }
      if (dstResult.node.children.size !== 0) {
        throw new VFSError('directory not empty', { code: 'ENOTEMPTY' })
      }
      const ctrl = new AbortController()
      await this._copyDirFromMount(
        dstResult.node,
        srcResult.vfs,
        srcResult.path,
        ctrl.signal
      ).catch(err => {
        ctrl.abort(err)
        throw err
      })
      await srcResult.vfs['_removeDir'](srcResult.path, true)
    } else {
      if (!dstResult.mount && dstResult.node.type === FileNodeType.Dir) {
        throw new VFSError('cannot overwrite directory with non-directory', { code: 'EISDIR' })
      }
      let newNode = dstResult.mount ? dstResult.ctx.node : dstResult.node
      if (srcType === 'file') {
        // rename overwrites symlinks, mounts
        if (newNode.type !== FileNodeType.File) {
          this._cleanup(newNode)
          newNode = { type: FileNodeType.File, content: null }
          this._removeFromParent(
            dstResult.ctx,
            newNode
          )
        }
        await this._copyFileFromMount(newNode, srcResult.vfs, srcResult.path)
        await srcResult.vfs['_removeFile'](srcResult.path)
      } else {
        // rename overwrites files, mounts
        if (newNode.type !== FileNodeType.Symlink) {
          this._cleanup(newNode)
          newNode = { type: FileNodeType.Symlink, to: [], relative: false }
          this._removeFromParent(
            dstResult.ctx,
            newNode
          )
        }
        const origLink = await srcResult.vfs['_readSymlink'](srcResult.path)
        const parsed = vfsPath.parse(origLink)
        // Again, symlinks probably break here
        // TODO decide better behavior
        newNode.to = parsed.parts
        newNode.relative = !parsed.absolute
        // TODO: hopefully this doesn't remove the actual file?
        // Should have same semantics as _readSymlink so in theory no
        await srcResult.vfs['_removeFile'](srcResult.path)
      }
    }
  }

  protected async _rename (src: string[], dst: string[]) {
    const srcResult = this._entry(src, false, 0)
    if (srcResult.mount) {
      return this._renameSlowFromMount(srcResult, dst)
    }

    const dstResult = this._entry(
      dst,
      false,
      srcResult.node.type === FileNodeType.Dir
        ? FindContextCreateMode.Dir
        : srcResult.node.type === FileNodeType.File
          ? FindContextCreateMode.File
          : FindContextCreateMode.Symlink
    )

    if (dstResult.mount && dstResult.ctx.i !== dstResult.ctx.path.length) {
      if (srcResult.node.type === FileNodeType.Dir) {
        const ctrl = new AbortController()
        await this._copyDirToMount(dstResult.vfs, dstResult.path, srcResult.node, ctrl.signal)
          .catch(err => {
            ctrl.abort(err)
            throw err
          })
      } else if (srcResult.node.type === FileNodeType.File) {
        await this._copyFileToMount(dstResult.vfs, dstResult.path, srcResult.node)
      } else if (srcResult.node.type === FileNodeType.Symlink) {
        // verbatim copy symlink
        await dstResult.vfs['_symlink'](dstResult.path, srcResult.node.to, srcResult.node.relative)
      }
      this._cleanup(srcResult.node)
      this._removeFromParent(srcResult.ctx)
      return
    }

    if (srcResult.node.type === FileNodeType.Dir) {
      if (dstResult.mount || dstResult.node.type !== FileNodeType.Dir) {
        throw new VFSError('cannot overwrite non-directory with directory', { code: 'ENOTDIR' })
      }
      if (dstResult.node.children.size !== 0) {
        throw new VFSError('directory not empty', { code: 'ENOTEMPTY' })
      }
      // clone and clear to try to mitigate dangling references
      dstResult.node.children = new Map(srcResult.node.children)
      srcResult.node.children.clear()
      this._removeFromParent(srcResult.ctx)
    } else {
      if (!dstResult.mount && dstResult.node.type === FileNodeType.Dir) {
        throw new VFSError('cannot overwrite directory with non-directory', { code: 'EISDIR' })
      }
      let newNode = dstResult.mount ? dstResult.ctx.node : dstResult.node
      if (srcResult.node.type === FileNodeType.File) {
        // rename overwrites symlinks, mounts
        if (newNode.type !== FileNodeType.File) {
          this._cleanup(newNode)
          newNode = { type: FileNodeType.File, content: null }
          this._removeFromParent(dstResult.ctx, newNode)
        }
        newNode.content = srcResult.node.content
        srcResult.node.content = null
        this._removeFromParent(srcResult.ctx)
      } else if (srcResult.node.type === FileNodeType.Symlink) {
        // rename overwrites files, mounts
        if (newNode.type !== FileNodeType.Symlink) {
          this._cleanup(newNode)
          newNode = { type: FileNodeType.Symlink, to: [], relative: false }
          this._removeFromParent(dstResult.ctx, newNode)
        }
        newNode.to = srcResult.node.to
        newNode.relative = srcResult.node.relative
        this._removeFromParent(srcResult.ctx)
      }
    }
  }

  protected async _stat (file: string[]): Promise<VFSStats> {
    const result = this._entry(file, true, 0)
    if (result.mount) {
      return result.vfs['_stat'](result.path)
    }
    if (result.node.type === FileNodeType.File) {
      return {
        type: 'file',
        size: result.node.content ? result.node.content.len : 0
      }
    }
    return {
      type: 'dir',
      size: 0
    }
  }

  protected async _symlink (target: string[], link: string[], relative: boolean) {
    const result = this._entry(link, false, FindContextCreateMode.Symlink)
    if (result.mount) {
      // TODO: maybe we should error on absolute symlinks here, as they're resolved wrong
      return result.vfs['_symlink'](target, link, relative)
    }
    if (
      result.node.type !== FileNodeType.Symlink ||
      !(result.ctx.create & FindContextCreateMode.DidCreate)
    ) {
      throw new VFSError('file exists', { code: 'EEXIST' })
    }
    result.node.to = target.slice()
    result.node.relative = relative
  }

  // TODO: maybe actually support this eventually
  protected _watch (
    glob: string,
    watcher: VFSWatchCallback,
    onError: VFSWatchErrorCallback
  ): Promise<never> {
    throw new VFSError('watching not supported', { code: 'ENOSYS' })
  }

  protected async _writeFile (file: string[], data: Uint8Array, signal?: AbortSignal) {
    const result = this._file(file, true)
    if (result.mount) {
      return result.vfs['_writeFile'](file, data, signal)
    }
    this._truncateRaw(result.node, 0, false)
    this._writeRaw(result.node, data, 0)
  }

  protected _writeFileStream (file: string[], signal?: AbortSignal): VFSWriteStream {
    const result = this._file(file, true)
    if (result.mount) {
      return result.vfs['_writeFileStream'](file, signal)
    }
    this._truncateRaw(result.node, 0, false)
    return this._writeRawStream(result.node, 0, signal)
  }

  protected async _mount (at: string[], fs: VFS, mountPath: string[]) {
    const result = this._entry(at, true, FindContextCreateMode.File)
    if (result.mount) {
      throw new VFSError('cannot mount within existing mount', { code: 'EINVAL' })
    }
    if (!(result.ctx.create & FindContextCreateMode.DidCreate)) {
      throw new VFSError('file exists', { code: 'EEXIST' })
    }
    this._removeFromParent(result.ctx, {
      type: FileNodeType.Mount,
      vfs: fs,
      mountPath
    })
  }

  mount (path: string, fs: VFS, options: { mountPath?: string } = {}) {
    return this._mount(
      vfsPath.parse(path).parts,
      fs,
      vfsPath.parse(options?.mountPath ?? '/').parts
    )
  }
}
