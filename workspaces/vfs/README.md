# @socketsecurity/vfs

A high quality virtual filesystem implementation with files, directories, and symlinks. Includes support for abort signals, random-access reads/writes, streams, and high quality error handling.


## Caveats
The virtual filesystem is similar to POSIX on a best-effort basis. Some uncommon features (e.g. accessing parent directories through symbolic links) will not work identically to a real filesystem.


One of the most significant differences is the handling of symlinks. On a real POSIX system, trailing slashes are usually needed to dereference symlinks, but here symlinks are always dereferenced when the method being called would not make sense on a symlink. This means that `vfs.removeDir('symlink')` and `vfs.removeDir('symlink/')` will both attempt to remove the directory referenced by the symlink rather than the symlink itself. On an actual POSIX system, the trailing slash is necessary to achieve this behavior: `fs.rm('symlink', { recursive: true })` throws an error.

Still, trailing slashes are needed when the operation could be valid on a symlink too (e.g. `vfs.removeFile('symlink')` removes the symlink, while `vfs.removeFile('symlink/')` removes the file it points to).
