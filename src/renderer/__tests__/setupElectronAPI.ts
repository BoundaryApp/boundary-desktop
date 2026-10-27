import { afterEach } from 'vitest';
import { installElectronAPI } from './electronApiFake';
import { resetIpcStoresForTests } from '../lib/ipcStore';

// The app's windows always have the preload bridge, so every renderer test file starts with one.
installElectronAPI();

// Module stores outlive a test; start each test from their initial values.
afterEach(resetIpcStoresForTests);
