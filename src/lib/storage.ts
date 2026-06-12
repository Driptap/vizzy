const PREFIX = 'vizzy.';

export const getStored = (key: string): string | null =>
  localStorage.getItem(PREFIX + key);

export const setStored = (key: string, value: string): void =>
  localStorage.setItem(PREFIX + key, value);
