const { readFile: readFileCallback } = require('fs');
const promiseCallback = require('promise-callback-factory').default;
const babel = require('babel-core');

const copyChmod = require('../utils/copyChmod');
const copyFile = require('../utils/copyFile');
const writeFile = require('../utils/writeFile');
const createOptionManagers = require('../babel/option-managers');

const readFile = filepath => promiseCallback(done => readFileCallback(filepath, done));

const envs = process.argv[3].split(',');
const optsManagers = createOptionManagers(envs, cwd, pobrc)

process.on('message', ({ src, relative }) => {
  if (babel.util.canCompile(relative)) {
    return Promise.resolve(src)
      .then(src => readFile(src))
      .then(content => (
        Promise.all(envs.map((env) => {
          const dest = path.join(outFn(env), destFromSrc(relative));

          const opts = optsManagers[env].init({ filename: relative });
          opts.babelrc = false;
          opts.sourceMap = true;
          opts.sourceFileName = slash(path.relative(dest + "/..", src));
          opts.sourceMapTarget = path.basename(relative);

          return Promise.resolve(content)
            .then(content => babel.transform(content, opts))
            .catch(watch && (err => {
                console.log(toErrorStack(err));

                return { map: null, code: 'throw new Error("Syntax Error");' };
              }))
            .then(data => {
              const mapLoc = dest + ".map";
              data.code = data.code + "\n//# sourceMappingURL=" + path.basename(mapLoc);
              return writeFile(dest, data.code)
                .then(() => Promise.all([
                  copyChmod(src, dest),
                  writeFile(mapLoc, JSON.stringify(data.map)),
                ]));
            });
        }))
      ));
  } else {
    const extension = path.extname(relative).substr(1);
    const plugin = plugins.findByExtension(extension);
    if (plugin) {
      const subtask = task.subtask(plugin.extension + ': ' + relative);
      logger.debug(plugin.extension + ': ' + relative);
      const destRelative = destFromSrc(relative, plugin);
      return Promise.resolve(src)
        .then(src => readFile(src))
        .then(content => plugin.transform(content, { src, relative }))
        .catch(watch && (err => {
            console.log(toErrorStack(err));

            return { map: null, code: 'throw new Error("Syntax Error");' };
          }))
        .then(({ code, map }) => Promise.all(envs.map(env => {
          const dest = path.join(outFn(env), destRelative);
          const mapLoc = dest + ".map";
          return writeFile(dest, code)
            .then(() => Promise.all([
              copyChmod(src, dest),
              map && writeFile(mapLoc, JSON.stringify(map)),
            ]));
        })))
        .then(() => release(), err => { release(); throw err; })
        .then(() => subtask.done(), err => { subtask.done(); throw err; });
    } else {
      const subtask = task.subtask('copy: ' + relative);
      logger.debug('copy: ' + relative);
      return Promise.all(envs.map(env => {
        const out = outFn(env);
        const dest = path.join(out, relative);
        return copyFile(src, dest).then(() => copyChmod(src, dest));
      }))
        .then(() => release(), err => { release(); throw err; })
        .then(() => subtask.done(), err => { subtask.done(); throw err; });
    }
  }
});
