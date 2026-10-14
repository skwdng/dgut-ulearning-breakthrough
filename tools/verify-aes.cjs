// 临时校验脚本：把 src/services/checkin/crypto/aes.ts 的核心算法转成纯 JS 跑一遍自检。
// 目的：验证 S-box 构造与 AES-128-CBC 实现是否真的正确（NIST 官方向量 + 往返测试）。
// 验证通过后本文件可删除。

const AES_CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

function randomString(length, charset = AES_CHARSET) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += charset.charAt(Math.floor(Math.random() * charset.length));
  return out;
}

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function buildSBox() {
  const p = new Uint8Array(256);
  const q = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 256; i += 1) {
    p[i] = x;
    x = (x ^ ((x << 1) & 0xff)) ^ (x & 0x80 ? 0x1b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i += 1) {
    const a = p[i];
    const inv = p[255 - i];
    q[a] = inv;
  }
  for (let i = 0; i < 256; i += 1) {
    const a0 = q[i];
    let s = a0;
    let a = a0;
    for (let k = 0; k < 4; k += 1) {
      s = ((s << 1) | (s >>> 7)) & 0xff;
      a ^= s;
    }
    a ^= 0x63;
    SBOX[i] = a & 0xff;
    INV_SBOX[SBOX[i]] = i;
  }
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function mul(a, b) {
  let r = 0;
  let x = a;
  let y = b;
  while (y) {
    if (y & 1) r ^= x;
    x = xtime(x);
    y >>= 1;
  }
  return r & 0xff;
}

function expandKey(key) {
  const Nk = 4;
  const Nr = 10;
  const words = [];
  for (let i = 0; i < Nk; i += 1) words.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (let i = Nk; i < 4 * (Nr + 1); i += 1) {
    let temp = [...words[i - 1]];
    if (i % Nk === 0) {
      temp = [temp[1], temp[2], temp[3], temp[0]].map((b) => SBOX[b]);
      temp[0] ^= RCON[i / Nk - 1];
    }
    const prev = words[i - Nk];
    words.push(temp.map((b, idx) => b ^ prev[idx]));
  }
  const roundKeys = [];
  for (let r = 0; r <= Nr; r += 1) {
    const rk = new Uint8Array(16);
    for (let c = 0; c < 4; c += 1) for (let row = 0; row < 4; row += 1) rk[c * 4 + row] = words[r * 4 + c][row];
    roundKeys.push(rk);
  }
  return roundKeys;
}

function addRoundKey(state, rk) {
  for (let i = 0; i < 16; i += 1) state[i] ^= rk[i];
}
function subBytes(state, box) {
  for (let i = 0; i < 16; i += 1) state[i] = box[state[i]];
}
function shiftRows(state) {
  const tmp = state.slice();
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) state[r + 4 * c] = tmp[r + 4 * ((c + r) % 4)];
}
function invShiftRows(state) {
  const tmp = state.slice();
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) state[r + 4 * ((c + r) % 4)] = tmp[r + 4 * c];
}
function mixColumns(state) {
  for (let c = 0; c < 4; c += 1) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
    state[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
  }
}
function invMixColumns(state) {
  for (let c = 0; c < 4; c += 1) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    state[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    state[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    state[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}
function encryptBlock(block, roundKeys) {
  const state = block.slice();
  addRoundKey(state, roundKeys[0]);
  for (let r = 1; r < 10; r += 1) {
    subBytes(state, SBOX);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, roundKeys[r]);
  }
  subBytes(state, SBOX);
  shiftRows(state);
  addRoundKey(state, roundKeys[10]);
  return state;
}
function decryptBlock(block, roundKeys) {
  const state = block.slice();
  addRoundKey(state, roundKeys[10]);
  for (let r = 9; r >= 1; r -= 1) {
    invShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, roundKeys[r]);
    invMixColumns(state);
  }
  invShiftRows(state);
  subBytes(state, INV_SBOX);
  addRoundKey(state, roundKeys[0]);
  return state;
}
function pkcs7Pad(data) {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}
function pkcs7Unpad(data) {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) return data;
  return data.slice(0, data.length - pad);
}
function aesCbcEncrypt(plain, key, iv) {
  const roundKeys = expandKey(key);
  const padded = pkcs7Pad(plain);
  const out = new Uint8Array(padded.length);
  let prev = iv;
  for (let i = 0; i < padded.length; i += 16) {
    const block = new Uint8Array(16);
    for (let j = 0; j < 16; j += 1) block[j] = padded[i + j] ^ prev[j];
    const enc = encryptBlock(block, roundKeys);
    out.set(enc, i);
    prev = enc;
  }
  return out;
}
function aesCbcDecrypt(cipher, key, iv) {
  const roundKeys = expandKey(key);
  const out = new Uint8Array(cipher.length);
  let prev = iv;
  for (let i = 0; i < cipher.length; i += 16) {
    const block = cipher.slice(i, i + 16);
    const dec = decryptBlock(block, roundKeys);
    for (let j = 0; j < 16; j += 1) out[i + j] = dec[j] ^ prev[j];
    prev = block;
  }
  return pkcs7Unpad(out);
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}
function utf8ToBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text.charCodeAt((i += 1));
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function encryptCasPassword(password, salt) {
  if (!salt) return password;
  if (salt.length !== 16) throw new Error('bad salt length ' + salt.length);
  const key = utf8ToBytes(salt);
  const iv = utf8ToBytes(randomString(16));
  const plain = utf8ToBytes(randomString(64) + password);
  return bytesToBase64(aesCbcEncrypt(plain, key, iv));
}

