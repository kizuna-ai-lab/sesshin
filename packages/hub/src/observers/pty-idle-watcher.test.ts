import { describe, it, expect, beforeEach } from 'vitest';
import { wirePtyIdleWatcher } from './pty-idle-watcher.js';
import { PtyTap } from './pty-tap.js';
import { SessionRegistry } from '../registry/session-registry.js';

// Use injected `now` so the watcher's internal setInterval is suppressed and
// tests advance time deterministically by calling tick() after bumping `t`.
function makeFixture(opts?: { highBytesPerSec?: number; lowBytesPerSec?: number; confirmMs?: number }) {
  const tap = new PtyTap({ ringBytes: 64 * 1024 });
  const registry = new SessionRegistry();
  registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  let t = 1_000_000;
  const watcher = wirePtyIdleWatcher({
    tap, registry,
    now: () => t,
    config: {
      windowMs: 1000, bucketMs: 100,
      highBytesPerSec: opts?.highBytesPerSec ?? 50,
      lowBytesPerSec:  opts?.lowBytesPerSec  ?? 5,
      confirmMs:       opts?.confirmMs       ?? 3000,
    },
  });
  return {
    tap, registry, watcher,
    advance(ms: number): void { t += ms; },
    feed(bytes: number): void {
      const buf = Buffer.alloc(Math.max(0, bytes));
      if (bytes > 0) tap.append('s1', buf);
    },
    nowAt(): number { return t; },
  };
}

describe('wirePtyIdleWatcher', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeEach(() => { f = makeFixture(); });

  it('正常 turn 进行 — 持续 high-rate bytes，state 维持 running', () => {
    f.registry.updateState('s1', 'running');
    // Feed 25 bytes every 100ms for 5 seconds → 250 B/s, well above HIGH=50.
    for (let i = 0; i < 50; i++) {
      f.feed(25);
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('running');
  });

  it('ESC 中断 — spinner 停止后约 4s 内 running → idle', () => {
    f.registry.updateState('s1', 'running');
    // 1 秒 spinner 活动 (high rate)
    for (let i = 0; i < 10; i++) {
      f.feed(25);
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('running');
    // 然后停喂，过 4 秒
    for (let i = 0; i < 40; i++) {
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('idle');
  });

  it('低速度 (cursor blink 级) 也算 cooling — confirmMs 后转 idle', () => {
    f.registry.updateState('s1', 'running');
    // 1 秒 high-rate 把 hasBeenActive 标记上
    for (let i = 0; i < 10; i++) {
      f.feed(25);
      f.advance(100);
      f.watcher.tick();
    }
    // 然后只发 cursor blink 节奏 — 每秒 2 字节 (远低于 LOW=5)
    for (let i = 0; i < 50; i++) {  // 5 秒
      f.feed(i % 5 === 0 ? 2 : 0);
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('idle');
  });

  it('state ≠ running 时不动', () => {
    // state 是 starting / idle / done / 等非 running，watcher 不应改 state
    expect(f.registry.get('s1')!.state).toBe('starting');
    for (let i = 0; i < 50; i++) {
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('starting');

    f.registry.updateState('s1', 'idle');
    for (let i = 0; i < 50; i++) {
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('idle');
  });

  it('cleanup — session-removed 后停止订阅，stop() 清理 interval', () => {
    // 创建第二个 session 看也被 attach
    f.registry.register({ id: 's2', name: 'n2', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/y' });
    f.registry.updateState('s2', 'running');
    f.feed(25);  // s1 only — s2 should be subscribed via session-added but no bytes yet
    f.tap.append('s2', Buffer.alloc(25));
    f.advance(100);
    f.watcher.tick();
    // unregister s1
    f.registry.unregister('s1');
    // s1 被移除后再继续喂 byte（理论上 ring 还在 — 只验证 watcher 没崩）
    f.tap.append('s1', Buffer.alloc(100));
    f.advance(100);
    f.watcher.tick();
    expect(f.registry.get('s1')).toBeUndefined();
    // s2 仍受监控
    expect(f.registry.get('s2')!.state).toBe('running');
    f.watcher.stop();
    // stop 后再 advance 不会改 state
    f.advance(10000);
    expect(f.registry.get('s2')!.state).toBe('running');
  });

  it('cooling 中途有活动 → 重置 cooling，不会误判 idle', () => {
    f.registry.updateState('s1', 'running');
    // 1s 喂高速
    for (let i = 0; i < 10; i++) {
      f.feed(25);
      f.advance(100);
      f.watcher.tick();
    }
    // 0.5s 无 byte（不够 window 排空，rate 还高）
    for (let i = 0; i < 5; i++) {
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('running');
    // 又来 1s 高速 → spinner 恢复
    for (let i = 0; i < 10; i++) {
      f.feed(25);
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('running');
    // 真停喂；window 需要 ~1s 排空到 LOW 之下，再 confirmMs=3s 确认
    // 总共需要至少 4s 才会 idle
    for (let i = 0; i < 40; i++) {  // 4s
      f.advance(100);
      f.watcher.tick();
    }
    expect(f.registry.get('s1')!.state).toBe('idle');
  });
});
