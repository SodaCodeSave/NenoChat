import fs from 'node:fs'

const envText = fs.readFileSync('D:/Codes/Node.js/NenoChat/deploy/nas.env', 'utf8')
const match = envText.match(/^SECRET_KEY=(.+)$/m)
if (!match) {
  console.log('NO-SECRET-IN-ENV')
  process.exit(0)
}
process.env.SECRET_KEY = match[1].trim()
process.env.JWT_SECRET = 'x'.repeat(32)

const { default: Database } = await import('better-sqlite3')
const { decryptSecret, maskSecret } = await import('../apps/server/src/util/crypto')

const db = new Database('Y:/nenochat/data/nenochat.db', { readonly: true })
const row = db.prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?').get('01M7MNGKEMJV7A7JNSF5W0XZRV') as { api_key_enc: string }
db.close()

try {
  const plain = decryptSecret(row.api_key_enc)
  console.log('DECRYPT-OK, masked =', maskSecret(plain), ', len =', plain.length)
} catch (e) {
  console.log('DECRYPT-FAIL:', (e as Error).message)
}
