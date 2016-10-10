const babel = require('babel-core');
const options = require('./options');

module.exports = (envs, cwd, pobrc) => {
  const optsManagers = {};

  envs.forEach((env) => {
    const optsManager = new babel.OptionManager();

    optsManager.mergeOptions({
      options: options(env, pobrc.react),
      alias: 'base',
      loc: cwd,
    });

    optsManagers[env] = optsManager;
  });

  return optsManagers;
};
