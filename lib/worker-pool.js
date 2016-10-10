const childProcess = require('child_process');
const { Pool: GenericPool } = require('generic-pool');

module.exports = class Pool {
  constructor(args = [], { size = require('os').cpus().length, keepAlive = 5000 }) {
    const path = __dirname + '/worker';

    this.pool = new GenericPool({
      create(callback) {
        const childNode = childProcess.fork(path, args, options);
        callback(null, childNode);
      },

      destroy(child) {
        child.kill();
      },

      max: size,
      min: size - 1,
      idleTimeoutMillis: keepAlive,
    });
  }

  add(data) {
    return new Promise((resolve, reject) => {
      this.pool.acquire((err, child) => {
        if (err) return reject(err);
        child.send(data);
        child.once('message', (message) => {
          this.pool.release(child);
          resolve();
        });
      });
    })
  }

  close() {
    return new Promise(resolve => {
      this.pool.drain(() => {
        this.pool.destroyAllNow();
        resolve();
      });
    })
  }
};
