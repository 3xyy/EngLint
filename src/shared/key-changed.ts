import { storage } from 'wxt/utils/storage';

/**
 * When the API key was last saved or removed (a time, never the key): extension pages watch it to refresh
 * their key status. Not in settings.ts: content scripts import that, and defining an item reads it at once,
 * which storage.session refuses outside extension pages.
 */
export const keyChangedItem = storage.defineItem<number>('session:keyChangedAt', { fallback: 0 });
