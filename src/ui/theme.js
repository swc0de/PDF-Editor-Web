// Light/dark theme. First run follows prefers-color-scheme; an explicit
// choice is remembered. (index.html applies the saved theme before the app
// loads, so there is no flash.)
import { getPref, setPref, removePref } from '../core/prefs.js';

const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function systemTheme() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function initTheme() {
  applyTheme(getPref('theme') ?? systemTheme());
  // Follow the OS only while the user hasn't chosen.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getPref('theme')) applyTheme(systemTheme());
  });
}

export function setTheme(theme) {
  setPref('theme', theme);
  applyTheme(theme);
}

/** 'system' | 'light' | 'dark' */
export function themePreference() {
  return getPref('theme') ?? 'system';
}

export function setThemePreference(pref) {
  if (pref === 'system') {
    removePref('theme');
    applyTheme(systemTheme());
  } else {
    setTheme(pref);
  }
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  for (const fn of listeners) fn(theme);
}
