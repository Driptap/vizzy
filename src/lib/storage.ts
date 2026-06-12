// localStorage with the pre-rebrand (promptvj.*) keys as a read fallback, so
// settings survive the rename; writes always use the current prefix.
const PREFIX = 'vizzy.';
const LEGACY_PREFIX = 'promptvj.';

export const getStored = (key: string): string | null =>
  localStorage.getItem(PREFIX + key) ?? localStorage.getItem(LEGACY_PREFIX + key);

export const setStored = (key: string, value: string): void =>
  localStorage.setItem(PREFIX + key, value);
