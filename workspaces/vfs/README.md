# @socketsecurity/vfs

A high quality virtual filesystem implementation with files, directories, and symlinks. Includes support for abort signals, random-access reads/writes, streams, and well-defined error types.


## Caveats
The virtual filesystem is as close as possible to POSIX on a best-effort basis.

One of the most significant differences is the handling of symlinks. The list of methods that automatically dereference symlinks is larger than on a real POSIX system. For instance, `vfs.removeDir('symlink')` and `vfs.removeDir('symlink/')` will both attempt to remove the directory referenced by the symlink rather than the symlink itself. On an actual POSIX system, the trailing slash is necessary to achieve this behavior: `fs.rm('symlink', { recursive: true })` throws an error.

Still, trailing slashes are needed when the operation could be valid on a symlink too (e.g. `vfs.removeFile('symlink')` removes the symlink, while `vfs.removeFile('symlink/')` removes the file it points to).
