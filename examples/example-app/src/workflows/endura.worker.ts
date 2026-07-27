/**
 * The worker entry file — react-native-workers bundles this (and
 * everything it imports) into a separate Metro bundle that runs on its
 * own thread with its own Hermes runtime.
 *
 * Its only job: give the activity host the same workflow definitions
 * the main bundle registers with the client.
 */

import { createActivityHost } from 'endura/workers';
import { demoWorkflows } from './demoWorkflows';

createActivityHost({ workflows: demoWorkflows.map(entry => entry.workflow) });