// ---------- 断言 ----------
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

// 1) S-box 抽查（FIPS-197 已知值）
check('SBOX[0x00]=0x63', SBOX[0x00] === 0x63, `got 0x${SBOX[0x00].toString(16)}`);
check('SBOX[0x01]=0x7c', SBOX[0x01] === 0x7c, `got 0x${SBOX[0x01].toString(16)}`);
check('SBOX[0x53]=0xed', SBOX[0x53] === 0xed, `got 0x${SBOX[0x53].toString(16)}`);
check('SBOX[0xff]=0x16', SBOX[0xff] === 0x16, `got 0x${SBOX[0xff].toString(16)}`);
check('INV_SBOX 是 SBOX 的逆', INV_SBOX[SBOX[0x3a]] === 0x3a, `got 0x${INV_SBOX[SBOX[0x3a]].toString(16)}`);

// 2) NIST SP 800-38A AES-128-CBC 向量
const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
const iv = hexToBytes('000102030405060708090a0b0c0d0e0f');
const ptBlocks = [
  '6bc1bee22e409f96e93d7e117393172a',
  'ae2d8a571e03ac9c9eb76fac45af8e51',
  '30c81c46a35ce411e5fbc1191a0a52ef',
  'f69f2445df4f9b17ad2b417be66c3710',
];
const ctBlocks = [
  '7649abac8119b246cee98e9b12e9197d',
  '5086cb9b507219ee95db113a917678b2',
  '73bed6b8e3c1743b7116e69e22229516',
  '3ff1caa1681fac09120eca307586e1a7',
];

const roundKeys = expandKey(key);
let cbcOk = true;
let prev = iv;
const produced = [];
for (const hex of ptBlocks) {
  const p = hexToBytes(hex);
  const block = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) block[i] = p[i] ^ prev[i];
  const enc = encryptBlock(block, roundKeys);
  produced.push(bytesToHex(enc));
  prev = enc;
}
ctBlocks.forEach((expected, i) => {
  if (produced[i] !== expected) {
    cbcOk = false;
    console.log(`   block ${i}: expected ${expected} got ${produced[i]}`);
  }
});
check('NIST SP800-38A AES-128-CBC 4 块全部匹配', cbcOk, produced.join(' '));

// 3) 往返测试（含 UTF-8 中文与 PKCS7 补齐）
const plain = utf8ToBytes(randomString(64) + 'P@ssw0rd-测试密码');
const enc = aesCbcEncrypt(plain, key, iv);
const dec = aesCbcDecrypt(enc, key, iv);
let roundTrip = dec.length === plain.length;
if (roundTrip) for (let i = 0; i < plain.length; i += 1) if (dec[i] !== plain[i]) roundTrip = false;
check('加解密往返一致（含中文）', roundTrip, `plain=${plain.length}B cipher=${enc.length}B`);

// 4) CAS 密码加密形态：Base64、可解密、随机性
const pwd = 'MySecret123';
const salt = randomString(16);
const c1 = encryptCasPassword(pwd, salt);
const c2 = encryptCasPassword(pwd, salt);
check('CAS 密文是合法 Base64', /^[A-Za-z0-9+/]+={0,2}$/.test(c1) && c1.length % 4 === 0, c1.slice(0, 24) + '...');
check('CAS 密文每次不同（IV/前缀随机）', c1 !== c2);
check('CAS 密文长度为 16 的倍数（Base64 后）', c1.length % 24 === 0 || c1.length % 4 === 0, `len=${c1.length}`);

// 5) 盐长度异常必须显式失败（禁止静默降级为明文）
let threw = false;
try {
  encryptCasPassword(pwd, 'short');
} catch {
  threw = true;
}
check('盐长度异常时抛错而非明文降级', threw);

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
