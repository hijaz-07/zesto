import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIntersectionObserver } from '../test/fakeIntersectionObserver';
import { useOnBecameVisible } from './useOnBecameVisible';

function render(onVisible: () => void) {
  const element = document.createElement('div');
  const ref = { current: element };
  const hook = renderHook(({ callback }) => useOnBecameVisible(ref, callback), {
    initialProps: { callback: onVisible },
  });
  const [observer] = FakeIntersectionObserver.live();
  return { element, ref, observer, ...hook };
}

describe('useOnBecameVisible', () => {
  beforeEach(() => {
    FakeIntersectionObserver.install();
  });

  afterEach(() => {
    FakeIntersectionObserver.uninstall();
  });

  it('observes the referenced element', () => {
    const { element, observer } = render(vi.fn());

    expect(observer.observed).toEqual([element]);
  });

  it('does not fire for the first report: a page that is visible when it mounts is not "becoming" visible', () => {
    const onVisible = vi.fn();
    const { observer } = render(onVisible);

    act(() => observer.emit(true));

    expect(onVisible).not.toHaveBeenCalled();
  });

  it('fires when the element goes from hidden back to visible', () => {
    const onVisible = vi.fn();
    const { observer } = render(onVisible);

    act(() => observer.emit(true));
    act(() => observer.emit(false));
    expect(onVisible).not.toHaveBeenCalled();
    act(() => observer.emit(true));

    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('fires once per return, however many times the user switches away and back', () => {
    const onVisible = vi.fn();
    const { observer } = render(onVisible);

    act(() => observer.emit(true));
    for (let i = 0; i < 3; i++) {
      act(() => observer.emit(false));
      act(() => observer.emit(true));
    }

    expect(onVisible).toHaveBeenCalledTimes(3);
  });

  it('does not fire again for a repeated "visible" report', () => {
    const onVisible = vi.fn();
    const { observer } = render(onVisible);

    act(() => observer.emit(true));
    act(() => observer.emit(false));
    act(() => observer.emit(true));
    act(() => observer.emit(true));

    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('fires if the element first reports hidden and is then shown (it mounted off-screen)', () => {
    const onVisible = vi.fn();
    const { observer } = render(onVisible);

    act(() => observer.emit(false));
    act(() => observer.emit(true));

    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('calls the latest callback, without re-creating the observer when it changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { observer, rerender } = render(first);
    act(() => observer.emit(true));
    act(() => observer.emit(false));

    rerender({ callback: second });
    act(() => observer.emit(true));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it('disconnects its observer on unmount', () => {
    const { observer, unmount } = render(vi.fn());

    unmount();

    expect(observer.disconnected).toBe(true);
  });

  it('does nothing, and does not throw, where IntersectionObserver does not exist', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('IntersectionObserver', undefined);
    const onVisible = vi.fn();

    expect(() => renderHook(() => useOnBecameVisible({ current: document.createElement('div') }, onVisible))).not.toThrow();
    expect(onVisible).not.toHaveBeenCalled();
  });

  it('does nothing when the ref is empty', () => {
    renderHook(() => useOnBecameVisible({ current: null }, vi.fn()));

    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });
});
