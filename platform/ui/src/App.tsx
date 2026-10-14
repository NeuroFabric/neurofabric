import { useState, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Toaster } from 'sonner';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPolicyPage, TermsPage } from './pages/LegalPages';
import { NotFoundPage } from './pages/NotFoundPage';
import { SecurityPosturePage } from './pages/SecurityPosturePage';
import { AccessManagementPage } from './pages/AccessManagementPage';
import { Sidebar } from './components/navigation/Sidebar';
import { Topbar } from './components/navigation/Topbar';
import { CommandPalette } from './components/navigation/CommandPalette';
import { CookieConsentBanner } from './components/common/CookieConsentBanner';
import { OverviewPage } from './pages/OverviewPage';
import { StressTestPage } from './pages/StressTestPage';
import { AlertsPage } from './pages/AlertsPage';
import { TelemetryExplorerPage } from './pages/TelemetryExplorerPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { EmbassyPage } from './pages/EmbassyPage';
import { CircuitsPage } from './pages/CircuitsPage';
import { GovernancePage } from './pages/GovernancePage';
import { TopologyPage } from './pages/TopologyPage';
import { SupportPage } from './pages/SupportPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { TelemetryProvider, useTelemetry } from './context/TelemetryContext';
import { ErrorBoundary } from './components/ErrorBoundary';

const pageVariants: any = {
  initial: { opacity: 0, y: 8, filter: 'blur(3px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, filter: 'blur(3px)', transition: { duration: 0.15, ease: 'easeIn' } },
};

// Strict Zero-Trust Route Guard: Requires explicit login completion (isAuthenticated === true)
function RequireAdminAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useTelemetry();
  const location = useLocation();
  if (!isAuthenticated || !user || !user.mfaVerified || !user.emailVerified) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

function AuthenticatedWorkspace() {
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <RequireAdminAuth>
      <div className="flex h-screen bg-[#050609] text-slate-100 overflow-hidden select-none">
        <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <Sidebar mobileOpen={mobileMenuOpen} onCloseMobile={() => setMobileMenuOpen(false)} />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Topbar onOpenMobileMenu={() => setMobileMenuOpen(true)} />
          <main className="flex-1 overflow-y-auto relative bg-[#050609]">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="min-h-full"
              >
                <Routes location={location}>
                  <Route path="/overview" element={<OverviewPage />} />
                  <Route path="/iam" element={<AccessManagementPage />} />
                  <Route path="/security" element={<SecurityPosturePage />} />
                  <Route path="/stress" element={<StressTestPage />} />
                  <Route path="/alerts" element={<AlertsPage />} />
                  <Route path="/telemetry" element={<TelemetryExplorerPage />} />
                  <Route path="/integrations" element={<IntegrationsPage />} />
                  <Route path="/embassy" element={<EmbassyPage />} />
                  <Route path="/circuits" element={<CircuitsPage />} />
                  <Route path="/governance" element={<GovernancePage />} />
                  <Route path="/topology" element={<TopologyPage />} />
                  <Route path="/support" element={<SupportPage />} />
                  <Route path="/roadmap" element={<RoadmapPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </RequireAdminAuth>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <TelemetryProvider>
        <Toaster theme="dark" position="bottom-right" richColors />
        <BrowserRouter>
          <CookieConsentBanner />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/*" element={<AuthenticatedWorkspace />} />
          </Routes>
        </BrowserRouter>
      </TelemetryProvider>
    </ErrorBoundary>
  );
}
