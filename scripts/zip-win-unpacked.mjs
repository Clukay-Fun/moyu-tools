import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const name = `moyu-tools-v${version}-windows-x64-unpacked.zip`

execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path release/win-unpacked -DestinationPath release/${name} -Force`
  ],
  { stdio: 'inherit' }
)

console.log(`created release/${name}`)
