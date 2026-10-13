import { useState, useEffect } from 'react';
import { ConnectionStatus, useSSEConnection } from '../lib/apiClient';

interface ConnectionIndicatorProps {
  /** Custom className for positioning */
  className?: string;
  /** Show label text */
  showLabel?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_STYLES: Record<'sm' | 'md' | 'lg', { dot: string; label: string; pulse: string }> = {
  sm: { dot: 'h-2 w-2', label: 'text-[10px]', pulse: 'h-2 w-2' },
  md: { dot: 'h-2.5 w-2.5', label: 'text-xs', pulse: 'h-2.5 w-2.5' },
  lg: { dot: 'h-3 w-3', label: 'text-sm', pulse: 'h-3 w-3' },
};

export function ConnectionIndicator({ className = '', showLabel = true, size = 'md' }: ConnectionIndicatorProps) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.Disconnected);

  useEffect(() => {
    const { close } = useSSEConnection(
      () => {}, // onMessage - we don't need to handle messages here
      setStatus
    );
    return close;
  }, []);

  const styles = SIZE_STYLES[size];

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="relative flex">
        <span
          className={`animate-ping absolute inline-flex rounded-full opacity-75 ${styles.pulse} ${
            status === ConnectionStatus.Connected ? 'bg-emerald-400' :
            status === ConnectionStatus.Reconnecting ? 'bg-amber-400' :
            'bg-rose-400'
          }`}
        />
        <span
          className={`relative inline-flex rounded-full ${styles.dot} ${
            status === ConnectionStatus.Connected ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]' :
            status === ConnectionStatus.Reconnecting ? 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.8)]' :
            'bg-rose-500'
          }`}
        />
      </span>
      {showLabel && (
        <span className={`font-mono font-semibold ${styles.label} ${
          status === ConnectionStatus.Connected ? 'text-emerald-300' :
          status === ConnectionStatus.Reconnecting ? 'text-amber-300' :
          'text-rose-300'
        }`}>
          {status === ConnectionStatus.Connected ? 'Live' :
           status === ConnectionStatus.Reconnecting ? 'Reconnecting...' :
           'Offline'}
        </span>
      )}
    </div>
  );
}

/**
 * Compact connection dot only - for use in headers where space is limited
 */
export function ConnectionDot({ className = '', size = 'sm' }: { className?: string; size?: 'sm' | 'md' }) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.Disconnected);

  useEffect(() => {
    const { close } = useSSEConnection(() => {}, setStatus);
    return close;
  }, []);

  const dotSize = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  const pulseSize = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';

  return (
    <span className={`relative inline-flex ${className}`}>
      <span
        className={`animate-ping absolute inline-flex rounded-full opacity-75 ${pulseSize} ${
          status === ConnectionStatus.Connected ? 'bg-emerald-400' :
          status === ConnectionStatus.Reconnecting ? 'bg-amber-400' :
          'bg-rose-400'
        }`}
      />
      <span
        className={`relative inline-flex rounded-full ${dotSize} ${
          status === ConnectionStatus.Connected ? 'bg-emerald-500' :
          status === ConnectionStatus.Reconnecting ? 'bg-amber-500' :
          'bg-rose-500'
        }`}
      />
    </span>
  );
}