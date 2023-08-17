# Socket Utilities

These are a collection of high-quality, open-source JavaScript utilities built for usage within [Socket](https://socket.dev) products.

## Projects

### Virtual filesystem
A high quality virtual filesystem implementation supporting symlinks, random access reads, web streams, and abort signals. Mimicks POSIX as much as possible.

Packages:
- [@socketsecurity/vfs](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs) - VFS method specification
- [@socketsecurity/vfs-fs-access](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs-fs-access) - VFS for the [WICG File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [@socketsecurity/vfs-mem](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs-mem) - In-memory filesystem with pooled backing buffers to support millions of small files
- [@socketsecurity/vfs-node](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs-node) - VFS adapter to native Node.js `fs` module
- [@socketsecurity/vfs-readonly](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs-readonly) - Base class to simplify the implementation of readonly filesystems
- [@socketsecurity/vfs-vscode](https://github.com/SocketDev/socket-utils-js/tree/main/workspaces/vfs-vscode) - VFS implemented on `vscode.workspace.fs` for VSCode filesystems

### Other projects
More utilities may be added to this list in the future. For now, here are some other open source projects from Socket:
- [@socketsecurity/cli](https://github.com/SocketDev/socket-cli-js) - Socket command-line interface and safe NPM wrapper
- [@socketsecurity/sdk](https://github.com/SocketDev/socket-sdk-js) - Socket API SDK
