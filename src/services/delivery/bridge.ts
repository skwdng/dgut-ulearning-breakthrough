/**
 * 外卖通知监听的桥接层。
 *
 * 现实约束：
 * - **Android**：可以读通知（需用户授予"通知使用权"），靠原生 NotificationListenerService 实现
 * - **iOS**：系统不允许第三方 App 读其他 App 通知，此功能不可用
 * - **Expo Go**：不含自定义原生模块，需要 prebuild 后用自定义构建
 *
 * 本层保证以上三种情况下 App 都不会崩：不可用时返回 false，UI 降级为手动记录。
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { RawNotification } from '../../state/deliveryStore';

interface DeliveryNativeModule {
  isAvailable(): Promise<boolean> | boolean;
  isListeningEnabled(): Promise<boolean> | boolean;
  openNotificationSettings(): Promise<boolean> | boolean;
  /** 取出原生在后台攒下的通知（App 启动时调用） */
  drainPending(): Promise<RawNotification[]>;
  clearPending(): Promise<boolean> | boolean;
  /** 当前已监听的外卖包名 */
  watchedPackages(): Promise<string[]> | string[];
}

const NATIVE = (NativeModules as Record<string, DeliveryNativeModule | undefined>).DeliveryNotification;

export const DeliveryBridge = {
  /** 当前构建是否包含原生监听能力 */
  async isAvailable(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    if (!NATIVE) return false;
    try {
      return await Promise.resolve(NATIVE.isAvailable());
    } catch {
      return false;
    }
  },

  async isListeningEnabled(): Promise<boolean> {
    if (!NATIVE) return false;
    try {
      return await Promise.resolve(NATIVE.isListeningEnabled());
    } catch {
      return false;
    }
  },

  /** 打开系统的"通知使用权"设置页，让用户授权 */
  async openNotificationSettings(): Promise<boolean> {
    if (!NATIVE) return false;
    try {
      return await Promise.resolve(NATIVE.openNotificationSettings());
    } catch {
      return false;
    }
  },

  /** 冷启动补处理：把后台攒的通知取出来 */
  async drainPending(): Promise<RawNotification[]> {
    if (!NATIVE) return [];
    try {
      const list = await Promise.resolve(NATIVE.drainPending());
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  async clearPending(): Promise<void> {
    if (!NATIVE) return;
    try {
      await Promise.resolve(NATIVE.clearPending());
    } catch {
      /* ignore */
    }
  },

  async watchedPackages(): Promise<string[]> {
    if (!NATIVE) return [];
    try {
      const list = await Promise.resolve(NATIVE.watchedPackages());
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  /**
   * 订阅 App 运行期间的原生通知事件。
   * 返回取消订阅函数；不可用时返回 noop。
   */
  subscribe(onNotifications: (items: RawNotification[]) => void): () => void {
    if (Platform.OS !== 'android' || !NATIVE) return () => {};
    try {
      const emitter = new NativeEventEmitter(NATIVE as never);
      const sub = emitter.addListener('deliveryNotification', (payload: RawNotification | RawNotification[]) => {
        const items = Array.isArray(payload) ? payload : [payload];
        onNotifications(items);
      });
      return () => sub.remove();
    } catch {
      return () => {};
    }
  },
};
