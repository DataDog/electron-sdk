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
