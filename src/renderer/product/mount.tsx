import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { SetupProvider } from '../setup/SetupContext'
import { ErrorBoundary } from '../debug/RenderDebug'
import { ProductApp } from './ProductApp'
import { installLagProbe, onReactRender } from '../debug/lagProbe'

export function mount(): void {
  void installLagProbe()
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <SetupProvider>
        <Profiler id="app" onRender={onReactRender}>
          <ProductApp />
        </Profiler>
      </SetupProvider>
    </ErrorBoundary>,
  )
}
