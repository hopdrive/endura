const { getDefaultConfig } = require('expo/metro-config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

// withWorkers teaches Metro to serve/build the separate worker bundles
// that the babel plugin's `new Worker('./path')` rewrites point at.
module.exports = withWorkers(getDefaultConfig(__dirname));
