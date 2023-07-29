# @socketsecurity/vfs-node

Node.js implementation of the Socket virtual filesystem. Accepts a root directory onto which the filesystem should be mounted and prevents callers from escaping that directory. Symbolic links within the directory to a location outside can still be used to escape.
