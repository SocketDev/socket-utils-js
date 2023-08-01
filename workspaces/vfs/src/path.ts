const resolveParts = (paths: string[]) => {
  const parts: string[] = []
  const absolute = paths.length > 0 && paths[0].startsWith('/')
  const throughLink = paths.length > 0 && paths[paths.length - 1].endsWith('/')

  for (const path of paths) {
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!absolute && (!parts.length || parts[parts.length - 1] === '..')) {
          parts.push('..')
        } else {
          parts.pop()
        }
      } else {
        parts.push(part)
      }
    }
  }

  return {
    absolute,
    throughLink,
    parts
  }
}

export function parse (path: string) {
  return resolveParts([path])
}

export function join (...paths: string[]) {
  const resolved = resolveParts(paths)
  return resolved.parts.length
    ? (resolved.absolute ? '/' : '') + resolved.parts.join('/')
    : resolved.absolute
      ? '/'
      : '.'
}

export function normalize (path: string) {
  return join(path)
}

export function relative (from: string, to: string) {
  const fromParts = parse(from).parts
  const toParts = parse(to).parts

  const firstDiff = fromParts.findIndex((part, i) => i >= toParts.length || part !== toParts[i])
  if (firstDiff === -1) {
    return toParts.slice(fromParts.length).join('/') || '.'
  }

  const result = '../'.repeat(fromParts.length - firstDiff)
  if (toParts.length > firstDiff) {
    return result + toParts.slice(firstDiff).join('/')
  }
  return result.slice(0, -1)
}

export function dirname (path: string) {
  const resolved = normalize(path)
  const lastSlash = resolved.lastIndexOf('/')
  if (lastSlash === -1) return '.'
  return resolved.slice(0, lastSlash)
}
