export function runMain(mainFunction: () => void | Promise<void>): void {
  Promise.resolve()
    // The main function can be either synchronous or asynchronous, so let's wrap it in an async
    // callback that will catch both thrown errors and rejected promises
    .then(() => mainFunction())
    .catch((error) => {
      printError('\nScript exited with error:', error);
      process.exit(1);
    });
}

const resetColor = '\x1b[0m';

export function printError(...params: any[]): void {
  const redColor = '\x1b[31;1m';
  console.log(redColor, ...params, resetColor);
}

export function printLog(...params: any[]): void {
  const greenColor = '\x1b[32;1m';
  console.log(greenColor, ...params, resetColor);
}

export function formatSize(bytes: number | null, { includeSign = false } = {}): string {
  if (bytes === null) {
    return 'N/A';
  }

  const sign = includeSign && bytes > 0 ? '+' : '';

  if (bytes > -1024 && bytes < 1024) {
    return `${sign}${Math.round(bytes)} B`;
  }

  const kib = bytes / 1024;
  if (kib > -1024 && kib < 1024) {
    return `${sign}${kib.toFixed(2)} KiB`;
  }

  return `${sign}${(kib / 1024).toFixed(2)} MiB`;
}
