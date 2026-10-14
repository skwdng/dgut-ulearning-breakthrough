/**
 * 纯 TypeScript 实现的 AES-128-CBC + PKCS7 填充，专用于还原 DGUT CAS 登录页的密码加密。
 *
 * 为什么自己写：RN 环境没有 WebCrypto 的 AES，而这条链路必须零依赖才能"装上就跑"。
 * 正确性由 selfTest() 用 FIPS-197 / NIST SP 800-38A 官方测试向量自证。
 *
 * 上游算法（来自公开逆向分析）：
 *   密文 = Base64( AES-CBC( key = pwdEncryptSalt, iv = random16, PKCS7( random64 + password ) ) )
 *   随机字符集 = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
 */

export const AES_CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

export function randomString(length: number, charset = AES_CHARSET): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return out;
}

// ---------- AES 核心表 ----------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function buildSBox() {
  const p = new Uint8Array(256);
  const q = new Uint8Array(256);
  // 初始化
  let x = 1;
  for (let i = 0; i < 256; i += 1) {
    p[i] = x;
    // x * 3 in GF(2^8)
    x = (x ^ ((x << 1) & 0xff)) ^ (x & 0x80 ? 0x1b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i += 1) {
    const a = p[i];
    const inv = p[255 - i];
    q[a] = inv;
  }
  // 仿射变换
  for (let i = 0; i < 256; i += 1) {
    let a = q[i];
    let s = a;
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

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function mul(a: number, b: number): number {
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

function expandKey(key: Uint8Array): Uint8Array[] {
  const Nk = 4; // 128-bit
  const Nr = 10;
  const words: number[][] = [];
  for (let i = 0; i < Nk; i += 1) {
    words.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }
  for (let i = Nk; i < 4 * (Nr + 1); i += 1) {
    let temp = [...words[i - 1]];
    if (i % Nk === 0) {
      temp = [temp[1], temp[2], temp[3], temp[0]].map((b) => SBOX[b]);
      temp[0] ^= RCON[i / Nk - 1];
    }
    const prev = words[i - Nk];
    words.push(temp.map((b, idx) => b ^ prev[idx]));
  }
  const roundKeys: Uint8Array[] = [];
  for (let r = 0; r <= Nr; r += 1) {
    const rk = new Uint8Array(16);
    for (let c = 0; c < 4; c += 1) {
      for (let row = 0; row < 4; row += 1) {
        rk[c * 4 + row] = words[r * 4 + c][row];
      }
    }
    roundKeys.push(rk);
  }
  return roundKeys;
}

function addRoundKey(state: Uint8Array, rk: Uint8Array) {
  for (let i = 0; i < 16; i += 1) state[i] ^= rk[i];
}

/** state 按列优先存放（AES 标准），这里直接用 16 字节数组按列排列 */
function subBytes(state: Uint8Array, box: Uint8Array) {
  for (let i = 0; i < 16; i += 1) state[i] = box[state[i]];
}

function shiftRows(state: Uint8Array) {
  const tmp = state.slice();
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      state[r + 4 * c] = tmp[r + 4 * ((c + r) % 4)];
    }
  }
}

function invShiftRows(state: Uint8Array) {
  const tmp = state.slice();
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      state[r + 4 * ((c + r) % 4)] = tmp[r + 4 * c];
    }
  }
}

function mixColumns(state: Uint8Array) {
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

function invMixColumns(state: Uint8Array) {
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

function encryptBlock(block: Uint8Array, roundKeys: Uint8Array[]): Uint8Array {
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

function decryptBlock(block: Uint8Array, roundKeys: Uint8Array[]): Uint8Array {
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

// ---------- 对外 API ----------

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) return data;
  return data.slice(0, data.length - pad);
}

export function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error('AES-128 需要 16 字节密钥（优学院 pwdEncryptSalt 应为 16 位）');
  if (iv.length !== 16) throw new Error('IV 需要 16 字节');
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

export function aesCbcDecrypt(cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
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

// ---------- Base64 / UTF-8 ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
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

export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text.charCodeAt((i += 1));
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 还原 encryptPassword(password, salt)：
 *   AES-CBC( random64 + password ) → Base64
 */
export function encryptCasPassword(password: string, salt: string): string {
  if (!salt) return password;
  if (salt.length !== 16) {
    // 密钥长度不符时不许静默降级成明文，必须显式失败，避免"看起来登录了其实没登录"
    throw new Error(`pwdEncryptSalt 长度异常：${salt.length}（期望 16），接口可能已变更`);
  }
  const key = utf8ToBytes(salt);
  const iv = utf8ToBytes(randomString(16));
  const plain = utf8ToBytes(randomString(64) + password);
  return bytesToBase64(aesCbcEncrypt(plain, key, iv));
}

/**
 * 自检：用 NIST SP 800-38A 的 AES-128-CBC 官方向量验证实现正确性。
 * 向量：
 *   key = 2b7e151628aed2a6abf7158809cf4f3c
 *   iv  = 000102030405060708090a0b0c0d0e0f
 *   pt  = 6bc1bee22e409f96e93d7e117393172a
 *   ct  = 7649abac8119b246cee98e9b12e9197d
 * 返回 true 表示实现可信；App 启动时若为 false 应禁用"账号密码登录"并提示升级。
 */
export function selfTest(): boolean {
  try {
    const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
    const iv = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const pt = hexToBytes('6bc1bee22e409f96e93d7e117393172a');
    // 直接对单块加密（不做 padding 影响：这里用等价的手工实现校验）
    const roundKeys = expandKey(key);
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) block[i] = pt[i] ^ iv[i];
    const ct = bytesToHex(encryptBlock(block, roundKeys));
    if (ct !== '7649abac8119b246cee98e9b12e9197d') return false;

    // 往返测试：加密后再解密必须还原
    const plain = utf8ToBytes(randomString(64) + 'P@ssw0rd-测试');
    const enc = aesCbcEncrypt(plain, key, iv);
    const dec = aesCbcDecrypt(enc, key, iv);
    if (dec.length !== plain.length) return false;
    for (let i = 0; i < plain.length; i += 1) if (dec[i] !== plain[i]) return false;
    return true;
  } catch {
    return false;
  }
}
