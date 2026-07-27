module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Rewrites `new Worker('./path')` calls so each worker entry file
    // becomes its own Metro bundle running on its own thread.
    plugins: ['@ammarahmed/react-native-workers/babel'],
  };
};
