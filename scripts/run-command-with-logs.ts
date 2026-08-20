/** Runs a command while preserving its output as a CI artifact. */
import { runMain } from './lib/executionUtils.ts';
import { parseLoggedCommandOptions, runLoggedCommand } from './lib/loggedCommand.ts';

runMain(() => runLoggedCommand(parseLoggedCommandOptions(process.argv.slice(2))));
