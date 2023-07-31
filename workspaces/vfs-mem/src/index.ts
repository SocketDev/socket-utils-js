import { VFS, VFSError, VFSFileHandle } from '@socketsecurity/vfs'

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
  buf: ArrayBuffer
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
  vfs: VFS
}

type FSNode = FileNode | DirNode | SymlinkNode | MountNode

type FindContext = {
  node: FSNode
  path: ReadonlyArray<string>
  parents: DirNode[]
  create: FileNodeType.File | FileNodeType.Dir | -1
  i: number
  depth: number
}

type MountFindResult = {
  mount: true
  vfs: VFS
  path: string[]
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

type FSFilePool = {
  buf: Uint8Array
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

// mutates entry.len and entry.start
const allocPool = (pool: FSFilePool, entry: BufferPoolRef, growthFactor: number) => {
  pool.allocated.add(entry)
  entry.len = pool.block
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
  newBuf.set(pool.buf)
  pool.buf = newBuf
  pool.hasGrown = true
  entry.start = pool.ind
  pool.ind += pool.block
  return entry
}

const freePool = (pool: FSFilePool, entry: BufferPoolRef, shrinkRatio: number, shrinkRetain: number) => {
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
            pool.buf.subarray(oldContiguousStart, ind + oldDelta),
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
        pool.buf.subarray(oldContiguousStart, ind + oldDelta),
        oldContiguousStart - oldDelta
      )
    }
    pool.buf = newBuf
    pool.free.length = 0
    pool.ind = ind
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

const DEFAULT_POOLS: MemVFSPoolSpec[] = [
  { blockSize: 256, count: 1000 },
  { blockSize: 1024, count: 500 },
  { blockSize: 4096, count: 250 }
]

class MemVFS extends VFS {
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
        buf: new Uint8Array(initSize),
        ind: 0,
        block: pool.blockSize,
        free: [],
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
          } else {
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
    if (ctx.node.type === FileNodeType.Symlink) {
      if (++ctx.depth >= this._maxLinkDepth) {
        throw new VFSError('symlink depth too high', { code: 'EINVAL' })
      }

      if (ctx.node.relative) {
        let back = -1
        const to = ctx.node.to
        let tail = ctx.i
        do {
          ++back
          if (!ctx.i--) {
            throw new VFSError('cannot read symlink out of root', { code: 'ENOENT' })
          }
          ctx.node = ctx.parents.pop()!
        } while (back < to.length && to[back] === '..')

        const newPath = ctx.path.slice(0, ctx.i)
        for (; back < to.length; ++back) {
          newPath.push(to[back])
        }
        for (; tail < ctx.path.length; ++tail) {
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

  private _file (path: string[], create: boolean): MountFindResult | FileFindResult {
    if (!this._root) {
      if (!path.length && create) {
        this._root = { type: FileNodeType.File, content: null }
        return {
          mount: false,
          node: this._root
        }
      }
      throw new VFSError('no such file or directory', { code: 'ENOENT' })
    }
    const ctx: FindContext = {
      node: this._root,
      path,
      parents: [],
      create: create ? FileNodeType.File : -1,
      i: 0,
      depth: 0
    }
    this._find(ctx)
    if (ctx.node.type === FileNodeType.Mount) {
      return {
        mount: true,
        vfs: ctx.node.vfs,
        path: ctx.path.slice(ctx.i)
      }
    }
    if (ctx.node.type === FileNodeType.File) {
      return {
        mount: false,
        node: ctx.node
      }
    }
    throw new VFSError('not a file', { code: 'EISDIR' })
  }

  private _dir (path: string[], create: boolean): MountFindResult | DirFindResult {
    if (!this._root) {
      if (!path.length && create) {
        this._root = { type: FileNodeType.Dir, children: new Map() }
        return {
          mount: false as const,
          node: this._root
        }
      }
      throw new VFSError('no such file or directory', { code: 'ENOENT' })
    }
    const ctx: FindContext = {
      node: this._root,
      path,
      parents: [],
      create: create ? FileNodeType.Dir : -1,
      i: 0,
      depth: 0
    }
    this._find(ctx)
    if (ctx.node.type === FileNodeType.Mount) {
      return {
        mount: true as const,
        vfs: ctx.node.vfs,
        path: ctx.path.slice(ctx.i)
      }
    }
    if (ctx.node.type === FileNodeType.Dir) {
      return {
        mount: false as const,
        node: ctx.node
      }
    }
    throw new VFSError('not a directory', { code: 'ENOTDIR' })
  }

  private _realloc (ref: BufferPoolRef, poolIndex: number) {
    if (poolIndex !== ref.pool) {
      const oldPos = ref.start
      allocPool(
        this._pools[poolIndex],
        ref,
        this._poolGrowthFactor
      )
      this._pools[poolIndex].buf.set(
        this._pools[ref.pool].buf.subarray(oldPos, oldPos + ref.len)
      )
      freePool(
        this._pools[ref.pool],
        ref,
        this._poolShrinkRatio,
        this._poolShrinkRetainFactor
      )
    }
  }

  private _truncateRaw (node: FileNode, to: number, shrink: boolean) {
    if (node.content && to < node.content.len) {
      node.content.len = to
      if (shrink) {
        if (node.content.src === FileBackingType.Pool) {
          let poolIndex = node.content.pool
          if (to * this._shrinkRatio < this._pools[poolIndex].block) {
            // find smallest pool that fits
            while (this._pools[poolIndex].block > this._shrinkRetainFactor * to) {
              --poolIndex
            }
            this._realloc(node.content, poolIndex)
          }
        } else if (node.content.src === FileBackingType.Raw) {
          if (to * this._shrinkRatio < node.content.buf.byteLength) {
            const buffer = new ArrayBuffer(Math.floor(this._shrinkRetainFactor * to))
            new Uint8Array(buffer).set(new Uint8Array(node.content.buf, 0, to))
            node.content.buf = buffer
          }
        }
      }
    }
  }

  private _writeRaw (node: FileNode, data: Uint8Array) {

  }

  protected _truncate (file: string[], to: number) {

  }

  protected _appendFile (file: string[], data: Uint8Array, signal?: AbortSignal) {
    const node = this._file(file, true)
    if (node.mount) {
      return node.vfs['_appendFile'](node.path, data, signal)
    }
    node.node.
  }
}
