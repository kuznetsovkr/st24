export type FontTheme = 'default' | 'franklin';

const STORAGE_KEY = 'site-font-theme';

export const getStoredFontTheme = (): FontTheme => {
  if (typeof window === 'undefined') {
    return 'default';
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'franklin' ? 'franklin' : 'default';
};

export const applyFontTheme = (theme: FontTheme) => {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.font = theme === 'franklin' ? 'franklin' : 'default';
};

export const setStoredFontTheme = (theme: FontTheme) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, theme);
};

export const initFontTheme = () => {
  const theme = getStoredFontTheme();
  applyFontTheme(theme);
  return theme;
};
