import { ReactFlow, Background, BackgroundVariant, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTelemetry } from '../context/TelemetryContext';

export function TopologyPage() {
  const { trippedCircuits } = useTelemetry();

  const isTripped = (name: string) => trippedCircuits.includes(name);

  const nodes = [
    {
      id: 'k8s-ingress',
      position: { x: 50, y: 140 },
      data: { label: 'k8s-ingress (14ms)' },
      style: { background: '#0d121d', color: '#38bdf8', border: '1px solid #0284c7', borderRadius: '12px', padding: '12px', fontFamily: 'monospace', fontWeight: 'bold' },
    },
    {
      id: 'auth-gateway',
      position: { x: 300, y: 60 },
      data: { label: 'auth-gateway [DLP ENFORCED]' },
      style: {
        background: '#0d121d',
        color: isTripped('auth-gateway') ? '#fb7185' : '#34d399',
        border: `1px solid ${isTripped('auth-gateway') ? '#e11d48' : '#059669'}`,
        borderRadius: '12px',
        padding: '12px',
        fontFamily: 'monospace',
        fontWeight: 'bold',
      },
    },
    {
      id: 'billing-core',
      position: { x: 300, y: 220 },
      data: { label: 'billing-core (42ms)' },
      style: { background: '#0d121d', color: '#a78bfa', border: '1px solid #7c3aed', borderRadius: '12px', padding: '12px', fontFamily: 'monospace', fontWeight: 'bold' },
    },
    {
      id: 'flapping-payment-worker',
      position: { x: 580, y: 220 },
      data: { label: 'flapping-payment-worker' },
      style: {
        background: '#0d121d',
        color: isTripped('flapping-payment-worker') ? '#fb7185' : '#f59e0b',
        border: `1px solid ${isTripped('flapping-payment-worker') ? '#e11d48' : '#d97706'}`,
        borderRadius: '12px',
        padding: '12px',
        fontFamily: 'monospace',
        fontWeight: 'bold',
      },
    },
  ];

  const edges = [
    { id: 'e1-2', source: 'k8s-ingress', target: 'auth-gateway', animated: true, style: { stroke: '#0284c7' } },
    { id: 'e1-3', source: 'k8s-ingress', target: 'billing-core', animated: true, style: { stroke: '#7c3aed' } },
    {
      id: 'e3-4',
      source: 'billing-core',
      target: 'flapping-payment-worker',
      animated: !isTripped('flapping-payment-worker'),
      style: { stroke: isTripped('flapping-payment-worker') ? '#e11d48' : '#d97706' },
    },
  ];

  return (
    <div className="h-full w-full flex flex-col p-8 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Cluster Topology Mesh</h1>
        <p className="text-xs text-slate-400 mt-1">Interactive DAG cluster map with real-time circuit breaker status</p>
      </div>

      <div className="flex-1 w-full rounded-2xl bg-[#0d121d] border border-slate-800 overflow-hidden relative min-h-[520px]">
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background color="#1e293b" variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls className="bg-slate-900 border border-slate-700 text-white fill-white rounded-lg" />
        </ReactFlow>
      </div>
    </div>
  );
}
