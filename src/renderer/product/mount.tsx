import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient as ReactQueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OnboardingProvider } from '../onboarding/OnboardingContext'
import { SetupProvider } from '../setup/SetupContext'
import { ErrorBoundary } from '../debug/RenderDebug'
import { ProductApp } from './ProductApp'
import { installLagProbe, onReactRender } from '../debug/lagProbe'

const queryClient = new ReactQueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
})

export function mount(): void {
  void installLagProbe()
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <OnboardingProvider>
          <SetupProvider>
            <Profiler id="app" onRender={onReactRender}>
              <ProductApp />
            </Profiler>
          </SetupProvider>
        </OnboardingProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  )
}
