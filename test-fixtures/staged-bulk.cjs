'use strict';

// Exercise the bulk threshold with a one-line file in an isolated repository.
const childProcess = require('node:child_process');
const { execFile, execFileSync } = childProcess;

function mockBulk(stdout) {
  return stdout.replace(/(^|\0)1\t0\tbulk\.txt(?=\0)/g, (_, prefix) => prefix + '20000\t0\tbulk.txt');
}

function isStagedNumstat(file, args) {
  return file === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--numstat');
}

childProcess.execFile = (file, args, options, callback) => {
  return execFile(file, args, options, isStagedNumstat(file, args)
    ? (error, stdout, stderr) => callback(error, error ? stdout : mockBulk(stdout), stderr)
    : callback);
};
childProcess.execFileSync = (file, args, options) => {
  const stdout = execFileSync(file, args, options);
  return isStagedNumstat(file, args) ? mockBulk(stdout) : stdout;
};
