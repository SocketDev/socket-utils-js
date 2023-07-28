# @socketsecurity/vfs

A high quality virtual filesystem implementation with files, directories, and symlinks. Includes support for abort signals, random-access reads/writes, streams, and high quality error handling.

The virtual filesystem is similar to POSIX on a best-effort basis. Some uncommon features (e.g. accessing parent directories through symbolic links) will not work identically to a real filesystem.
