"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export const THEME_COOKIE = "reddone-theme";
export const THEME_STORAGE_KEY = "reddone-theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeToSystemTheme(callback: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function getSystemThemeSnapshot() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolvedTheme = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolvedTheme;
  return resolvedTheme;
}

export function ThemeProvider({
  children,
  initialPreference = "system",
}: {
  children: ReactNode;
  initialPreference?: ThemePreference;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const systemIsDark = useSyncExternalStore(subscribeToSystemTheme, getSystemThemeSnapshot, () => false);
  const resolvedTheme: ResolvedTheme = preference === "system" ? (systemIsDark ? "dark" : "light") : preference;

  const persistPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    applyTheme(nextPreference);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    document.cookie = `${THEME_COOKIE}=${nextPreference}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  useEffect(() => {
    if (preference === "system") applyTheme("system");
  }, [preference, systemIsDark]);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference: persistPreference }),
    [persistPreference, preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider.");
  return context;
}

const themeOptions = [
  { value: "system" as const, label: "System", icon: Monitor },
  { value: "light" as const, label: "Light", icon: Sun },
  { value: "dark" as const, label: "Dark", icon: Moon },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();

  return (
    <div className={`theme-toggle ${compact ? "is-compact" : ""}`} role="group" aria-label="Color theme">
      {themeOptions.map((option) => {
        const ThemeIcon = option.icon;
        return (
          <button
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            aria-pressed={preference === option.value}
            className={preference === option.value ? "is-active" : ""}
            key={option.value}
            onClick={() => setPreference(option.value)}
            type="button"
          >
            <ThemeIcon aria-hidden="true" size={16} strokeWidth={1.9} />
            {!compact && <span>{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
