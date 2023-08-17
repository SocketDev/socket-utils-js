const fs = require('fs')
const path = require('path')

const patchImports = (src) => {
  const patchedImports = src.replace(
    /import(.*?)from\s+(?:'|")(\.\/.*?)(?:'|")/g,
    (stmt, spec, name) => `import${spec}from '${name}.mjs'`
  )
  return patchedImports
}

async function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcLoc = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(srcLoc)
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.js')) {
      const src = fs.readFileSync(srcLoc, 'utf-8')
      const patched = patchImports(src)

      fs.writeFileSync(path.join(dir, entry.name.slice(0, -3) + '.mjs'), patched)
      fs.unlinkSync(srcLoc)
    } else if (entry.name.endsWith('.d.ts')) {
      const src = fs.readFileSync(srcLoc, 'utf-8')
      const patched = patchImports(src).replace(
        /\/\/# sourceMappingURL=(.*?)(?:\n|$)/,
        (stmt, name) => `//# sourceMappingURL=${name.replace(/\.d\.ts\.map/, '.d.mts.map')}\n`
      )

      fs.writeFileSync(path.join(dir, entry.name.slice(0, -5) + '.d.mts'), patched)
      fs.unlinkSync(srcLoc)
    } else if (entry.name.endsWith('.d.ts.map')) {
      const src = JSON.parse(fs.readFileSync(srcLoc, 'utf-8'))
      src.file = src.file.replace(/\.d\.ts/, '.d.mts')

      fs.writeFileSync(path.join(dir, entry.name.slice(0, -9) + '.d.mts.map'), JSON.stringify(src))
      fs.unlinkSync(srcLoc)
    }
  }
}

walk('esm')
