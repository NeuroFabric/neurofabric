import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Toaster } from 'sonner';
import { LandingPage } from './pages/LandingPage';
import { Sidebar, type PageId } from './components/navigation/Sidebar';
import { OverviewPage } from './pages/OverviewPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { EmbassyPage } from './pages/EmbassyPage';
import { GovernancePage } from './pages/GovernancePage';
import { TopologyPage } from './pages/TopologyPage';
import { SupportPage } from './pages/SupportPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { TelemetryProvider } from './context/TelemetryContext';
import { ErrorBoundary } from './components/ErrorBoundary';

const pageVariants: any = {
  initial: { opacity: 0, y: 10, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.25, ease: 'easeOut' } },
  exit: { opacity: 0, y: -10, filter: 'blur(4px)', transition: { duration: 0.15, ease: 'easeIn' } },
};

export default function App() {
  const [inConsole, setInConsole] = useState(false);
  const [currentPage, setCurrentPage] = useState<PageId>('overview');

  if (!inConsole) {
    return <LandingPage onEnter={() => setInConsole(true)} />;
  }

  return (
    <ErrorBoundary>
      <TelemetryProvider>
        <Toaster theme="dark" position="bottom-right" richColors />
        <div className="flex h-screen bg-[#07090e] text-slate-100 overflow-hidden select-none">
          <Sidebar
            currentPage={currentPage}
            onNavigate={setCurrentPage}
            onExit={() => setInConsole(false)}
          />
          <main className="flex-1 min-w-0 overflow-y-auto relative bg-[#07090e]">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentPage}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="min-h-full"
              >
                {currentPage === 'overview' && <OverviewPage />}
                {currentPage === 'telemetry' && <TelemetryPage />}
                {currentPage === 'embassy' && <EmbassyPage />}
                {currentPage === 'governance' && <GovernancePage />}
                {currentPage === 'topology' && <TopologyPage />}
                {currentPage === 'support' && <SupportPage />}
                {currentPage === 'roadmap' && <RoadmapPage />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </TelemetryProvider>
    </ErrorBoundary>
  );
}
