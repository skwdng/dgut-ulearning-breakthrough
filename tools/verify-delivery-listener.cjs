/**
 * 钉住「外卖通知监听」这个 Service 的类名一致性。
 *
 * ╷ 为什么必须单独验 ╷
 * 这个 Service 曾经在 manifest 里被写成相对名 `.delivery.DeliveryNotificationListener`。
 * 相对名按 namespace（applicationId = com.lifekit.app.test）展开成
 *   com.lifekit.app.test.delivery.DeliveryNotificationListener
 * 而 Kotlin 源码写的是 `package com.lifekit.delivery`，真正打进 dex 的类叫
 *   com.lifekit.delivery.DeliveryNotificationListener
 * 名字对不上 → Android 一启动进程就 handleCreateService 抛 ClassNotFoundException，
 * 直接把进程杀掉。真机表现是「点进去退一下 / 退两次才进得去」，
 * 而 JS 侧只能看到 77ms 就没了，误以为崩在原生深层。
 *
 * 定位依据：服务器 /opt/lifekit/client-errors.log 里的 native_crash 栈
 * （1.1.7-test.12 ~ test.17 每个版本都中）。
 *
 * 用法：
 *   node tools/verify-delivery-listener.cjs                 # 只查源码/清单
 *   node tools/verify-delivery-listener.cjs <apk>           # 额外确认类真的在 dex 里
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const WIRE = path.join(ROOT, 'tools', 'android', 'wire-native.cjs');
const KT = path.join(ROOT, 'android-native', 'DeliveryNotificationModule.kt');

const FQCN = 'com.lifekit.delivery.DeliveryNotificationListener';
const DEX_NEEDLE = 'com/lifekit/delivery/DeliveryNotificationListener';

let failed = 0;
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function bad(msg) {
  console.log('  × ' + msg);
  failed += 1;
}

console.log('外卖通知监听 Service 类名一致性');

// 1) 清单里必须是全名
if (!fs.existsSync(MANIFEST)) {
  bad(`找不到 ${path.relative(ROOT, MANIFEST)}`);
} else {
  const manifest = fs.readFileSync(MANIFEST, 'utf8');
  if (manifest.includes(`android:name="${FQCN}"`)) ok(`清单声明全名 ${FQCN}`);
  else bad('清单里没有全名声明（相对名会被 namespace 改写，导致 ClassNotFoundException）');
  if (manifest.includes('android:name=".delivery.DeliveryNotificationListener"')) {
    bad('清单里还有相对名 ".delivery.DeliveryNotificationListener"');
  }
  if (!/BIND_NOTIFICATION_LISTENER_SERVICE/.test(manifest)) {
    bad('清单缺少 android:permission=BIND_NOTIFICATION_LISTENER_SERVICE');
  }
  if (!/android\.service\.notification\.NotificationListenerService/.test(manifest)) {
    bad('清单缺少 NotificationListenerService 的 intent-filter');
  }
}

// 2) wire-native 的模板也要写全名（否则下次 prebuild 又插回相对名）
if (!fs.existsSync(WIRE)) {
  bad('找不到 tools/android/wire-native.cjs');
} else {
  const wire = fs.readFileSync(WIRE, 'utf8');
  if (wire.includes('LISTENER_FQCN') || wire.includes(FQCN)) ok('wire-native 使用全名模板');
  else bad('wire-native 里没有全名模板，下次 prebuild 会写回相对名');
  if (/android:name="\.delivery\.DeliveryNotificationListener"/.test(wire)) {
    bad('wire-native 里还有相对名模板');
  }
}

// 3) Kotlin 源码的 package 必须是 com.lifekit.delivery（类名由此决定，不是目录）
if (!fs.existsSync(KT)) {
  bad('找不到 android-native/DeliveryNotificationModule.kt');
} else {
  const kt = fs.readFileSync(KT, 'utf8');
  if (/^package com\.lifekit\.delivery$/m.test(kt)) ok('Kotlin package = com.lifekit.delivery');
  else bad('Kotlin package 不是 com.lifekit.delivery，清单全名会对不上');
  if (/class DeliveryNotificationListener\s*:\s*NotificationListenerService/.test(kt)) {
    ok('DeliveryNotificationListener 继承 NotificationListenerService');
  } else {
    bad('类定义或父类变了');
  }
}

// 4) 可选：确认 APK 的 dex 里真有这个类
const apk = process.argv[2];
if (apk) {
  if (!fs.existsSync(apk)) {
    bad(`找不到 APK: ${apk}`);
  } else {
    const buf = fs.readFileSync(apk);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    let found = false;
    if (eocd >= 0) {
      const count = buf.readUInt16LE(eocd + 10);
      let o = buf.readUInt32LE(eocd + 16);
      for (let i = 0; i < count; i += 1) {
        if (buf.readUInt32LE(o) !== 0x02014b50) break;
        const method = buf.readUInt16LE(o + 10);
        const csize = buf.readUInt32LE(o + 20);
        const nameLen = buf.readUInt16LE(o + 28);
        const extraLen = buf.readUInt16LE(o + 30);
        const commentLen = buf.readUInt16LE(o + 32);
        const localOff = buf.readUInt32LE(o + 42);
        const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
        if (/^classes\d*\.dex$/.test(name)) {
          const lNameLen = buf.readUInt16LE(localOff + 26);
          const lExtraLen = buf.readUInt16LE(localOff + 28);
          const dataStart = localOff + 30 + lNameLen + lExtraLen;
          const raw = buf.subarray(dataStart, dataStart + csize);
          let data;
          try {
            data = method === 0 ? raw : zlib.inflateRawSync(raw);
          } catch {
            data = raw;
          }
          if (data.includes(Buffer.from(DEX_NEEDLE, 'ascii'))) {
            found = true;
            ok(`dex 内含 ${DEX_NEEDLE}（${name}）`);
            break;
          }
        }
        o += 46 + nameLen + extraLen + commentLen;
      }
    }
    if (!found) bad('APK 的 dex 里找不到 com/lifekit/delivery/DeliveryNotificationListener');
  }
}

console.log('');
if (failed) {
  console.log(`  × ${failed} 项不通过`);
  process.exit(1);
}
console.log('  ✓ 全部通过');
