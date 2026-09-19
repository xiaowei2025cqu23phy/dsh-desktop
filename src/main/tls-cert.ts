/**
 * 自签名 TLS 证书生成(纯 node:crypto,零依赖)。
 *
 * 供远程网关在启用 HTTPS 时生成并缓存:手机信任该证书后,访问 https://<LAN IP>
 * 属「安全上下文」,浏览器才允许注册 Service Worker(离线外壳)。证书的 SAN
 * 包含本机全部局域网 IPv4 + 127.0.0.1 + localhost,避免手机报「主机名不匹配」。
 *
 * 仅用最小编码手拼 X.509 证书(ASN.1 DER)。RSA-2048 + SHA256 签名,有效期约 10 年。
 */

import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto'

// ---- 最小 DER(ASN.1)编码 ----

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  const bytes: number[] = []
  let l = len
  while (l > 0) {
    bytes.unshift(l & 0xff)
    l = Math.floor(l / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derSequence(children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body])
}

function derInteger(value: number): Buffer {
  const bytes: number[] = []
  let v = Math.max(0, Math.floor(value))
  if (v === 0) bytes.push(0)
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (bytes[0] & 0x80) bytes.unshift(0)
  return Buffer.concat([Buffer.from([0x02]), derLength(bytes.length), Buffer.from(bytes)])
}

/** 单个 ASN.1 OID(前两段合并编码,后续段走 base-128)。 */
function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  const out: number[] = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    if (p < 0x80) {
      out.push(p)
      continue
    }
    const enc: number[] = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      enc.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...enc)
  }
  return Buffer.concat([Buffer.from([0x06]), derLength(out.length), Buffer.from(out)])
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00])
}

function derBitString(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x03]), derLength(data.length + 1), Buffer.from([0]), data])
}

function derOctetString(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x04]), derLength(data.length), data])
}

function derUtcTime(date: Date): Buffer {
  // YYMMDDHHMMSSZ(去掉 ISO 里的 '-' ':' 'T' 与毫秒)。
  const s = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z').slice(2)
  return Buffer.concat([Buffer.from([0x17]), derLength(s.length), Buffer.from(s)])
}

function derPrintableString(s: string): Buffer {
  return Buffer.concat([Buffer.from([0x13]), derLength(s.length), Buffer.from(s)])
}

/** 显式上下文标签(如 version [0] EXPLICIT / extensions [3] EXPLICIT)。 */
function derContextTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xa0 | tag]), derLength(content.length), content])
}

/** 上下文隐式标签(如 dNSName [2] / iPAddress [7])。 */
function derContextImplicit(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | tag]), derLength(content.length), content])
}

const OID_CN = '2.5.4.3'
const OID_SHA256_RSA = '1.2.840.113549.1.1.11'
const OID_SAN = '2.5.29.17'

function derName(cn: string): Buffer {
  const attr = derSequence([derOid(OID_CN), derPrintableString(cn)])
  const set = Buffer.concat([Buffer.from([0x31]), derLength(attr.length), attr])
  return derSequence([set])
}

/** subjectAltName 扩展值(未包含 OCTET STRING 外壳)。 */
function derSanExt(hosts: Array<{ kind: 'ip' | 'dns'; value: string }>): Buffer {
  const names = hosts.map((h) => {
    if (h.kind === 'dns') return derContextImplicit(2, Buffer.from(h.value, 'utf8'))
    // IPv4 → 4 字节;IPv6 用简单展开(此处只预期 IPv4 与 ::1)。
    const parts = h.value.split('.').map(Number)
    const body = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ? Buffer.from(parts)
      : Buffer.from(h.value.replace(/:/g, ''), 'hex').length === 16 ? Buffer.from(h.value.replace(/:/g, ''), 'hex') : Buffer.from([0, 0, 0, 0])
    return derContextImplicit(7, body)
  })
  return derSequence(names)
}

/** 生成自签名证书,返回 PEM 的 key 与 cert。hosts 为 SAN(IP + DNS)。 */
export function generateSelfSignedCert(hosts: Array<{ kind: 'ip' | 'dns'; value: string }>): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const serial = Number(randomBytes(6).readUIntBE(0, 6))
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  const notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000) // 约 10 年
  const cn = 'dsh-desktop'

  const sanValue = derOctetString(derSanExt(hosts))
  const extension = derSequence([derOid(OID_SAN), sanValue])
  const extensions = derSequence([extension])

  const tbs = derSequence([
    derContextTag(0, derInteger(2)), // version [0] EXPLICIT v3
    derInteger(serial),
    derSequence([derOid(OID_SHA256_RSA), derNull()]), // signatureAlgorithm
    derName(cn),
    derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]), // validity
    derName(cn),
    spki, // subjectPublicKeyInfo(SPKI 即 DER 编码的 SEQUENCE)
    derContextTag(3, extensions), // extensions [3] EXPLICIT
  ])

  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey)
  const cert = derSequence([
    tbs,
    derSequence([derOid(OID_SHA256_RSA), derNull()]), // 外层 signatureAlgorithm
    derBitString(signature),
  ])

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END CERTIFICATE-----\n',
  }
}
