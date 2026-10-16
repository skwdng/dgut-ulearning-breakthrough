/**
 * 地图选点（真实地图 + 手指拖动 + 半径圈）。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「给我把位置签到完善一下，要做到要在发起签到的设备围一个圈选位置」
 *   「要不就自己引用个地图，手指滑动，让标点对准位置」
 *
 * ══════════════ 为什么用 WebView 而不是原生地图 ══════════════
 *
 * 现状：依赖里有 `react-native-webview`（为了读 Cookie 已经接好原生模块），
 *       **没有** `react-native-maps`。
 *
 * 三条路对比：
 *   · `react-native-maps` —— 要加依赖 + Google Play 服务 + API key，
 *     而且国内很多手机没有 GMS，装了也白屏
 *   · 高德/腾讯 SDK —— 要申请 key、要写原生模块，重
 *   · **WebView + Leaflet + OSM 瓦片**（本方案）——
 *     不加任何依赖、不需要 key、原生工程不用动
 *
 * ⚠️ 代价：地图瓦片要联网（跟优学院一样要联网，不算额外要求）。
 *    OSM 的瓦片服务器在国内速度尚可，但**不保证**；
 *    如果实测太慢，可以换成高德/腾讯的瓦片地址（要申请 key），
 *    换的时候只改下面 TILE_URL 一行。
 *
 * ══════════════ ★ 交互设计：准星固定、地图动 ══════════════
 *
 * 用"手指拖动地图，屏幕中心一个固定准星"的方式，而不是"拖动一个图钉"：
 *   · 手指拖图钉很容易被手指挡住目标点，且拖到屏幕边缘就没了
 *   · 准星固定在正中央 → 想选哪就把那一点拖到中间，能一直微调
 *   · 这是主流地图 App 选点的做法
 *
 * ══════════════ ⚠️ 通信协议（改的时候两边都要改）══════════════
 *
 * 地图是 WebView 里的页面，坐标要传回 RN。用 postMessage + 前缀：
 *
 *   RN → 地图（注入 JS，调 window.__setCircle）
 *     { lat, lng, radius }
 *
 *   地图 → RN（postMessage）
 *     前缀 `LIFEMAP:`
 *     { type:'circle', lat, lng, radius }   ← 地图动了 / 半径改了
 *     { type:'ready' }                       ← 地图初始化完成
 *     { type:'error', message }              ← 瓦片加载失败等
 *
 * ⚠️ 前缀必须保留 —— 页面里还有 Leaflet 自己的事件，不区分会把噪音当成数据。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { color, spacing } from '../theme/tokens';
import { Txt } from './index';
import type { Circle } from '../utils/geo';

/** postMessage 前缀（协议的一部分，别改） */
export const MAP_MSG_PREFIX = 'LIFEMAP:';

/**
 * ══════════════ ★★★ 瓦片源列表（多源自动降级，2026-10）══════════════
 *
 * 真机实测：**`tile.openstreetmap.org` 在国内（尤其移动网络）加载不出来** ——
 * 用户截图里地图是一片灰，只有我加的中文错误提示。
 * （从开发机测它是通的 1279ms，所以这不是代码问题，是网络可达性问题。）
 *
 * 所以改成**按顺序尝试多个源**：某个源连续失败若干次就换下一个。
 *
 * ⚠️⚠️ **全部必须是 WGS-84 坐标系**（和手机 GPS 一致）。
 *
 *    高德 / 腾讯 / 百度的瓦片是 **GCJ-02（国测局加密坐标）**，
 *    与 WGS-84 差 **50~500 米**。虽然它们在国内最快（实测高德 119ms），
 *    但**直接换会造成整体偏移**：用户把准星对准教室 → 读到的是 WGS-84 坐标 →
 *    圈心偏到隔壁楼 → 提交的坐标落在老师设的范围外 → **签不上**。
 *
 *    要用高德就得做 WGS-84 ⇄ GCJ-02 转换（项目里没有实现，且转换有误差）。
 *    在"能显示"和"坐标正确"之间，**坐标正确优先** —— 地图看不见还能凭经纬度猜，
 *    坐标错了会让人以为功能是坏的。
 *
 * ⚠️ 顺序按"国内可达性 + 速度"排：CartoDB 实测 808ms 且是 https，排第一。
 */
