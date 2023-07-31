# @socketsecurity/vfs

A high quality virtual filesystem implementation with files, directories, and symlinks. Includes support for abort signals, random-access reads/writes, streams, and high quality error handling.


## Caveats
The virtual filesystem is similar to POSIX on a best-effort basis. Some uncommon features (e.g. accessing parent directories through symbolic links) will not work identically to a real filesystem.


One of the most significant differences is that the virtual filesystem does not differentiate between filepaths with and without trailing slashes. However, they are generally treated as having trailing slashes when operating on directories, which results in slightly different behavior on symlinks. This means that `vfs.removeDir('symlink')` and `vfs.removeDir('symlink/')` will both attempt to remove the directory referenced by the symlink rather than the symlink itself. On an actual POSIX system, the trailing slash is necessary to achieve this behavior: `fs.rm('symlink', { recursive: true })` throws an error.
