/**
 * HTTPS 自签证书离线测试(无需 Electron / 无需真实网络)。
 *
 * 覆盖:证书可被 X.509 解析、SAN 覆盖传入的 IP/DNS、私钥与证书匹配、
 * 自签可校验、有效期未溢出 UTCTime 编码窗口、压缩 IPv6 正确展开、
 * 非法输入被拒绝(而不是静默写成 0.0.0.0)、指纹稳定且格式正确。
 *
 * 用法:node scripts/tls-cert-test.mjs
 */

import { createRequire } from 'node:module'
import { X509Certificate, createPublicKey, verify as cryptoVerify } from 'node:crypto'

const require = createRequire(import.meta.url)
const { generateSelfSignedCert, certFingerprint, certCoversHosts } = require('../dist/main/tls-cert.js')

/** 读取 DER TLV:返回 [tag, headerLen, contentLen]。 */
function derTlv(buf, offset) {
  const tag = buf[offset]
  let len = buf[offset + 1]
  let header = 2
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 2 + i]
    header = 2 + n
  }
  return { tag, header, len }
}

/**
 * 校验自签证书的签名:拆出 tbsCertificate,用证书自身公钥验 RSA-SHA256。
 * 这是对 X.509 结构拼装是否正确最直接的验证(不做它就只能靠"能解析"来判断)。
 */
