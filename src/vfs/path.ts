const resolveParts = (paths: string[]) => {
  const parts: string[] = []

  for (const path of paths) {
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!parts.length || parts[parts.length - 1] === '..') {
          parts.push('..')
        } else {
          parts.pop()
        }
      } else {
        parts.push(part)
      }
    }
  }

  return parts
}

export function parse (path: string) {
  return resolveParts([path])
}

export function join (...paths: string[]) {
  return resolveParts(paths).join('/') || '.'
}

export function normalize (path: string) {
  return join(path)
}

export function relative (from: string, to: string) {
  const fromParts = parse(from)
  const toParts = parse(to)

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
