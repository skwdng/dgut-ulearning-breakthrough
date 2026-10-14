// Metro 配置。
//
// maxWorkers: 1 的原因：
// 默认 Metro 会 fork 多个 worker 子进程做转换。在受限环境（如 DSH 沙箱）里
// 进程间管道会被拒绝（spawn EPERM），所以这里强制单进程，牺牲速度换可用性。
// 在正常开发机上可以删掉这一行以获得多核加速。
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.maxWorkers = 1;

module.exports = config;