const TILE_SOURCES = [
  {
    name: 'CartoDB',
    url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
  {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: '',
    attribution: '&copy; OpenStreetMap',
  },
];

/**
 * 地图页面的 HTML。
 *
 * ⚠️ 为什么用**模板字符串内联**而不是放一个 .html 资源文件：
 *    Metro 打包器默认不把 `.html` 当资源复制进 APK（要么配置
 *    `assetExts`、要么用 expo-asset），而内联字符串**一定能进包**，
 *    也不会因为资源路径在不同构建下变化而失效。
 *    代价是这个文件长一点 —— 但换来"一定可用"。
 */
function buildMapHtml(init: Circle): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body { margin:0; padding:0; height:100%; background:#eef1f5; }
  #map { position:absolute; inset:0; }
  /* 固定准星：屏幕正中央 */
  #cross {
    position:absolute; left:50%; top:50%; width:36px; height:36px;
    margin-left:-18px; margin-top:-18px; pointer-events:none; z-index:900;
  }
  #cross::before, #cross::after {
    content:''; position:absolute; background:#4f46e5;
  }
  #cross::before { left:17px; top:0; width:2px; height:36px; }
  #cross::after  { top:17px; left:0; height:2px; width:36px; }
  #crossDot {
    position:absolute; left:50%; top:50%; width:8px; height:8px;
    margin-left:-4px; margin-top:-4px; border-radius:4px;
    background:#fff; border:2px solid #4f46e5; z-index:901; pointer-events:none;
  }
  #hint {
    position:absolute; left:0; right:0; bottom:0; z-index:902;
    background:rgba(255,255,255,.92); padding:8px 10px;
    font:12px/16px -apple-system,Roboto,sans-serif; color:#4b5563; text-align:center;
  }
  #err {
    position:absolute; left:8px; right:8px; top:8px; z-index:903; display:none;
    background:#fee2e2; color:#991b1b; padding:8px; border-radius:6px;
    font:12px/16px -apple-system,Roboto,sans-serif;
  }
