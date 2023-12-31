# @socketsecurity/vfs

A high quality virtual filesystem implementation with files, directories, and symlinks. Includes support for abort signals, random-access reads/writes, streams, event watchers, and well-defined error types. Works on Node.js 16.5+ and all modern browsers.

## Usage
```ts
import { VFS, VFSError, path } from '@socketsecurity/vfs'
import { MemVFS } from '@socketsecurity/vfs-mem'

async function readSocketYml (fs: VFS) {
  const filePath = path.join('test', 'folder', 'socket.yml')

  // CWD is implicitly the root
  const stream = fs.readFileStream(filePath)
  const reader = stream.getReader()

  while (true) {
    const result = await reader.read()
    if (result.done) break
    console.log(`read chunk from ${filePath}:`, result.value)
  }
}

async function makeDummyFS (): Promise<VFS> {
  // Can replace MemVFS with any other VFS implementation
  // e.g. NodeVFS from @socketsecurity/vfs-node
  let sampleFS = new MemVFS()
  await sampleFS.mkdir('/test/folder', { recursive: true })

  return sampleFS
}

const fs = await makeDummyFS()
await fs.writeFile(
  '/test/folder/socket.yml',
  new TextEncoder().encode('issueRules:\n  cve: true\n')
)
await readSocketYml(fs)
```

## Caveats
The virtual filesystem is as close as possible to POSIX on a best-effort basis.

One of the most significant differences is the handling of symlinks. The list of methods that automatically dereference symlinks is larger than on a real POSIX system. For instance, `vfs.removeDir('symlink')` and `vfs.removeDir('symlink/')` will both attempt to remove the directory referenced by the symlink rather than the symlink itself. On an actual POSIX system, the trailing slash is necessary to achieve this behavior: `fs.rm('symlink', { recursive: true })` throws an error.

Still, trailing slashes are needed to traverse through symlinks when the operation could be valid on a symlink too (e.g. `vfs.removeFile('symlink')` removes the symlink, while `vfs.removeFile('symlink/')` removes the file it points to).


## Guarantees

### Readable byte streams
Streams returned from `readFileStream` must be implemented with an underlying byte source such that `stream.getReader({ type: 'byob' })` does not throw an error. They do not necessarily need to honor BYOB requests and can instead normally call `controller.enqueue(chunk)`, but should read into the user-provided buffer whenever possible.

The only exception to this rule is when `readFileStream` is called in an environment that does not support readable byte streams (e.g. Safari), in which case the stream must dynamically detect that `typeof ReadableByteStreamController === 'undefined'` and only then return a standard readable stream instead. This behavior allows the callee to use a BYOB stream whenever the host environment allows it.

### Properly implemented protected methods
All implementers must implement the underscore-prefixed methods properly. The fact that these methods are marked as `protected` in TypeScript is not a guarantee that they will not be called by external code - you are expected to implement them correctly rather than overriding the wrapper methods in the `VFS` parent class directly.

Likewise, it is permissible to call the underscore-prefixed methods of a `VFS` instance from within another `VFS` instance (but not from user code).

In essence, underscore-prefixed protected methods should be treated as accessible to "friend classes" (other `VFS` subclasses, even within a different hierarchy).
