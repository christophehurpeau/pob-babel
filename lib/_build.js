const { execSync } = require('child_process');
const path = require('path');
const { stat, unlink } = require('fs');
const chokidar = require('chokidar');
const glob = require('glob');
const readdir = require('fs-readdir-recursive');
const slash = require('slash');
const createLock = require('lock');
const Queue = require('promise-queue');
const promiseCallback = require('promise-callback-factory').default;
const destFromSrc = require('./utils/destFromSrc');
const plugins = require('./plugins');
const Pool = require('./worker-pool');
const { logger: parentLogger } = require('./logger');
const Task = require('./cli-spinner');


const queue = new Queue(40, Infinity);

function toErrorStack(err) {
  if (err._babel && err instanceof SyntaxError) {
    return `${err.name}: ${err.message}\n${err.codeFrame}`;
  } else {
    return err.stack;
  }
}

module.exports = function transpile(pobrc, cwd, src, outFn, envs, watch) {
  const srcFiles = glob.sync(src, { cwd });
  const _lock = createLock();
  const lock = resource => new Promise(resolve => (
    _lock(resource, release => resolve(() => release()()))
  ));
  let task = new Task(`build ${src}`);
  const pool = new Pool([envs.join(',')]);

  let logger = parentLogger.child('build', 'build');
  const watchLogger = parentLogger.child('watch', 'watch');
  let watching = false;

  const timeBuildStarted = Date.now();// logger.infoTime('building ' + src);
  logger.debug('envs', { envs });

  function handle(filename) {
    return promiseCallback(done => stat(filename, done))
      .catch((err) => {
        console.log(err);
        process.exit(1);
      })
      .then((stat) => {
        if (stat.isDirectory(filename)) {
          let dirname = filename;

          const allSrcFiles = readdir(dirname);
          const allAllowedDestFiles = allSrcFiles.map(relative => destFromSrc(relative));

          envs.forEach((env) => {
            const out = outFn(env);
            const envAllFiles = readdir(out);

            const diff = envAllFiles.filter(path => !allAllowedDestFiles.includes(path.replace(/.map$/, '')));
            if (diff.length) {
              logger.debug(`${out}: removing: ${diff.join(',')}`);
              execSync(`rm -Rf ${diff.map(filename => path.join(out, filename)).join(' ')}`);
            }
          });

          return Promise.all(allSrcFiles.map((filename) => {
            let src = path.join(dirname, filename);
            return handleFile(src, filename);
          }));
        } else {
        }
      });
  }

  function handleFile(src, relative) {
    if (_lock.isLocked(relative)) logger.debug(`${relative} locked, waiting...`);
    return lock(relative).then((release) => {
      return queue.add(() => {
        const subtask = task.subtask(`handling: ${relative}`);
        logger.debug(`handling: ${relative}`);

        pool.add({ src, relative })
          .then(() => {
            logger[watching ? 'success' : 'debug'](`handled: ${relative}`);
          })
          .then(() => release(), (err) => { release(); throw err; })
          .then(() => subtask.done(), (err) => { subtask.done(); throw err; });
      });
    }).catch((err) => {
      console.log(toErrorStack(err));
      if (!watch) {
        process.exit(1);
      }
    });
  }

  if (watch) {
    process.nextTick(() => {
      srcFiles.forEach(dirname => {
        const watcher = chokidar.watch(dirname, {
          persistent: true,
          ignoreInitial: true
        });

        function handleChange(filename) {
          let relative = path.relative(dirname, filename) || filename;
          watchLogger.debug('changed: ' + relative);
          task.subtask('changed: ' + relative);
          handleFile(filename, relative)
            .catch(err => {
              console.log(err.stack);
            })
            .then(() => watch.emit('changed', filename));
        }

        watcher.on('add', handleChange);
        watcher.on('change', handleChange);
        watcher.on('unlink', filename => {
          let relative = path.relative(dirname, filename) || filename;
          watchLogger.debug('unlink: ' + relative);
          const subtask = task.subtask('delete: ' + relative);
          if (_lock.isLocked(relative)) watchLogger.debug(relative + ' locked, waiting...');
          lock(relative).then(release => {
            return Promise.all(envs.map(env => {
              const dest = path.join(outFn(env), destFromSrc(relative));

              return Promise.all([
                promiseCallback(done => unlink(dest, done)).catch(() => {}),
                promiseCallback(done => unlink(`${dest}.map`, done)).catch(() => {}),
              ]);
            }))
              .then(() => release())
              .then(() => watch.emit('changed', filename))
              .then(() => subtask.done());
          });
        });
      });
    });
  }

  return Promise.all(srcFiles.map(filename => handle(filename)))
    .then(() => {
      logger.infoSuccessTimeEnd(timeBuildStarted, 'build finished');
      task.succeed();
      if (watch) {
        task = new Task('watch');
        logger.info('watching');
        watching = true;
        logger = watchLogger;
      }
    })
    .catch(err => {
      console.log(err.stack);
      process.exit(1);
    });
};
