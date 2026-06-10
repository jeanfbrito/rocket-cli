const debug = process.env['ROCKET_CLI_DEBUG'] === '1';

function write(level: string, msg: string, args: unknown[]): void {
  const prefix = `[${level}]`;
  if (args.length > 0) {
    process.stderr.write(`${prefix} ${msg} ${args.map(String).join(' ')}\n`);
  } else {
    process.stderr.write(`${prefix} ${msg}\n`);
  }
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    write('INFO', msg, args);
  },
  warn(msg: string, ...args: unknown[]): void {
    write('WARN', msg, args);
  },
  error(msg: string, ...args: unknown[]): void {
    write('ERROR', msg, args);
  },
  debug(msg: string, ...args: unknown[]): void {
    if (debug) write('DEBUG', msg, args);
  },
};
