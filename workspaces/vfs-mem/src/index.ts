import { VFS, VFSEntryType, VFSError, VFSFileHandle, VFSWriteStream, path as vfsPath } from '@socketsecurity/vfs'

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

type FindContext = {
  node: FSNode
  path: ReadonlyArray<string>
  parents: DirNode[]
  thruLast: boolean
  create: FileNodeType.File | FileNodeType.Dir | -1
  i: number
  depth: number
}

type MountFindResult = {
  mount: true
  vfs: VFS
  path: string[]
}

type NonMountFindResult = {
  mount: false
  node: FSNode
}

type FileFindResult = {
  mount: false
  node: FileNode
}

type DirFindResult = {
  mount: false
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
  if (pool.ind < pool.buf.byteLength) {
    entry.start = pool.ind
    pool.ind += pool.block
    return entry
  }
  if (pool.free.length) {
    entry.start = pool.free.pop()!
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

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw wrapVFSErr(signal.reason)
  }
}

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
  maxLinkDepth?: number
}

// follow unix standards
const MAX_SYMLINKS = 40
const FILE_SHRINK_RATIO = 2
const FILE_SHRINK_PADDING = 0.4
const POOL_SHRINK_RATIO = 4
const POOL_SHRINK_PADDING = 1
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
      if (ctx.node.type === FileNodeType.Dir) {
        let child = ctx.node.children.get(ctx.path[ctx.i])
        if (!child) {
          if (ctx.i === ctx.path.length - 1) {
            if (ctx.create === FileNodeType.File) {
              child = {
                type: FileNodeType.File,
                content: null
              }
            } else if (ctx.create === FileNodeType.Dir) {
              child = {
                type: FileNodeType.Dir,
                children: new Map()
              }
            }
          }
          if (!child) {
            throw new VFSError('no such file or directory', { code: 'ENOENT' })
          }
          ctx.node.children.set(ctx.path[ctx.i], child)
        }
        ctx.parents.push(ctx.node)
        ctx.node = child
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
    create: FindContext['create'] = -1
  ): MountFindResult | NonMountFindResult {
    if (!this._root) {
      throw new VFSError('no such file or directory', { code: 'ENOENT' })
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
      for (; ctx.i < ctx.path.length; ++ctx.i) {
        outPath.push(ctx.path[ctx.i])
      }
      return {
        mount: true,
        vfs: ctx.node.vfs,
        path: ctx.path.slice(ctx.i)
      }
    }
    return {
      mount: false,
      node: ctx.node
    }
  }

  private _file (path: string[], create = false): MountFindResult | FileFindResult {
    if (!this._root && !path.length && create) {
      this._root = { type: FileNodeType.File, content: null }
      return {
        mount: false,
        node: this._root
      }
    }
    const result = this._entry(path, true, create ? FileNodeType.File : -1)
    if (!result.mount && result.node.type !== FileNodeType.File) {
      throw new VFSError('not a file', { code: 'EISDIR' })
    }
    return result as MountFindResult | FileFindResult
  }

  private _dir (path: string[], create = false): MountFindResult | DirFindResult {
    if (!this._root && !path.length && create) {
      this._root = { type: FileNodeType.Dir, children: new Map() }
      return {
        mount: false,
        node: this._root
      }
    }
    const result = this._entry(path, true, create ? FileNodeType.Dir : -1)
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
    freePool(
      this._pools[ref.pool],
      ref,
      this._poolShrinkRatio,
      this._poolShrinkRetainFactor
    )
  }

  private _truncateRaw (node: FileNode, to: number, shrink: boolean) {
    if (!node.content || to >= node.content.len) return
    node.content.len = to
    if (shrink) {
      if (to === 0) {
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

    if (space < (node.content ? node.content.len : 0) || allocSize >= space) {
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

  private _writeRawStream (node: FileNode, offset = 0, signal?: AbortSignal) {
    throwIfAborted(signal)
    return new WritableStream<Uint8Array>({
      start: ctrl => {
        signal?.addEventListener('abort', err => {
          ctrl.error(wrapVFSErr(err))
        }, { once: true })
      },
      write: chunk => {
        this._writeRaw(node, chunk, offset)
        offset += chunk.byteLength
      }
    })
  }

  private _readRawStream (node: FileNode, signal?: AbortSignal) {
    throwIfAborted(signal)
    let bytesRead = 0
    // we avoid just returning the entire raw chunk here because it would need to be copied
    // for huge files this doesn't have any memory overhead
    return new ReadableStream({
      start: ctrl => {
        signal?.addEventListener('abort', err => {
          ctrl.error(wrapVFSErr(err))
        })
      },
      pull: ctrl => {
        const readResult = this._readRaw(node.content)
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
      autoAllocateChunkSize: 65536,
      type: 'bytes'
    }, new ByteLengthQueuingStrategy({ highWaterMark: 65536 }))
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

  protected _appendFileStream (file: string[], signal?: AbortSignal | undefined) {
    const result = this._file(file, true)
    if (result.mount) {
      return result.vfs['_appendFileStream'](result.path, signal)
    }
    const len = result.node.content ? result.node.content.len : 0
    // not sure if we need to handle aborts/closes here
    return this._writeRawStream(result.node, len, signal)
  }

  private async _copyFileFromMount (
    into: FileNode,
    vfs: VFS,
    path: string[],
    signal: AbortSignal
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
    signal: AbortSignal
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
    signal: AbortSignal
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
    pathToMount: string[],
    path: string[],
    signal: AbortSignal
  ) {
    const childCopies: Promise<void>[] = []
    for (const entry of await from['_readDirent'](path)) {
      throwIfAborted(signal)
      const curChild = into.children.get(entry.name)
      const curResolvedType = curChild && (
        curChild.type === FileNodeType.Mount
          ? (await curChild.vfs['_stat'](curChild.mountPath)).type
          : (['file', 'dir', 'symlink'] as VFSEntryType[])[curChild.type]
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
        into.children.set(entry.name, childNode)
        childCopies.push(this._copyDirFromMount(
          childNode,
          from,
          pathToMount,
          subPath,
          signal
        ))
      } else if (entry.type === 'file') {
        const childNode: FileNode = curChild && curChild.type === FileNodeType.File
          ? curChild
          : { type: FileNodeType.File, content: null }
        into.children.set(entry.name, childNode)
        childCopies.push(this._copyFileFromMount(
          childNode,
          from,
          subPath,
          signal
        ))
      } else if (entry.type === 'symlink') {
        childCopies.push(from['_realPath'](subPath).then(resolved => {
          const { parts } = vfsPath.parse(resolved)
          const childNode: SymlinkNode = {
            type: FileNodeType.Symlink,
            to: pathToMount.concat(parts),
            relative: false
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
    for (const [name, node] of from.children.entries()) {
      const mountPath = path.concat(name)
      if (node.type === FileNodeType.Dir) {
        childCopies.push(this._copyDirToMount(into, mountPath, node, signal))
      } else if (node.type === FileNodeType.File) {
        childCopies.push(this._copyFileToMount(into, mountPath, node, signal))
      } else if (node.type === FileNodeType.Symlink) {
        // TODO: how to handle this with cycles?
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
        // TODO: resolve these while processing cycles
      }
    }
    await Promise.all(childCopies)
  }

  private _copyFileNodes (src: FileNode, dst: FileNode) {
    this._truncateRaw(dst, 0, false)
    const buf = this._readRaw(src.content)
    this._writeRaw(dst, buf, 0)
  }

  private async _copyDirNodes (src: DirNode, srcPath: string[], dst: DirNode, signal: AbortSignal) {
    const childCopies: Promise<void>[] = []
    for (const [name, node] of src.children.entries()) {
      const curChild = dst.children.get(name)
      const curResolvedType = curChild && (
        curChild.type === FileNodeType.Mount
          ? (await curChild.vfs['_stat'](curChild.mountPath)).type
          : (['file', 'dir', 'symlink'] as VFSEntryType[])[curChild.type]
      )
      const srcResolvedType = node.type === FileNodeType.Mount
        ? (await node.vfs['_stat'](node.mountPath)).type
        : (['file', 'dir', 'symlink'] as VFSEntryType[])[node.type]

      if (curResolvedType && ((curResolvedType === 'dir') !== (srcResolvedType === 'dir'))) {
        throw new VFSError(`cannot overwrite ${curResolvedType} with ${srcResolvedType}`, {
          code: curResolvedType === 'dir' ? 'ENOTDIR' : 'EISDIR'
        })
      }
      if (node.type === FileNodeType.Dir) {
        const childNode: DirNode = curChild && curChild.type === FileNodeType.Dir
          ? curChild
          : { type: FileNodeType.Dir, children: new Map() }
        dst.children.set(name, childNode)
        childCopies.push(this._copyDirNodes(node, srcPath.concat(name), childNode, signal))
      } else if (node.type === FileNodeType.File) {
        const childNode: FileNode = curChild && curChild.type === FileNodeType.File
          ? curChild
          : { type: FileNodeType.File, content: null }
        dst.children.set(name, childNode)
        this._copyFileNodes(node, childNode)
      } else if (node.type === FileNodeType.Symlink) {
        let to = node.to
        if (node.relative) {
          const newTo = srcPath
          for (const part of to) {
            if (part === '..')
          }
        }
        const childNode: SymlinkNode = {
          type: FileNodeType.Symlink,
          to: node.relative ? srcPath.concat(node.)
        }
      }
    }
  }

  protected async _copyDir (src: string[], dst: string[], signal?: AbortSignal) {
    const srcNode = this._dir(src, true)
    const dstNode = this._dir(dst, true)
  }
}
