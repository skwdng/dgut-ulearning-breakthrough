// 应用入口。
//
// 不用 expo-router/entry —— 理由见 App.tsx 顶部注释
// （鸿蒙上原生导航会让界面白屏）。
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
