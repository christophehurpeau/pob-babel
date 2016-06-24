const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;
const babel = require('babel-core');
const chokidar = require('chokidar');
const glob = require('glob');
const readdir = require('fs-readdir-recursive');
const slash = require('slash');
const outputFile = require('output-file');
const Lock = require('lock');
const Queue = require('promise-queue');
const promiseCallback = require('promise-callback-factory').default;
const copyChmod = require('./copyChmod');
const copyFile = require('./copyFile');

const cwd = process.cwd();
const pobrc = JSON.parse(fs.readFileSync(`${cwd}/.pobrc.json`));
const babelrc = require(`./babelrc${pobrc.react ? '' : '-no'}-react.json`);
const queue = new Queue(50, Infinity);

function toErrorStack(err) {
    if (err._babel && err instanceof SyntaxError) {
        return `${err.name}: ${err.message}\n${err.codeFrame}`;
    } else {
        return err.stack;
    }
}

module.exports = {
    clean(envs) {
        console.log('> cleaning');

        if (!envs) {
            execSync('rm -Rf lib-*');
            console.log('done.');
            return;
        }

        const diff = glob.sync('lib*').filter(path => !envs.includes(path.substr('lib-'.length)));
        if (diff.length) {
            console.log('removing: ' + diff.join(','));
            execSync('rm -Rf ' + diff.join(' '));
        }

        console.log('done.');
    },

    watch() {
        return this.build(true);
    },

    build(watch = false) {
        console.log(`> ${watch ? 'watching' : 'building'}... (${pobrc.envs.join(',')})`);

        if (pobrc.envs.includes('node5')) {
            console.log('[WARN] node5 is deprecated.');
            pobrc.envs = pobrc.envs.filter(env => env === 'node5');
        }

        const envs = pobrc.envs.reduce((res, env) => {
            res.push(env, `${env}-dev`);
            return res;
        }, []);

        this.clean(envs);
        return Promise.all([
            this.transpile('src', env => `lib-${env}`, envs, watch),
            pobrc.testing && this.transpile('test/src', () => 'test/node6', ['node6'], watch),
        ]);
    },

    transpile(src, outFn, envs, watch) {
        const srcFiles = glob.sync(src, { cwd });
        const _lock = Lock();
        const lock = resource => new Promise(resolve => _lock(resource, release => resolve(() => release()())));

        const optsManagers = {};

        envs.forEach(env => {
            const optsManager = new babel.OptionManager;

            optsManager.mergeOptions({
                options: {
                    presets: babelrc.env[env].presets,
                    plugins: babelrc.env[env].plugins,
                },
                alias: 'base',
                loc: cwd,
            });

            optsManagers[env] = optsManager;
        });


        function handle(filename) {
            return promiseCallback(done => fs.stat(filename, done))
                .catch(err => {
                    console.log(err);
                    process.exit(1);
                })
                .then(stat => {
                    if (stat.isDirectory(filename)) {
                        let dirname = filename;

                        const allSrcFiles = readdir(dirname);

                        envs.forEach(env => {
                            const out = outFn(env);
                            const envAllFiles = readdir(out);

                            const diff = envAllFiles.filter(path => !allSrcFiles.includes(path.replace(/.map$/, '')));
                            if (diff.length) {
                                console.log('removing: ' + diff.join(','));
                                execSync('rm -Rf ' + diff.join(' '));
                            }
                        });

                        return Promise.all(allSrcFiles.map(filename => {
                            let src = path.join(dirname, filename);
                            return handleFile(src, filename);
                        }));
                    } else {
                        return handleFile(filename, filename);
                    }
                });
        }

        function destFromSrc(relative, out) {
            // remove extension and then append back on .js
            relative = relative.slice(0, -path.extname(relative).length) + '.js';
            return path.join(out, relative);
        }

        function handleFile(src, relative) {
            if (_lock.isLocked(relative)) console.log(relative + ' locked, waiting...');
            return lock(relative).then(release => {
                return queue.add(() => {
                    if (babel.util.canCompile(relative)) {
                        console.log('compiling: ' + relative);

                        return Promise.resolve(src)
                            .then(src => promiseCallback(done => fs.readFile(src, done)))
                            .then(content => {
                                return Promise.all(envs.map(env => {
                                    const out = outFn(env);
                                    const dest = destFromSrc(relative, out);

                                    const opts = optsManagers[env].init({ filename: relative });
                                    opts.babelrc = false;
                                    opts.sourceMap = true;
                                    opts.sourceFileName = slash(path.relative(dest + "/..", src));
                                    opts.sourceMapTarget = path.basename(relative);

                                    return Promise.resolve(content)
                                        .then(content => babel.transform(content, opts))
                                        .catch(watch && (err => {
                                            console.log(toErrorStack(err));

                                            return {
                                                code: 'throw new Error("Syntax Error");',
                                                map: null,
                                            };
                                        }))
                                        .then(data => {
                                            const mapLoc = dest + ".map";
                                            data.code = data.code + "\n//# sourceMappingURL=" + path.basename(mapLoc);
                                            return promiseCallback(done => outputFile(dest, data.code, done))
                                                .then(() => Promise.all([
                                                    copyChmod(src, dest),
                                                    promiseCallback(done => fs.writeFile(mapLoc, JSON.stringify(data.map), done)),
                                                ]));
                                        })
                                        .catch(watch && (err => {
                                            console.log(toErrorStack(err));
                                        }));
                                }));
                            })
                            .then(() => {
                                console.log('compiled: ' + relative);
                            })
                            .catch(err => {
                                console.log(toErrorStack(err));
                                process.exit(1);
                            })
                            .then(() => release());
                    } else {
                        return Promise.all(envs.map(env => {
                            const out = outFn(env);
                            const dest = path.join(out, relative);
                            copyFile(src, dest);
                            copyChmod(src, dest);
                        }));
                     }
                });
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
                        console.log('changed: ' + relative);
                        handleFile(filename, relative)
                            .catch(err => {
                                console.log(err.stack);
                            });
                    }

                    watcher.on('add', handleChange);
                    watcher.on('change', handleChange);
                    watcher.on('unlink', filename => {
                        let relative = path.relative(dirname, filename) || filename;
                        console.log('unlink: ' + relative);
                        if (_lock.isLocked(relative)) console.log(relative + ' locked, waiting...');
                        lock(relative).then(release => {
                            return Promise.all(envs.map(env => {
                                const out = outFn(env);
                                const dest = destFromSrc(relative, out);

                                return Promise.all([
                                    promiseCallback(done => fs.unlink(dest, done)).catch(() => {}),
                                    promiseCallback(done => fs.unlink(`${dest}.map`, done)).catch(() => {}),
                                ]);
                            })).then(() => release());
                        });
                    });
                });
            });
        }

        return Promise.all(srcFiles.map(filename => handle(filename)))
            .then(() => console.log('build finished'))
            .catch(err => {
                console.log(err.stack);
                process.exit(1);
            });
    },
};


