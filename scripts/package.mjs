import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, '.orca', 'package', 'gitflow-hub')
await rm(output, {recursive:true, force:true})
await mkdir(output, {recursive:true})
async function copySource(relative) {
  for (const entry of await readdir(join(root,relative),{withFileTypes:true})) {
    const path=join(relative,entry.name)
    if(entry.isDirectory()) await copySource(path)
    else if(entry.isFile() && !/\.(test|check)\.tsx?$/.test(entry.name)) {
      await mkdir(dirname(join(output,path)),{recursive:true})
      await cp(join(root,path),join(output,path))
    }
  }
}
await copySource('src')
for (const file of ['orca-plugin.json','README.md']) await cp(join(root,file),join(output,file))
const manifest=JSON.parse(await readFile(join(output,'orca-plugin.json'),'utf8'))
await writeFile(join(output,'PACKAGE.txt'),`${manifest.name} ${manifest.version}\nGenerated from source; no node_modules or test fixtures.\n`)
process.stdout.write(`${output}\n`)
