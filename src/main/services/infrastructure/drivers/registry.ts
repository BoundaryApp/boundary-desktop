import type { DriverKind } from '../../../../shared/types/infrastructure';
import type { InferenceProviderDriver } from './types';
import { basetenTrussDriver } from './BasetenTrussDriver';
import { cerebriumApiDriver } from './CerebriumApiDriver';
import { runpodTerraformDriver } from './RunpodTerraformDriver';

const defaultDrivers: InferenceProviderDriver[] = [
  runpodTerraformDriver,
  basetenTrussDriver,
  cerebriumApiDriver,
];

let activeDrivers: InferenceProviderDriver[] = [...defaultDrivers];

export function registerDriver(driver: InferenceProviderDriver): void {
  activeDrivers = activeDrivers.filter((d) => d.kind !== driver.kind);
  activeDrivers.push(driver);
}

export function getDriver(kind: DriverKind): InferenceProviderDriver {
  const driver = activeDrivers.find((d) => d.kind === kind);
  if (!driver) {
    throw new Error(`No driver registered for kind: ${kind}`);
  }
  return driver;
}

export function getDriverForRecipe(recipe: { driver: { kind: DriverKind } }): InferenceProviderDriver {
  return getDriver(recipe.driver.kind);
}

export function resetDriversForTests(): void {
  activeDrivers = [...defaultDrivers];
}

export function setDriversForTests(drivers: InferenceProviderDriver[]): void {
  activeDrivers = drivers;
}

export function listDrivers(): InferenceProviderDriver[] {
  return [...activeDrivers];
}