</style>
</head>
<body>
<div id="map"></div>
<div id="cross"></div><div id="crossDot"></div>
<div id="err"></div>
<div id="hint">拖动地图，把准星对准要签到的位置</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var PREFIX = ${JSON.stringify(MAP_MSG_PREFIX)};
  function send(obj) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(PREFIX + JSON.stringify(obj));
      }
    } catch (e) { /* 回传失败不致命 */ }
  }
  function fail(msg) {
    var el = document.getElementById('err');
    el.style.display = 'block';
    el.textContent = msg;
    send({ type: 'error', message: msg });
  }
  /** 清掉错误提示（换源成功后调用） */
  function clearErr() {
    var el = document.getElementById('err');
    el.style.display = 'none';
    el.textContent = '';
  }
  /** 改底部那行提示（换源时告诉用户发生了什么） */
  function setHint(text) {
    var el = document.getElementById('hint');
    if (el) el.textContent = text;
  }

  /**
   * ⚠️ Leaflet 从 unpkg CDN 加载。如果加载失败（断网/CDN 被墙），
   *    页面会变成一片灰 —— 必须**明确告诉用户**，而不是白屏让人猜。
   */
  if (typeof L === 'undefined') {
    fail('地图库加载失败（需要联网）。请检查网络后重试。');
    return;
  }

  var init = ${JSON.stringify(init)};
  var SOURCES = ${JSON.stringify(TILE_SOURCES)};

  var map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    // 准星在中心，所以"拖动有惯性"反而不好对准，关掉更稳
    inertia: false,
  }).setView([init.latitude, init.longitude], 17);

  /**
   * ══════════════ ★★★ 瓦片多源自动降级 ══════════════
   *
   * 真机踩过：tile.openstreetmap.org 在国内加载不出来（一片灰），
   * 但从开发机测它是通的 —— 所以**不能只赌一个源**。
   *
   * 策略：某个源累计失败 >= 3 张瓦片就换下一个源，
   *      全部试完还失败才报错（并且说清是所有源都没通）。
   *
   * ⚠️ 这段在**模板字符串**里，所以注释里**不能用反引号** ——
   *    反引号会把模板提前结束，报一堆看不懂的语法错误（这个坑踩过两次）。
   *
   * ⚠️ 阈值取 3 而不是 1：偶发一两张瓦片失败（网络抖动、边缘瓦片）
   *    不该触发换源，否则会在两个源之间来回跳，看着像地图在闪。
   *
   * ⚠️ 换源时必须先把旧图层从地图上移除（map.removeLayer）—— 不删的话，
   *    两个源的瓦片会叠在一起，怎么调都对不齐。
   */
  var srcIndex = 0;
  var tileErrors = 0;
  var tiles = null;

  function useSource(i) {
    if (tiles) {
      map.removeLayer(tiles);
      tiles = null;
    }
    var s = SOURCES[i];
    tiles = L.tileLayer(s.url, {
      maxZoom: 19,
      attribution: s.attribution,
      subdomains: s.subdomains || 'abc',
      /**
       * ⚠️ 必须开跨源 —— 有的瓦片服务不发 CORS 头，
       *    不开的话 Leaflet 会静默失败，表现为"一片灰但没有任何报错"。
       */
      crossOrigin: true,
    });
    tileErrors = 0;
    tiles.on('tileerror', function () {
      tileErrors += 1;
      if (tileErrors < 3) return;
      if (srcIndex + 1 < SOURCES.length) {
        srcIndex += 1;
        useSource(srcIndex);
        setHint('地图源不可用，已自动切换到 ' + SOURCES[srcIndex].name);
        clearErr();
        send({ type: 'source', name: SOURCES[srcIndex].name });
      } else {
        fail('所有地图源都加载失败（网络不通或被拦截）。\\n坐标准确性不受影响 —— 可以凭经纬度手动微调。');
      }
    });
    /** 有一张瓦片成功就说明这个源可用 */
    tiles.on('tileload', function () {
      tileErrors = 0;
      clearErr();
    });
    tiles.addTo(map);
    send({ type: 'source', name: s.name });
  }

  useSource(0);

  // 半径圈（视觉参考，跟着地图动）
  var circleLayer = L.circle([init.latitude, init.longitude], {
    radius: init.radius,
    color: '#4f46e5',
    weight: 2,
    fillColor: '#4f46e5',
    fillOpacity: 0.12,
    interactive: false,
  }).addTo(map);

  /** 当前准星所在坐标 = 地图中心 */
  function currentCenter() {
    var c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }
  var radius = init.radius;

  function emit() {
    var c = currentCenter();
    circleLayer.setLatLng([c.lat, c.lng]);
    send({ type: 'circle', lat: c.lat, lng: c.lng, radius: radius });
  }

  /**
   * ⚠️ 用 moveend 而不是 move ——
   *    move 在拖动过程中每帧都触发，会把几百条消息灌进 RN，
   *    在低端机上直接卡住。moveend 只在手指松开后触发一次。
   *
   * ⚠️ 这段注释里**不能用反引号** —— 整个 HTML 是一个模板字符串，
   *    反引号会把模板提前结束掉，报一堆莫名其妙的语法错误。
   */
  map.on('moveend', emit);

  /** RN 侧调这个来设定/更新圈（切课程、改半径时用） */
  window.__setCircle = function (lat, lng, r) {
    if (typeof r === 'number' && r > 0) {
      radius = r;
      circleLayer.setRadius(r);
    }
    if (typeof lat === 'number' && typeof lng === 'number') {
      map.setView([lat, lng], map.getZoom(), { animate: false });
    }
    emit();
  };

  /** RN 侧调这个来改半径（不动中心） */
  window.__setRadius = function (r) {
    if (typeof r === 'number' && r > 0) {
      radius = r;
      circleLayer.setRadius(r);
      emit();
    }
  };

  map.whenReady(function () {
    send({ type: 'ready' });
    emit();
  });
})();
</script>
</body>
</html>`;
}

export interface MapPickerProps {
  /** 初始圈（通常是课程已存的圈，或当前定位） */
  initial: Circle;
  /** 圈变化时回调（拖动地图 / 改半径都会触发） */
  onChange: (c: Circle) => void;
  /** 地图高度 */
  height?: number;
}

/**
 * 地图选点组件。
 *
 * ⚠️ 用 `key` 强制重挂载的方式切课程：`initial` 变化时**不重建整个 WebView**
 *    （重建会重新下载瓦片、闪一下），而是通过注入 JS 调 `__setCircle` 平滑更新。
 *    这样切换课程时地图是"平移过去"而不是"重新加载"。
 */
export function MapPicker({ initial, onChange, height = 320 }: MapPickerProps) {
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * ⚠️ HTML 只在**首次挂载**时生成一次。
   *    如果每次 render 都重新生成，字符串内容变化会导致 WebView 重新加载
   *    （`source={{html}}` 是按内容比较的）—— 拖动一下地图就重载一次，没法用。
   */
  const html = useMemo(
    () => buildMapHtml(initial),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const raw = e.nativeEvent.data ?? '';
      if (!raw.startsWith(MAP_MSG_PREFIX)) return;
      let msg: { type?: string; lat?: number; lng?: number; radius?: number; message?: string };
      try {
        msg = JSON.parse(raw.slice(MAP_MSG_PREFIX.length));
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        setReady(true);
        return;
      }
      if (msg.type === 'error') {
        setError(msg.message ?? '地图加载失败');
        return;
      }
      if (msg.type === 'circle' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        onChange({
          latitude: msg.lat,
          longitude: msg.lng,
          radius: typeof msg.radius === 'number' && msg.radius > 0 ? msg.radius : initial.radius,
        });
      }
    },
    [onChange, initial.radius],
  );

  /** 外部改了初始圈（切课程）→ 注入 JS 平滑更新，不重建 WebView */
  React.useEffect(() => {
    if (!ready) return;
    ref.current?.injectJavaScript(
      `window.__setCircle && window.__setCircle(${initial.latitude}, ${initial.longitude}, ${initial.radius}); true;`,
    );
  }, [ready, initial.latitude, initial.longitude, initial.radius]);

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        ref={ref}
        source={{ html }}
        originWhitelist={['*']}
        onMessage={onMessage}
        /**
         * ⚠️ 必须允许 JS 与 DOM 存储 —— Leaflet 是 JS 库，
         *    而且地图瓦片要靠 DOM 存储缓存，否则每次拖动都重新下载。
         */
        javaScriptEnabled
        domStorageEnabled
        /**
         * ⚠️ 必须允许混合内容 / 明文：
         *    瓦片是 https，但有些网络环境下会重定向到 http。
         */
        mixedContentMode="compatibility"
        /** 地图要能双指缩放 */
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        /** 加载期间不显示白屏 */
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={color.primary[500]} />
            <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: spacing.sm }}>
              正在加载地图…
            </Txt>
          </View>
        )}
      />
      {error ? (
        <View style={styles.errBar}>
          <Txt variant="caption" c={color.error[600]}>
            {error}
          </Txt>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: color.neutral[100],
  },
  loading: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.error[50] ?? '#fee2e2',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
