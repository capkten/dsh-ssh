/** Read-only deployment gate: peers alone do not guarantee one SDK instance. */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'

const [hostRoot, pluginRoot] = process.argv.slice(2)
if (!hostRoot || !pluginRoot) {
  throw new Error('Usage: node tests/integration/check-host-sdk.mjs <host dsh root> <installed dsh-ssh root>')
}
const host = createRequire(join(resolve(hostRoot), 'package.json'))
const plugin = createRequire(join(resolve(pluginRoot), 'package.json'))
const packages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-bash-local', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-host-directory-picker']
const checks = packages.map(name => {
  try {
    const hostPath = realpathSync(host.resolve(name))
    const pluginPath = realpathSync(plugin.resolve(name))
    return { name, shared: hostPath === pluginPath, hostPath, pluginPath }
  } catch (error) {
    return { name, shared: false, error: String(error) }
  }
})
console.log(JSON.stringify({ ok: checks.every(check => check.shared), checks }, null, 2))
if (checks.some(check => !check.shared)) process.exitCode = 1
