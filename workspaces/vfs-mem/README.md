# @socketsecurity/vfs-mem

In-memory implementation of the Socket virtual filesystem. Allows for mounting other virtual filesystems in subpaths.

## Mounts
This filesystem extends upon the base VFS API by offering the ability to mount other virtual filesystems within subpaths using `.mount()`, e.g.

```js
memVFS.mount('/my/mount/path', otherVFS, { mountPath: '/otherVFS-prefix' })
```

Mounts are completely transparent to all VFS operations (e.g. `stat`, `readFile`, and `readDir`). For example, if you run:

```js
memVFS.readFile('/my/mount/path/some/subpath')
```

That will essentially return `otherVFS.readFile('/otherVFS-prefix/some/subpath')`.

The only way to inspect a mounted path is with `memVFS.readMount('/my/mount/path/some/subpath')`, which will return an object of the shape:

```js
const result = {
  fs: otherVFS,
  path: '/otherVFS-prefix/some/subpath'
}
```
