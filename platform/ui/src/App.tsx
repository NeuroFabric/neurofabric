import { useState } from 'react';
import { LandingPage } from './pages/LandingPage';
import { Sidebar, type PageId } from './components/navigation/Sidebar';
import { OverviewPage } from './pages/OverviewPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { EmbassyPage } from './pages/EmbassyPage';
import { GovernancePage } from './pages/GovernancePage';
import { TopologyPage } from './pages/TopologyPage';
import { TelemetryProvider } from './context/TelemetryContext';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  const [inConsole, setInConsole] = useState(false);
  const [currentPage, setCurrentPage] = useState<PageId>('overview');

  if (!inConsole) {
    return <LandingPage onEnter={() => setInConsole(true)} />;
  }

  return (
    <ErrorBoundary>
      <TelemetryProvider>
        <div className="flex h-screen bg-[#07090e] text-slate-100 overflow-hidden select-none">
          <Sidebar
            currentPage={currentPage}
            onNavigate={setCurrentPage}
            onExit={() => setInConsole(false)}
          />
          <main className="flex-1 min-w-0 overflow-y-auto">
            {currentPage === 'overview' && <OverviewPage />}
            {currentPage === 'telemetry' && <TelemetryPage />}
            {currentPage === 'embassy' && <EmbassyPage />}
            {currentPage === 'governance' && <GovernancePage />}
            {currentPage === 'topology' && <TopologyPage />}
          </main>
        </div>
      </TelemetryProvider>
    </ErrorBoundary>
  );
}
