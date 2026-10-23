import '@fontsource-variable/ibm-plex-sans/wght.css'
import '@fontsource-variable/ibm-plex-sans/wght-italic.css'
import '@fontsource/ibm-plex-serif/latin-400.css'
import '@fontsource/ibm-plex-serif/latin-400-italic.css'
import '@fontsource/ibm-plex-serif/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-400-italic.css'
import '../index.css'
import { initTheme } from './theme'

// Product chrome uses inset macOS traffic lights; CSS reserves room for them.
if (navigator.userAgent.includes('Macintosh')) {
  document.documentElement.dataset.platform = 'darwin'
}

initTheme()

void import('./product/mount').then((m) => m.mount())
