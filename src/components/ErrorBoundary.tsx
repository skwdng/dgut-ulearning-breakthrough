/**
 * 全局错误边界。
 *
 * 为什么需要它：
 * release 版里任何渲染期异常都会变成**白屏**，用户完全不知道发生了什么，
 * 也没法反馈（实测踩过：优学院绑定页进去就白屏，退出都退不了）。
 *
 * 这个组件把异常捕获下来，显示成可读的错误页，并给一个"重试"按钮。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logRenderError } from '../services/crashLog';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
    // 控制台也打一份，连电脑调试时能看到
    console.error('[LifeKit ErrorBoundary]', error, info.componentStack);
    // 落盘，用户可在「我的 → 崩溃日志」里读出来
    logRenderError(error, info.componentStack);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.wrap}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>出了点问题</Text>
          <Text style={styles.sub}>这个页面没法显示。下面是具体错误，方便定位。</Text>

          <View style={styles.box}>
            <Text style={styles.boxLabel}>错误信息</Text>
            <Text style={styles.mono} selectable>
              {error.name}: {error.message}
            </Text>
          </View>

          {error.stack ? (
            <View style={styles.box}>
              <Text style={styles.boxLabel}>调用栈</Text>
              <Text style={styles.monoSmall} selectable>
                {error.stack.split('\n').slice(0, 18).join('\n')}
              </Text>
            </View>
          ) : null}

          {info ? (
            <View style={styles.box}>
              <Text style={styles.boxLabel}>组件栈</Text>
              <Text style={styles.monoSmall} selectable>
                {info.split('\n').slice(0, 14).join('\n')}
              </Text>
            </View>
          ) : null}

          <Pressable style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>重试</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#FEF2F2' },
  content: { padding: 20, paddingTop: 56 },
  title: { fontSize: 20, fontWeight: '700', color: '#B91C1C', marginBottom: 6 },
  sub: { fontSize: 13, color: '#7F1D1D', marginBottom: 16, lineHeight: 19 },
  box: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FECACA',
    padding: 12,
    marginBottom: 12,
  },
  boxLabel: { fontSize: 11, fontWeight: '600', color: '#B91C1C', marginBottom: 6 },
  mono: { fontSize: 12.5, color: '#111827', fontFamily: 'monospace', lineHeight: 18 },
  monoSmall: { fontSize: 10.5, color: '#374151', fontFamily: 'monospace', lineHeight: 15 },
  btn: {
    backgroundColor: '#EF4444',
    borderRadius: 9,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
