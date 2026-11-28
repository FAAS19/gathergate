import { useEffect, useState } from "react";
import { CloudFooter } from "./components/CloudFooter";
import { CompareSection } from "./components/CompareSection";
import { FeatureBento } from "./components/FeatureBento";
import { Hero } from "./components/Hero";
import { Navbar } from "./components/Navbar";
import { ProductFilmSection } from "./components/ProductFilmSection";
import { SelfHostSection } from "./components/SelfHostSection";
import { WalkthroughSection } from "./components/WalkthroughSection";

const THEME_STORAGE_KEY = "gathergate-site-theme";

export function App() {
  // Initialise false so SSR and initial hydration pass match before syncing pre-paint .dark class.
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleTheme() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // Ignore storage errors in restricted contexts.
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg)] text-[var(--ink)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-[var(--accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--accent-ink)]"
      >
        Skip to content
      </a>

      <Navbar isDark={isDark} onToggleTheme={toggleTheme} />

      <main id="main-content">
        <Hero isDark={isDark} />
        <ProductFilmSection />
        <WalkthroughSection isDark={isDark} />
        <FeatureBento />
        <SelfHostSection />
        <CompareSection />
      </main>

      <CloudFooter />
    </div>
  );
}
