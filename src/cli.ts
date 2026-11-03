import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import type { DirectAnalysis } from "./composition/directAnalysis.js";
import { Cli, z } from "incur";
import {
  adaptCliOutputArgumentsForIncur,
  normalizeCliArguments,
} from "./cliBuiltinArguments.js";

import { createLogger } from "./logger.js";
import { parseLogLevel } from "./config/processStart.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { currentClientRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
import { clientRegistrationCommandText } from "./cli/clientRegistrationCommandText.js";
import {
  CLI_COMMAND_GROUPS,
  type CliCommandGroup,
  type CliCommandGroupContext,
} from "./cli/commandGroups.js";
import { presentOmittableDefaults } from "./cli/omittableDefaults.js";
import type { CliInstance } from "./cli/types.js";
import {
  streamCliCommandResults,
  type CliResultOutput,
} from "./cli/cliResultOutput.js";
import { excludeDeclaredSensitiveArguments } from "./cli/explicitSensitiveArguments.js";
import { rejectSurplusCliArguments } from "./cli/strictPositionals.js";
import { presentCliArgumentErrors } from "./cli/argumentErrors.js";
import { completionHelpNote, createCliCompletions } from "./cli/completions.js";
import { RECORDED_CLI_COMMAND_GROUPS } from "./recordedCliCommandGroups.js";

export { closeCliJavaScriptResources } from "./cli/cliJavaScriptResources.js";

/**
 * The groups to load for one top-level command token. A token the build did
 * not record, including help, completions and Incur's built-in commands,
 * loads every group so routing, suggestions and root help stay complete.
 */
const selectedCommandGroups = (
  command: string | undefined,
): readonly CliCommandGroup[] => {
  if (command === undefined || RECORDED_CLI_COMMAND_GROUPS === undefined)
    return CLI_COMMAND_GROUPS;
  const id = Object.hasOwn(RECORDED_CLI_COMMAND_GROUPS, command)
    ? RECORDED_CLI_COMMAND_GROUPS[command]
    : undefined;
  const group = CLI_COMMAND_GROUPS.find((candidate) => candidate.id === id);
  return group === undefined ? CLI_COMMAND_GROUPS : [group];
};

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 * With `command`, only the group that registers that recorded top-level
 * command is imported; otherwise every group is.
 */
export const createCli = (
  selectedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
  resultOutput?: CliResultOutput,
  fridaInstrumentation?: FridaInstrumentationPort,
  command?: string,
): Promise<CliInstance> =>
  assembleCli(
    selectedEnvironment,
    resultOutput,
    fridaInstrumentation,
    selectedCommandGroups(command),
  );

/** Top-level command and alias names each group registers, for the build recorder. */
export const recordCliCommandGroups = async (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> => {
  const recorded: Record<string, string> = {};
  for (const group of CLI_COMMAND_GROUPS) {
    const cli = await assembleCli(selectedEnvironment, undefined, undefined, [
      group,
    ]);
    const commands = Cli.toCommands.get(
      cli as unknown as Parameters<typeof Cli.toCommands.get>[0],
    );
    if (commands === undefined)
      throw new Error("Incur did not expose the registered REA CLI commands");
    for (const name of commands.keys()) {
      const owner = recorded[name];
      if (owner !== undefined)
        throw new Error(
          `CLI command ${name} is registered by both ${owner} and ${group.id}`,
        );
      recorded[name] = group.id;
    }
  }
  return recorded;
};

const assembleCli = async (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
  resultOutput: CliResultOutput | undefined,
  fridaInstrumentation: FridaInstrumentationPort | undefined,
  groups: readonly CliCommandGroup[],
): Promise<CliInstance> => {
  const environment = snapshotEnvironment(selectedEnvironment);
  // Groups that run analysis share one composition, created on first use.
  let analysis: Promise<DirectAnalysis> | undefined;
  const sharedAnalysis = (): Promise<DirectAnalysis> => {
    analysis ??= import("./composition/directAnalysis.js").then(
      ({ createDirectAnalysis }) => createDirectAnalysis(environment),
    );
    return analysis;
  };
  // The executable reports an invalid level before every command except doctor.
  // Doctor keeps going so its readiness report can name REA_LOG_LEVEL.
  const level =
    environment.REA_LOG_LEVEL === undefined
      ? undefined
      : parseLogLevel(environment.REA_LOG_LEVEL);
  const logger = createLogger(
    "cli",
    level?.ok === true ? level.value : "silent",
  );
  const timedCli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    globals: z.object({
      timings: z
        .boolean()
        .default(false)
        .describe("Write measured command timing to stderr."),
    }),
    mcp: {
      command: clientRegistrationCommandText(
        currentClientRegistrationCommand({ environment }),
      ),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
    update: {
      // Incur's update:false only suppresses notices. Reject its explicit
      // installer so ambiguous flags cannot bypass REA's verified workflow.
      install: () => {
        throw new Error(
          "Use 'rea update' to update the identified installation. The '--update' alias accepts only global output flags.",
        );
      },
    },
  });

  timedCli.use(async (context, next) => {
    if (!context.globals.timings) return next();
    const started = performance.now();
    try {
      await next();
    } finally {
      // This interval covers CLI command dispatch, including result delivery.
      // It is not a provider-only or analysis-only measurement.
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
    }
  });
  // Command registrars do not inspect global options; preserve their existing
  // type while Incur owns parsing and the middleware owns this added flag.
  const cli = timedCli as unknown as CliInstance;

  const context: CliCommandGroupContext = {
    cli,
    logger,
    environment,
    analysis: sharedAnalysis,
    fridaInstrumentation,
  };
  // Import selected groups concurrently, then register in catalog order.
  const registrations = await Promise.all(
    groups.map((group) => group.load(context)),
  );
  for (const register of registrations) register(context);
  presentOmittableDefaults(cli);
  if (resultOutput !== undefined) streamCliCommandResults(cli, resultOutput);
  const serveStrict = rejectSurplusCliArguments(cli);
  presentCliArgumentErrors(cli);
  const serveDeclared = excludeDeclaredSensitiveArguments(cli);
  const serve = cli.serve.bind(cli);
  const complete = createCliCompletions(
    cli as unknown as Parameters<typeof createCliCompletions>[0],
    environment,
  );
  cli.serve = (arguments_ = process.argv.slice(2), options) => {
    if (complete(arguments_, options ?? {})) return Promise.resolve();
    const normalized = normalizeCliArguments(arguments_);
    const result = serveStrict(normalized, options ?? {}, (tokens, selected) =>
      serveDeclared(tokens, selected, (declared, declaredOptions) =>
        serve(adaptCliOutputArgumentsForIncur(declared), declaredOptions),
      ),
    );
    const note = completionHelpNote(normalized);
    if (note === undefined) return result;
    return result.then(() => {
      const write =
        options?.stdout ?? ((text: string) => process.stdout.write(text));
      write(`\n${note}`);
    });
  };
  return cli;
};
