import type { HTMLAttributes, ReactNode } from 'react'

export function Card({ children, className = '', ...props }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section {...props} className={`rounded-2xl border border-white/[0.08] bg-slate-900/65 shadow-[0_18px_55px_-32px_rgba(0,0,0,0.9)] backdrop-blur-xl ${className}`}>
      {children}
    </section>
  )
}