import { useEffect, useState } from 'react';
import type { WxtStorageItem } from 'wxt/utils/storage';

/** A settings item's value, live; null until the first read. */
export function useSetting<T>(item: WxtStorageItem<T, any>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    void item.getValue().then((v) => live && setValue(v));
    const unwatch = item.watch((v) => live && setValue(v));
    return () => {
      live = false;
      unwatch();
    };
  }, [item]);
  return value;
}