function verifySelfSignature(pem) {
  const x1 = new X509Certificate(pem)
  const der = x1.raw
  const outer = derTlv(der, 0)
  if (outer.tag !== 0x30) throw new Error('最外层不是 SEQUENCE')
  const tbs = derTlv(der, outer.header)
  const tbsBytes = der.subarray(outer.header, outer.header + tbs.header + tbs.len)
  const afterTbs = outer.header + tbs.header + tbs.len
  const alg = derTlv(der, afterTbs)
  const sigHeaderStart = afterTbs + alg.header + alg.len
  const sig = derTlv(der, sigHeaderStart)
  // BIT STRING 内容首字节是「未使用位数」,签名数据在其后。
  const sigBytes = der.subarray(sigHeaderStart + sig.header + 1, sigHeaderStart + sig.header + sig.len)
  return cryptoVerify('sha256', tbsBytes, x1.publicKey, sigBytes)
}

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`)
  }
}

function expectThrow(name, fn) {
  try {
    fn()
    failures++
    console.log(`✗ ${name}\n    期望抛错,实际成功返回`)
  } catch {
    console.log(`✓ ${name}`)
  }
}

// ---- 基本生成与解析 ----
{
  const { key, cert } = generateSelfSignedCert([
    { kind: 'ip', value: '192.168.1.10' },
    { kind: 'ip', value: '10.0.0.5' },
    { kind: 'ip', value: '127.0.0.1' },
    { kind: 'dns', value: 'localhost' },
  ])

  const x = new X509Certificate(cert)
  check('证书可被 X.509 解析', x.subject.includes('CN=dsh-desktop'), true)
  check('签发者与主体一致(自签)', x.issuer, x.subject)

  // SAN 覆盖
  check('SAN 覆盖首个局域网 IP', x.checkIP('192.168.1.10'), '192.168.1.10')
  check('SAN 覆盖第二个局域网 IP', x.checkIP('10.0.0.5'), '10.0.0.5')
  check('SAN 覆盖 127.0.0.1', x.checkIP('127.0.0.1'), '127.0.0.1')
  check('SAN 覆盖 localhost', x.checkHost('localhost'), 'localhost')

  // 未包含的地址必须不匹配(否则说明 SAN 写错)
  check('未列出的 IP 不匹配', x.checkIP('192.168.1.99'), undefined)

  // 私钥与证书公钥一致
  const pub = createPublicKey(key)
  check('私钥可导出为公钥', pub.asymmetricKeyType, 'rsa')
  check(
    '证书公钥与私钥同源',
    pub.export({ type: 'spki', format: 'der' }).equals(x.publicKey.export({ type: 'spki', format: 'der' })),
    true,
  )

  // DER 长度符合 RSA-2048(签名块 256 字节 + TBS),且自签签名可被自身公钥验证
  check('证书 DER 长度符合 RSA-2048', x.raw.length > 600 && x.raw.length < 2000, true)
  check('自签签名可被证书公钥验证', verifySelfSignature(cert), true)

  // 有效期:10 年,且不溢出 UTCTime(必须 < 2050)
  const notAfter = new Date(x.validTo)
  check('有效期在 2049 年之前(UTCTime 可编码)', notAfter.getUTCFullYear() < 2050, true)
  check('有效期不早于当前', notAfter.getTime() > Date.now(), true)

  // 指纹:格式与稳定性
  const fp = certFingerprint(cert)
  check('指纹为 SHA-256 冒号分隔大写十六进制', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp), true)
  check('同一证书指纹稳定', certFingerprint(cert), fp)
}

// ---- IPv6 ----
{
  // 压缩形式必须正确展开,而不是退化成 0.0.0.0
  const { cert } = generateSelfSignedCert([{ kind: 'ip', value: 'fe80::202:b3ff:fe1e:8329' }])
  const x = new X509Certificate(cert)
  check('压缩 IPv6 正确写入 SAN', x.checkIP('fe80::202:b3ff:fe1e:8329'), 'fe80::202:b3ff:fe1e:8329')

  const full = generateSelfSignedCert([{ kind: 'ip', value: 'fe80:0000:0000:0000:0202:b3ff:fe1e:8329' }]).cert
  check('展开形式 IPv6 与压缩形式等价', new X509Certificate(full).checkIP('fe80::202:b3ff:fe1e:8329'), 'fe80::202:b3ff:fe1e:8329')

  const loop = new X509Certificate(generateSelfSignedCert([{ kind: 'ip', value: '::1' }]).cert)
  check('::1 正确写入 SAN', loop.checkIP('::1'), '::1')

  // 绝不能出现 0.0.0.0(旧实现会静默写成它,导致证书永远匹配不上)
  check('SAN 未写入 0.0.0.0', loop.checkIP('0.0.0.0'), undefined)
  check('SAN 未写入无关 IPv4', loop.checkIP('127.0.0.1'), undefined)
}

// ---- 非法输入必须抛错,而不是产出坏证书 ----
{
  expectThrow('非 IP/DNS 字面量被拒绝', () => generateSelfSignedCert([{ kind: 'ip', value: 'not-an-ip' }]))
  expectThrow('超范围 IPv4 被拒绝', () => generateSelfSignedCert([{ kind: 'ip', value: '999.1.1.1' }]))
  expectThrow('残缺 IPv4 被拒绝', () => generateSelfSignedCert([{ kind: 'ip', value: '192.168.1' }]))
  expectThrow('非法 IPv6 被拒绝', () => generateSelfSignedCert([{ kind: 'ip', value: 'fe80::gggg' }]))
}

// ---- 空 SAN 仍可生成(只有 127.0.0.1/localhost 的极端情况由调用方保证) ----
{
  const { cert } = generateSelfSignedCert([])
  check('空 SAN 仍产出可解析证书', cert.includes('BEGIN CERTIFICATE'), true)
}

// ---- 缓存证书的复用判定(换网络后必须重新签发) ----
{
  check('覆盖当前全部地址 → 可复用', certCoversHosts(['127.0.0.1', '192.168.1.10'], ['127.0.0.1', '192.168.1.10']), true)
  check('多覆盖几个地址仍可复用', certCoversHosts(['127.0.0.1', '192.168.1.10', '10.0.0.5'], ['127.0.0.1']), true)
  check('缺少当前地址 → 需重签', certCoversHosts(['127.0.0.1', '192.168.1.10'], ['127.0.0.1', '192.168.1.20']), false)
  check('换网络(仅剩新地址)→ 需重签', certCoversHosts(['192.168.1.10'], ['10.0.0.5']), false)
  check('空缓存 → 需重签', certCoversHosts([], ['127.0.0.1']), false)
  check('当前地址为空 → 需重签', certCoversHosts(['127.0.0.1'], []), false)
  check('大小写与空白不敏感', certCoversHosts([' 127.0.0.1 '], ['127.0.0.1']), true)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
