interface ParsedPath {
  absolute: boolean
  parts: string[]
}

const parseParts = (paths: string[]): ParsedPath => {
  const parts: string[] = []
  const absolute = paths.length > 0 && paths[0].startsWith('/')

  for (let i = 0; i < paths.length; ++i) {
    const pathParts = paths[i].split('/')
    let j = i === 0 && absolute ? 1 : 0
    if (
      pathParts.length === j + 1 && (
      !pathParts[j] || (!j && pathParts[j] === '.')
    )) {
      continue
    }
    for (; j < pathParts.length; ++j) {
      parts.push(pathParts[j])
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
    const part = parsed.parts[i]
    if (part === '..') {
      if (ptr === topPtr) {
        if (!parsed.absolute) {
          parsed.parts[++ptr] = '..'
          ++topPtr
        }
      } else --ptr
    } else if (part && part !== '.' && ++ptr !== i) {
      parsed.parts[ptr] = part
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
  const parsed = parse(path)
  let i = parsed.parts.length - 1
  for (; i >= 0 && !parsed.parts[i]; --i);
  --i
  for (; i >= 0 && !parsed.parts[i]; --i);
  if (++i > 0) {
    return (parsed.absolute ? '/' : '') + parsed.parts.slice(0, i).join('/')
  }
  return parsed.absolute ? '/' : '.'
}
