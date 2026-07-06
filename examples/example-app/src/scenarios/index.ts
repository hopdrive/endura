import { ParityScenario } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { selfTest } from './selftest';
import { photoParity } from './photoParity';
import { outcomeDraftSync } from './outcomeDraftSync';
import { outcomeSubmit } from './outcomeSubmit';
import { moveSyncPermanentFailure } from './moveSyncPermanentFailure';
import { recoveryAgeGate } from './recoveryAgeGate';
import { nonRecoverablePipeline } from './nonRecoverablePipeline';
import { offerBundleDedupe } from './offerBundleDedupe';
import { offlineHoldResume } from './offlineHoldResume';
import { offlineMidStage } from './offlineMidStage';
import { foregroundBackgroundCollision } from './foregroundBackgroundCollision';
import { staleResults } from './staleResults';
import { upgradePendingWork } from './upgradePendingWork';
import { runScopedRecovery } from './runScopedRecovery';
import { backlogPriority } from './backlogPriority';

/**
 * Scenario registry. Parity scenarios (categories 1-14 from the review)
 * are added here as they are implemented; the harness renders whatever
 * is registered.
 */
export const scenarios: ParityScenario<ParityClient>[] = [
  selfTest,
  photoParity,
  outcomeDraftSync,
  outcomeSubmit,
  moveSyncPermanentFailure,
  recoveryAgeGate,
  nonRecoverablePipeline,
  offerBundleDedupe,
  offlineHoldResume,
  offlineMidStage,
  foregroundBackgroundCollision,
  staleResults,
  upgradePendingWork,
  runScopedRecovery,
  backlogPriority,
];
