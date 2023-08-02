interface ParsedPath {
  absolute: boolean
  parts: string[]
}

const parseParts = (paths: string[]): ParsedPath => {
  const parts: string[] = []
  const absolute = paths.length > 0 && paths[0].startsWith('/')

  for (const path of paths) {
    for (const part of path.split('/')) {
      parts.push(part)
    }
  }

  return {
    absolute,
    parts
  }
}

const resolve = (parsed: ParsedPath) => {
  let ptr = -1
  let topPtr = -1
  for (let i = 0; i < parsed.parts.length; ++i) {
    if (parsed.parts[i] === '..') {
      if (ptr === topPtr) {
        if (!parsed.absolute) {
          parsed.parts[++ptr] = '..'
          ++topPtr
        }
      } else --ptr
    } else if (++ptr !== i) {
      parsed.parts[ptr] = parsed.parts[i]
    }
  }
  parsed.parts.length = ptr + 1
  return parsed
}

export function parse (path: string) {
  return parseParts([path])
}

export function join (...paths: string[]) {
  const parsed = resolve(parseParts(paths))
  return parsed.parts.length
    ? (parsed.absolute ? '/' : '') + parsed.parts.join('/')
    : parsed.absolute
      ? '/'
      : '.'
}

export function normalize (path: string) {
  return join(path)
}

export function relative (from: string, to: string) {
  const fromParts = resolve(parse(from)).parts
  const toParts = resolve(parse(to)).parts

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
