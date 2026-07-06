import { ParityScenario } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { selfTest } from './selftest';

/**
 * Scenario registry. Parity scenarios (categories 1-14 from the review)
 * are added here as they are implemented; the harness renders whatever
 * is registered.
 */
export const scenarios: ParityScenario<ParityClient>[] = [selfTest];
