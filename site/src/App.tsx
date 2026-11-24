import { CloudFooter } from "./components/CloudFooter";
import { CompareSection } from "./components/CompareSection";
import { FeatureBento } from "./components/FeatureBento";
import { Hero } from "./components/Hero";
import { Navbar } from "./components/Navbar";
import { SelfHostSection } from "./components/SelfHostSection";
import { WalkthroughSection } from "./components/WalkthroughSection";

export function App() {
  return (
    <div className="min-h-[100dvh] bg-[var(--bg)] text-[var(--ink)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-[var(--accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to content
      </a>

      <Navbar />

      <main id="main-content">
        <Hero />
        <WalkthroughSection />
        <FeatureBento />
        <SelfHostSection />
        <CompareSection />
      </main>

      <CloudFooter />
    </div>
  );
}
