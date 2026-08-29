/**
 * Worker execution boundary.
 *
 * Main bundle: hand ExpoWorkflowClient a Worker; it builds a
 * WorkerDispatcher around it.
 *
 * Worker bundle: call createActivityHost with the same workflow
 * definitions the main bundle registers.
 */

export {
  SerializedActivityError,
  HostboundMessage,
  EngineboundMessage,
  WorkerLike,
  WorkerScope,
  serializeActivityError,
  deserializeActivityError,
  sanitizeRuntimeContext,
  isEnduraMessage,
} from './protocol';

export { WorkerDispatcher, WorkerCrashedError } from './WorkerDispatcher';

export {
  ActivityHost,
  ActivityHostOptions,
  ActivityNotInWorkerBundleError,
  createActivityHost,
} from './host';

export {
  LoopbackChannel,
  LoopbackDispatcher,
  createLoopbackChannel,
  createLoopbackDispatcher,
} from './loopback';
