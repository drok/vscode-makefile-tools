// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Support for make operations

import * as configuration from './configuration';
import { MakefileConfiguration, TestEnvironment } from './configuration';
import * as cpp from 'vscode-cpptools';
import * as cpptools from './cpptools';
import {extension, telemetry} from './extension';
import * as tele from './tele';
import { Attributes, SpanStatusCode } from './tele';
import * as fs from 'fs';
import * as logger from './logger';
import * as shellParser from './parser/shell';
import {Executing} from './parser/shell';
import * as toolParser from './parser/tool';
import {Making} from './parser/tool';
import {CompileCommand} from './parser/tool';
import {Make, Goal, Variable, Database} from './parser/gnumake';
import {Parser, ParserDisp} from './parser';
import * as path from 'path';
import * as util from './util';
import * as vscode from 'vscode';
import * as ui from './ui';
import { quote } from '@mergesium/shell-quote';
import * as os from 'os';
// import { updateTree } from './tree';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();
const recursiveString = localize("recursive", "(recursive)");

export class BuildTarget {
    constructor(dir: string, name: string) {
        this.builddir = dir;
        this.goal = name;
    }
    public toString = () : string => {
        return `${this.goal} @@ ${this.builddir}`;
    }
    builddir: string;
    goal: string;
}

// Predefined, well known build targets
export const t_none = new BuildTarget("", "");
export const t_check = new BuildTarget("", "check");
export const t_all = new BuildTarget("", "all");
export const t_clean = new BuildTarget("", "clean");

// Leave positive error codes for make exit values
export enum ConfigureBuildReturnCodeTypes {
    success = 0,
    cancelled = -2,
    notFound = -3,
    outOfDate = -4,
    other = -5,
    saveFailed = -6,
    fullFeatureFalse = -7,
}

export enum Operations {
    configure = "configure",
    build = "build",
    changeConfiguration = "change makefile configuration",
    changeBuildTarget = "change build target",
    changeLaunchTarget = "change launch target",
    debug = "debug",
    run = "run"
}

export enum TriggeredBy {
    buildAll = "command pallette (buildAll)",
    configure = "command pallette (configure)",
    cleanConfigure = "command pallette (clean configure)",
    configureBeforeBuild = "configure dirty (before build), settings (configureAfterCommand)",
    configureAfterConfigurationChange = "settings (configureAfterCommand), command pallette (setBuildConfiguration)",
    configureBeforeTargetChange = "configure dirty (before target change), settings (configureAfterCommand)",
    configureAfterTargetChange = "settings (configureAfterCommand)",
    configureBeforeLaunchTargetChange = "configureDirty (before launch target change), settings (configureAfterCommand)",
    launch = "Launch (debug|run)",
    tests = "Makefile Tools Regression Tests"
}

// PID of the process that may be running currently.
// At any moment, there is either no process or only one process running
// (make for configure, make for build or pre-configure cmd/bash).
// TODO: improve the code regarding curPID and how util.spawnChildProcess is setting it in make.ts unit.
let curPID: number = -1;
export function getCurPID(): number { return curPID; }
export function setCurPID(pid: number): void { curPID = pid; }

// The source file of parseContent (build log or configuration dryrun cache).
let parseFile: string | undefined;

export interface pkgInfo {
    name: string;
    version: string;
    bugreport: string;
    url: string;
    automake: string;
}
export async function getPackageJSON(): Promise<pkgInfo> {
    return new Promise<pkgInfo>(async (resolve, reject) => {
        let c = configuration.getCurrentMakefileConfiguration();
        let theinfo : pkgInfo | undefined;

        if (extension.isConfigured()) {
            let info : string | undefined;
            const result: util.SpawnProcessResult = await util.spawnChildProcess(
                path.join(c.top_builddir, "config.status"), ["--file=-:-"],
                util.getWorkspaceRoot(),
                true, true,
                '{ "name": "@PACKAGE@", "version": "@VERSION@", "bugreport": "@PACKAGE_BUGREPORT@", "url": "@PACKAGE_URL@", "automake": "@AUTOMAKE@" }',
                (x) => {info = x}, undefined);
            if (result.returnCode !== 0) return reject();
            if (info === undefined) return reject();
            try {
                theinfo = JSON.parse(info || "");
                if (theinfo) {
                    return resolve(theinfo);
                }
            } catch (e) {
                return reject();
            }
        } else {
            const result: util.SpawnProcessResult = await util.spawnChildProcess(
                "autoconf", ["--trace=AC_INIT"],
                util.getWorkspaceRoot(),
                true, true,
                undefined,
                (x) => {
                    var ac_init = x.trimEnd().split(':');
                    if (ac_init && ac_init.length > 4 && ac_init[0] == "configure.ac" && ac_init[2] == "AC_INIT") {
                        theinfo = {
                            "name": ac_init[3],
                            "version": ac_init[4] ?? '',
                            "bugreport": ac_init[5] ?? '',
                            // 7 is tarname
                            "url": ac_init[7] ?? '',
                            "automake": "unk",
                        };
                    }
                }, undefined);
            if (result.returnCode !== 0) return reject();
            if (theinfo) return resolve(theinfo);
        }

        return reject();
    });
}

export interface AutotoolsStats {
    programs: number;
    tests: number;
    checks: number;
};

let export_stats : AutotoolsStats;
export function getStats() : AutotoolsStats {
    return export_stats;
}

export function supportsTestEnvironments() : boolean {
    return true;
}

export var builtin_targets : Set<string> = new Set();
// Targets need to parse a dryrun make invocation that does not include a target name
// (other than default empty "" or the standard "all"), otherwise it would produce
// a subset of all the targets involved in the makefile (only the ones triggered
// by building the current target).
export async function generateParseContent(progress: vscode.Progress<{}>,
                                           cancel: vscode.CancellationToken,
                                           recursive: boolean = false): Promise<ConfigureSubphaseStatus> {
    if (cancel.isCancellationRequested) {
        return {
            retc: ConfigureBuildReturnCodeTypes.cancelled,
            elapsed: 0
        };
    }

    const makefilePath :string | undefined = configuration.getConfigurationMakefile();
    if (!makefilePath) {
        extension.resetCppToolsProvider();

        // Without a makefile, this function should never be called. This is a runtime error (a bug).
        throw new Error("No makefile found.");
    }

    let startTime: number = Date.now();

    let c = configuration.getCurrentMakefileConfiguration();

    // Continue with the make dryrun invocation
    let makeArgs: string[] = [];

    // FIXME: if current target = make.t_all, dir is empty, make will be done in proj dir
    // make directory and makefile. If a target is selected, only set the target dir
    let dir = c.top_builddir;
    if (dir) {
        makeArgs.push(...["-C", dir]);
    }
    let topMakefile = configuration.gettopMakefile();
    if (topMakefile) {
        // FIXME: this refers to the configuration makefile, not the target's makefile
        makeArgs.push(...["-f", topMakefile]);
    }

    let abs_top_builddir = util.resolvePathToRoot(dir || "");
    let build_tree: Make = new Make(abs_top_builddir, abs_top_builddir);

    // Include all the make arguments defined in autotools.configurations.makeArgs
    makeArgs = makeArgs.concat(c.makeArgs || []);

    // the all-recursive target avoids the rules that make $(CONFIG_HEADER)
    // because no need to parse that recipe, and want the shortest output
    // possible.
    // But, FIXME for non-automake projects, they don't have the all-recursive target
    makeArgs.push(t_all.goal);

    // The check-recursive gets compile options for test programs too.
    // They are not included in 'all'
    makeArgs.push(t_check.goal);

    // Assemble command line options from the requirements of each parser stage.
    makeArgs.push(...Make.makeArgs());
    makeArgs.push(...Database.makeArgs());
    makeArgs.push(...Variable.makeArgs());
    makeArgs.push(...Goal.makeArgs());
    // I don't care about recipes, but they will be printed anyway
    // makeArgs.push(...Recipe.makeArgs());
    makeArgs.push(...Making.makeArgs());
    makeArgs.push(...Executing.makeArgs());

    makeArgs.push("--dry-run");
    makeArgs.push("'--assume-old=\\$(top_srcdir)/configure'",
        "'--assume-old=\\$(top_builddir)/config.status'");
    if (!dir)
        makeArgs.push("--assume-old=configure"); // Only works in-tree

    makeArgs.push(
    // rejecting GNU make's builtin variables and rules because automake
    // generates implicit rules to cover all the targets. It does not rely
    // on builtins
    // always make gets the full dependency graph, as opposed to incremental
        "--always-make");

    // FIXME: also assume-old the configuration files listed
    // ./config.status --help

    logger.message(`Export Intellisense Info from: 'make ${makeArgs.join(" ")}'`, "Debug");

    try {
        // TODO: Use stream writes
        // Problem is described here: https://stackoverflow.com/questions/3459476/how-to-append-to-a-file-in-node/43370201#43370201
        const lineEnding: string = (process.platform === "win32" && process.env.MSYSTEM === undefined) ? "\r\n" : "\n";
        let keepDryRuns: boolean = configuration.getKeepDryRuns();
        let dryrunFile : string = "all.dryrun.log";
        if (keepDryRuns) {
            dryrunFile = path.join(configuration.getConfigurationCachePath(), dryrunFile);
            logger.message(`Writing the dry-run output: ${dryrunFile}`);
            let quoted_cmd = quote([extension.dryRunner].concat(makeArgs));
            util.writeFile(dryrunFile, `${quoted_cmd}${lineEnding}`);
        }
        let completeErr: string = "";
        let heartBeat: number = Date.now();
        let parserStack: Parser[] = [build_tree];
        let linenumber: number = 0;
        let lineBuffer: string = "";

        // Clear the existing Intellisense config from cache or previous parsing
        extension.resetCppToolsProvider();

        export_stats = {programs: 0, tests: 0, checks: 0};

        let stdout: any = (result: string): void => {
            // FIXME: should end look after caught exception
            if (keepDryRuns)
                fs.appendFileSync(dryrunFile, result);

            // slice remove the very last newline.
            // .split makes two lines out of '\n'
            // this ensures no spurious last line.
            // because this is stdout, which is line buffered by default,
            // the last line ends with a newline, unless it is longer than the buffer,
            // without any newlines. I assume not, but this can happen if the buffer is
            // very small. It's a cornercase I don't handle, but definately a bug
            // if stdout buffer is small
            let isEOF : Boolean = !result;
            if (lineBuffer.length) {
                result = lineBuffer + result;
                lineBuffer = "";
            }
            let lines: string[] = result.split(/\r?\n/);
            if (result.endsWith("\n")) {
                // remove last empty line at end of buffer (because the string '\n' is not two lines, but one)
                lines.pop();
            } else if (isEOF) {
                // don't save away the last line, process it now.
            } else {
                // If the last line is incomplete, save it away, prepend it to the next
                // result buffer.
                lineBuffer = lines.pop() || "";
            }
            try {
                lines.forEach((s) => {
                    let parser = parserStack.pop();
                    linenumber++;
                    if (parser) {
                        let [disp, next] = parser.ingest(s);
                        if (disp == ParserDisp.Continue) {
                            // if (parser != next)
    //                            parserStack[parserStack.length - 1].push(parser);
                            parserStack.push(next);
                        } else if (disp == ParserDisp.Enter) {
                            parserStack.push(parser);
                            parserStack.push(next);
                            if (!(parser instanceof Goal))
                                logger.message(' '.repeat(parserStack.length *2) + `+ line ${linenumber}: ${s}`, "Debug");
                        } else {
                            let next = parserStack[parserStack.length - 1].push(parser);
                            if (next)  {
                                if (next != parser && next != parserStack[parserStack.length - 1]) {
                                    // when subsection which list, this adds a new element to the list
                                    // and continues parsing.
                                    parserStack.push(next);
                                } else {
                                    logger.message(' '.repeat(parserStack.length *2) + `- line ${linenumber}: ${s}`, "Debug");
                                }
                            } else {
                                while (!next && parserStack.length) {
                                    parser = parserStack.pop();
                                    if (parser && parserStack.length) {
                                        next = parserStack[parserStack.length - 1].push(parser);
                                    }
                                };
                                if (next && next != parserStack[parserStack.length - 1]) {
                                    // After a subsection is complete, this allows the parent to continue
                                    // with a new subsection.
                                    parserStack.push(next);
                                } else {
                                    logger.message(' '.repeat(parserStack.length *2) + `/ ${linenumber}: ${s}`, "Debug");
                                } // else parent continues
                            }
                        }
                    } else {
                        throw new Error(`Parser stack empty @ line ${linenumber}`);
                    }
                });
            } catch (e) {
                logger.message(`Parser error (line ${linenumber}):` + e);
                parserStack = [];
                telemetry.logException(e);
                throw new Error("Quit parse" + e);
            }

            heartBeat = Date.now();
        };

        let stderr: any = (result: string): void => {
            // Sometimes there is useful information coming via the stderr
            // (one example is even a bug of the make tool, because it reports
            // "Entering directory" on stderr instead of stdout causing various issues).
            completeErr += result;
        };

        const heartBeatTimeout: number = 300; // half minute. TODO: make this a setting
        let timeout: NodeJS.Timeout = setInterval(function (): void {
            let elapsedHeartBit: number = util.elapsedTimeSince(heartBeat);
            if (elapsedHeartBit > heartBeatTimeout) {
                vscode.window.showWarningMessage("Dryrun timeout. See Makefile Tools Output Channel for details.");
                logger.message("Dryrun timeout. Verify that the make command works properly " +
                "in your development terminal (it could wait for stdin).");
                if (keepDryRuns) {
                    logger.message(`Double check the dryrun output log: ${dryrunFile}`);
                }

                // It's enough to show this warning popup once.
                clearInterval(timeout);
            }
        }, 5 * 1000);

        // The dry-run analysis should operate on english.
        const result: util.SpawnProcessResult = await util.spawnChildProcess(
                extension.dryRunner,
                makeArgs, util.getWorkspaceRoot(), true, true, undefined, stdout, stderr);
        builtin_targets.clear();
        if (keepDryRuns && completeErr) {
            fs.appendFileSync(dryrunFile,
                lineEnding +
                lineEnding +
                "*** STDERR ***" +
                lineEnding +
                lineEnding +
                completeErr);
        }
        clearInterval(timeout);
        let elapsedTime: number = util.elapsedTimeSince(startTime);
        logger.message(`Generating dry-run elapsed time: ${elapsedTime}`, "Verbose");

        parseFile = keepDryRuns ? dryrunFile : (dryrunFile + " (not saved)");

        // The error codes returned by the targets invocation (make -pRrq) mean something else
        // (for example if targets are out of date). We can ignore the return code for this
        // because it "can't fail". It represents only display of database and no targets are actually run.
        // try syntax error
        if (result.returnCode !== ConfigureBuildReturnCodeTypes.success) {
            logger.message("Exporting project config from Makefiles failed.");
            logger.message(completeErr);

            // Report the standard dry-run error & guide only when the configure was not cancelled
            // by the user (which causes retCode to be null).
            // Also don't write the cache if this operation was cancelled
            // because it may be incomplete and affect a future non clean configure.
            if (result.returnCode !== null) {
                await util.reportDryRunError(dryrunFile);
            }
            telemetry.logEvent("DryRunFailed", {returnCode: result.returnCode});
            extension.resetCppToolsProvider();
            // FIXME: Since dry-running failed, also unlink the configCache file
        } else {
            // All done, notify that new data is available
            result.returnCode = extension.updateCppToolsProvider();
            export_stats = build_tree.stats;
            extension.updateTasks(build_tree);
            extension.updateWatchers();
            telemetry.setAttributes({
                    stats: [ linenumber,
                        build_tree.stats.programs,
                        build_tree.stats.tests,
                        build_tree.stats.checks ]
            });
        }
        ui.getUI().setStatus(result.returnCode !== ConfigureBuildReturnCodeTypes.success ? ui.UIStatus.ERR : ui.UIStatus.OK);

        // Update the projname because the dry-run may have updated config.status
        // TODO - this can be done by reading PACKAGE var at dry-run, avoid the extra exec
        await extension.readPkgInfo();
        extension.setConfiguration(configuration.getCurrentMakefileConfiguration().name);

        curPID = -1;
        return {
            retc: result.returnCode,
            elapsed: elapsedTime
        };
    } catch (error) {
        logger.message("Parsing the configuration failed due to: " + error);
        telemetry.logException(error);
        ui.getUI().setStatus(ui.UIStatus.RUNTIME);
        return {
            retc: ConfigureBuildReturnCodeTypes.notFound,
            elapsed: util.elapsedTimeSince(startTime)
        };
    }
}

interface ConfigurationCache {
    customConfigurationProvider: {
        workspaceBrowse: cpp.WorkspaceBrowseConfiguration;
        fileIndex: [string, {
            uri: string | vscode.Uri;
            configuration: cpp.SourceFileConfiguration;
            compileCommand: CompileCommand;
        }][];
    };
}

function isConfigurationEmpty(configurationCache: ConfigurationCache): boolean {
    if (configurationCache.customConfigurationProvider.workspaceBrowse.browsePath.length === 0) {
        return true;
    }
    return false;
}

interface ConfigureSubphasesStatus {
    loadFromCache?: ConfigureSubphaseStatus;
    generateParseContent?: ConfigureSubphaseStatus;
    // preprocessParseContent?: ConfigureSubphaseStatus;
    parseIntelliSense?: ConfigureSubphaseStatus;
    parseLaunch?: ConfigureSubphaseStatus;
    dryrunTargets?: ConfigureSubphaseStatus;
    parseTargets?: ConfigureSubphaseStatus;

    recursiveConfigure?: ConfigureSubphasesStatus;
}

// What makes a configure succesful or failed.
// This is not called when there was a cancellation, to simplify the logic and rules.
// Here are some considerations:
// 1.   If generate parse content returns a non successful return code,
// which is very frequent in the case of make --dry-run, we can't consider this
// as a configure failure because it is a problem in the developer environment/code base.
// Most of the times we get valuable output to parse regardless of some minor error
// at the end of the process. The user is notified about the dry-run error
// and is given steps to fix that, in case it is a bug in the extension.
// 2.   Preprocessing the build log or the dryrun output, together with all the parsers
// either succeed or are cancelled. For now there is no other failure scenario.
// Since this analyze helper is never called when configure is cancelled,
// it means that the outcome of these 4 subphases does not affect the total return code.
function analyzeConfigureSubphases(stats: ConfigureSubphasesStatus): number {
    // Generate parse content is a critical phase. Either if it reads from a build log
    // or invokes make --dry-run, a not found means there's nothing to parse.
    // Same applies for the phase that computes the build targets, which always invokes make.
    return stats.generateParseContent ? stats.generateParseContent.retc : ConfigureBuildReturnCodeTypes.notFound;
//    if (stats.generateParseContent?.retc === ConfigureBuildReturnCodeTypes.notFound ||
//        stats.dryrunTargets?.retc === ConfigureBuildReturnCodeTypes.notFound) {
//            // But if a configure was successful from cache, return outOfDate and not failure.
//            return stats.loadFromCache?.retc === ConfigureBuildReturnCodeTypes.success ?
//                ConfigureBuildReturnCodeTypes.outOfDate :
//                ConfigureBuildReturnCodeTypes.notFound;
//    }
//
//    // The outcome of a recursive configure invalidates any other previous returns.
//    if (stats.recursiveConfigure) {
//        return analyzeConfigureSubphases(stats.recursiveConfigure);
//    }
//
//    return ConfigureBuildReturnCodeTypes.success;
}

interface ConfigureSubphaseStatus {
    retc: ConfigureBuildReturnCodeTypes;
    elapsed: number;
}
interface ConfigureSubphaseStatusItem {
    name: string;
    status: ConfigureSubphaseStatus;
}

// Process a list of possible undefined status properties and return an array
// easy to log or send to telemetry.
// The caller of "getRelevantConfigStats" sends "stats" of type "ConfigureSubphasesStatus"
// but we need to declare it here as "any" to be able to index by prop (a string) below.
function getRelevantConfigStats(stats: any): ConfigureSubphaseStatusItem[] {
    let relevantStats: ConfigureSubphaseStatusItem[] = [];

    let retCodeProps: string[] = Object.getOwnPropertyNames(stats);
    retCodeProps.forEach(prop => {
        if (prop.toString() === "recursiveConfigure") {
            let recursiveRetCodes: ConfigureSubphaseStatusItem[] = getRelevantConfigStats(stats[prop]);
            recursiveRetCodes.forEach(recursiveRetCode => {
                relevantStats.push(
                    {
                        name: prop.toString() + "." + recursiveRetCode.name,
                        status: {
                            retc: recursiveRetCode.status.retc,
                            elapsed: recursiveRetCode.status.elapsed
                        }
                    });
            });
        } else {
            relevantStats.push(
                {
                    name: prop.toString(),
                    status: {
                        retc: stats[prop].retc,
                        elapsed: stats[prop].elapsed
                    }
                });
        }
    });

    return relevantStats;
}

// A non clean configure loads first any pre-existing cache, so that the user
// has IntelliSense and build/launch targets available earlier.
// Then invokes make dry-run (without --always-make which is used for clean configure only)
// or reads from a provided build log and parses new content to be added to the configuration cache.
// The configuration cache content and the CppTools custom IntelliSense provider are not reset.
// This way we can add incrementally to what has been parsed from the previous clean configure.
// There is the downside that any files that are removed from the makefile
// (thus disappearing from the log with commands) will still have IntelliSense loaded
// until the next clean configure.
export async function configure(triggeredBy: TriggeredBy): Promise<number> {
  // Mark that this workspace had at least one attempt at configuring, before any chance of early return,
  // to accurately identify whether this project configured successfully out of the box or not.
  let ranConfigureInCodebaseLifetime: boolean =
    extension.getState().ranConfigureInCodebaseLifetime;
  extension.getState().ranConfigureInCodebaseLifetime = true;

  // If there are no Makefiles, cannot configure Intellisense.
  if (!configuration.getConfigurationMakefile()) {
    return ConfigureBuildReturnCodeTypes.fullFeatureFalse;
  }

  telemetry.startSpan("configure");
  // Same start time for configure and an eventual pre-configure.
  let configureStartTime: number = Date.now();

  // Identify for telemetry whether this configure will read configuration constructs from cache.
  let configurationCache: string =
        path.join(configuration.getConfigurationCachePath(),
        "all.cache");
  let readCache: boolean = configurationCache ?
    util.checkFileExistsSync(configurationCache) : false;

  // Start with the success assumption until later analysis.
  let retc: number = ConfigureBuildReturnCodeTypes.success;
  let subphaseStats: ConfigureSubphasesStatus = {};

  await util.scheduleAsyncTask(async () => {await extension.registerCppToolsProvider(); });

  try {
    ui.getUI().setLoading(ui.UIStatus.LOADING);
    subphaseStats = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize("make.configuring.title", "Importing autotools configuration '{0}'", configuration.getCurrentMakefileConfiguration().name),
        cancellable: true,
      },
      async (progress, cancel) => {
        cancel.onCancellationRequested(async () => {
          if (curPID !== -1) {
            logger.message(
              `Attempting to kill the make process (PID = ${curPID}) and all its children subprocesses...`
            );
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: localize("make.confiuring.cancel.title", "Cancelling configure"),
                cancellable: false,
              },
              async (progress) => {
                return util.killTree(progress, curPID);
              }
            );
          } else {
            // The configure process may run make twice (or three times if the build target is reset),
            // with parsing in between and after. There is also the CppTools IntelliSense custom provider update
            // awaiting at various points. It is possible that the cancellation may happen when there is no make running.
            logger.message("curPID is 0, we are in between make invocations.");
          }

          logger.message("Exiting early from the configure process.");

          // We want a successful configure as soon as possible.
          // The dirty state can help with that by triggering a new configure
          // when the next relevant command occurs.
          extension.getState().configureDirty = true;

          retc = ConfigureBuildReturnCodeTypes.cancelled;
        });

        let r = await doConfigure(progress, cancel, readCache, configurationCache);
        extension.autotoolsDoneNoResult();
        return r;
      }
    );

    ui.getUI().setLoading(ui.UIStatus.OK);
    // If not cancelled already, analyze all doConfigure subphases
    // to decide how we should look at the final configure outcome.
    // retc is set to cancel in onCancellationRequested
    // and we don't need to look which subphase cancelled.
    if (retc !== ConfigureBuildReturnCodeTypes.cancelled) {
      retc = analyzeConfigureSubphases(subphaseStats);
    }

    extension.getState().configureDirty = !(retc === ConfigureBuildReturnCodeTypes.success);

    if (retc === ConfigureBuildReturnCodeTypes.success) {
        let fileIndex = extension.getCppConfigurationProvider().getCustomConfigurationProvider().fileIndex;

        let sample = Array.from(fileIndex.keys()).slice(0, 3)
                .concat("...")
                .map(f => path.basename(f));
    // FIXME: not true. it gets here if --dry-run parsing throws
      logger.message(localize("autotools.log.config.exported",
        "Exported to Intellisense: build configuration for {0} source files like {1}",
            fileIndex.size,
            sample.join(", ")
            ));
      logger.message(localize("autotools.log.config.exported2",
            "Generated tasks: {0} build tasks and {1} test tasks in {2} check suites (see Run Task... command)",
            export_stats.programs, export_stats.tests, export_stats.checks));
    } else {
        if (retc == 1) {/* ie, Intellisense API not available */
            var kbUrl : vscode.Uri = await extension.kbUrl();
            logger.message('Export to Intellisense failed. Review the OUTPUT tab of C++ for cause.', "Normal");
            logger.message('Exporting can be re-attempted with "Autotools: Export Configuration to Intellisense"', "Normal");
            logger.message('KB: ' + kbUrl.toString(true) + '#intellisense-export-fail', "Normal");
        }
    }

    return retc;
  } catch (e) {
    logger.message(
      `Exception thrown during the configure process: ${e.message}`
    );
    telemetry.logException(e);
    telemetry.endSpanWithStatus(SpanStatusCode.ERROR, e.message);
    retc = ConfigureBuildReturnCodeTypes.other;
    return e.errno;
  } finally {
    let provider: cpptools.CustomConfigurationProvider = extension
      .getCppConfigurationProvider()
      .getCustomConfigurationProvider();
    let ConfigurationCache: ConfigurationCache = {
      customConfigurationProvider: {
        workspaceBrowse: provider.workspaceBrowse,
        // trick to serialize a map in a JSON
        fileIndex: Array.from(provider.fileIndex),
      },
    };

    if (!isConfigurationEmpty(ConfigurationCache)) {
      // Rewrite the configuration cache according to the last updates of the internal arrays,
      // but not if the configure was cancelled and not while running regression tests.
      if (
        configuration.getKeepConfigurationCache() &&
        configurationCache &&
        retc !== ConfigureBuildReturnCodeTypes.cancelled &&
        process.env["MAKEFILE_TOOLS_TESTING"] !== "1"
      ) {
        util.writeFile(
          configurationCache,
          JSON.stringify(ConfigurationCache)
        );
      }

    } else if (readCache) {
        // FIXME:
        // util.deleteFileSync(configurationCache);
        logger.message(`Warning: Config cache ${configurationCache} is empty. It can be deleted.`, "Verbose");
    }

    let configureElapsedTime: number =
      util.elapsedTimeSince(configureStartTime);

    logger.message(`Configure elapsed time: ${configureElapsedTime}`, "Verbose");

    // Let's consider that a cancelled configure is not a complete configure,
    // even if, depending when the cancel happened, the cache may have been loaded already.
    // Cancelled configures reach this point too, because of the finally construct.
    if (retc !== ConfigureBuildReturnCodeTypes.cancelled) {
      extension.setCompletedConfigureInSession(true);
    }

    telemetry.endSpanWithStatus(SpanStatusCode.OK, undefined, {
        numFiles: provider.fileIndex.size,
        numConfigs: configuration.getMakefileConfigurations().length,
        firstTime: !ranConfigureInCodebaseLifetime,
        readCache: readCache,
        trigBy: triggeredBy,
        ret: retc,
    });

    if (retc !== ConfigureBuildReturnCodeTypes.success) {
      logger.showOutputChannel();
    }
  }
}


/**
 * Loads into Intellisense a previously calculated configuration.
 * This function should not be called if there is no cache to load.
 * @param cacheFile - the filename including path of the cache in json format
 */
async function loadConfigurationFromCache(progress: vscode.Progress<{}>, cancel: vscode.CancellationToken, cacheFile: string): Promise<ConfigureSubphaseStatus> {
    if (cancel.isCancellationRequested) {
        return {
            retc: ConfigureBuildReturnCodeTypes.cancelled,
            elapsed: 0
        };
    }

    telemetry.startSpan("loadCache");
    let startTime: number = Date.now();
    let elapsedTime: number;

    let content: string | undefined = util.readFile(cacheFile);
    if (content) {
        try {
            progress.report({ increment: 1, message: localize("make.configure.cache", "Importing cached configuration") });
            logger.message(`Configuring from cache: ${cacheFile}`, "Verbose");
            let configurationCache: ConfigurationCache = {
                customConfigurationProvider: {
                    workspaceBrowse: {
                        browsePath: []
                    },
                    fileIndex: []
                }
            };
            let json  = JSON.parse(content);
            configurationCache = json;

            let stats: Attributes = {
                stats: [configurationCache.customConfigurationProvider.workspaceBrowse.browsePath.length,
                configurationCache.customConfigurationProvider.fileIndex.length,
            ]};
            // Deserialize object.
            // configurationCache.customConfigurationProvider.fileIndex.uri is converted to vscode.Uri objects
            // buildTargets is converted to Map
            await util.scheduleTask(() => {
                configurationCache.customConfigurationProvider.fileIndex.forEach(i => {
                    i[1].uri = vscode.Uri.file(i[0]);
                });
            });

            await util.scheduleTask(() => {
                // The configurations saved in the cache are read directly into the final file index.
                extension.getCppConfigurationProvider().setCustomConfigurationProvider({
                    workspaceBrowse: configurationCache.customConfigurationProvider.workspaceBrowse,
                    // Trick to read a map from json
                    fileIndex: new Map<string, cpptools.SourceFileConfigurationItem>(configurationCache.customConfigurationProvider.fileIndex)
                });
            });

            telemetry.endSpanWithStatus(SpanStatusCode.OK, undefined, {
                stats: [
                    configurationCache.customConfigurationProvider.workspaceBrowse.browsePath.length,
                    configurationCache.customConfigurationProvider.fileIndex.length,
                ]});
        } catch (e) {
            telemetry.logException(e);
            logger.message("An error occured while parsing the configuration cache.");
            telemetry.endSpanWithStatus(SpanStatusCode.ERROR, "parsing");
        }
        elapsedTime = util.elapsedTimeSince(startTime);
        logger.message(`Load configuration from cache elapsed time: ${elapsedTime}`, "Verbose");

        // Log all the files read from cache after elapsed time is calculated.
        // IntelliSense should be available by now for all files.
        // Don't await for this logging step. This may produce some interleaved output
        // but it will still be readable.
        await util.scheduleTask(() => {
            extension.getCppConfigurationProvider().logConfigurationProviderComplete();
        });
    } else {
        telemetry.endSpanWithStatus(SpanStatusCode.ERROR, "nodata");
        return {
            retc: ConfigureBuildReturnCodeTypes.notFound,
            elapsed: 0
        };
    }

    return {
        retc: cancel.isCancellationRequested ? ConfigureBuildReturnCodeTypes.cancelled : ConfigureBuildReturnCodeTypes.success,
        elapsed: elapsedTime
    };
}

// Update IntelliSense and launch targets with information parsed from a user given build log,
// the dryrun cache or make dryrun output if the cache is not present.
// Sometimes the targets do not need an update (for example, when there has been
// a change in the current build target), as requested through the boolean.
// This saves unnecessary parsing which may be signifficant for very big code bases.
export async function doConfigure(progress: vscode.Progress<{}>, cancel: vscode.CancellationToken, readCache: boolean, cacheFile: string, recursiveDoConfigure: boolean = false): Promise<ConfigureSubphasesStatus> {
    let subphaseStats: ConfigureSubphasesStatus = {};

    // If available, load all the configure constructs via json from the cache file.
    // If this doConfigure is in level 1 of recursion, avoid loading the configuration cache again
    // since it's been done at recursion level 0.
    // Also skip if there was at least one completed configure before in this VSCode session,
    // regardless of any other failure error code, because at the end of that last configure,
    // the extension saved this configuration content (that we can skip loading now) into the cache.
    // The loading from cache is cheap, but logging it (for Verbose level) may interfere unnecessarily
    // with the output channel, especially since that logging is not awaited for.
    if (!recursiveDoConfigure && !extension.getCompletedConfigureInSession() && readCache) {
        subphaseStats.loadFromCache = await loadConfigurationFromCache(progress, cancel, cacheFile);
        if (subphaseStats.loadFromCache.retc === ConfigureBuildReturnCodeTypes.cancelled) {
            return subphaseStats;
        }
    } else {
        logger.message("Loading configurations from cache is not necessary.", "Verbose");
    }

    let s = telemetry.startSpan("import");
    telemetry.setAttributes({
            n: extension.pkginfo?.name,
            v: extension.pkginfo?.version,
            am: extension.pkginfo?.automake.split("-").slice(-1)[0],
        });
    // This generates the dryrun output (saving it on disk) or reads an alternative build log.
    // Timings for this sub-phase happen inside.
    subphaseStats.generateParseContent = await generateParseContent(progress, cancel, recursiveDoConfigure);

    switch (subphaseStats.generateParseContent.retc) {
        case ConfigureBuildReturnCodeTypes.cancelled:
            telemetry.setSpanStatus(SpanStatusCode.ERROR, "Cancelled");
        case ConfigureBuildReturnCodeTypes.success:
            telemetry.setSpanStatus(SpanStatusCode.OK); break;
        default:
            telemetry.setSpanStatus(SpanStatusCode.ERROR);
    }

    // Let the caller collect and log all information regarding the subphases return codes.
    if (!recursiveDoConfigure) {
        logger.message("Configure finished. The status for all the subphases that ran:", "Debug");
        let subphases: ConfigureSubphaseStatusItem[] = getRelevantConfigStats(subphaseStats);
        subphases.forEach(subphase => {
            logger.message(`  - ${subphase.name}: return code = ${subphase.status.retc}, ` +
                           `elapsed time = ${subphase.status.elapsed}`, "Debug");
        });
    }

    return subphaseStats;
}

/**
 * Possible TRS results from automake
 *
 * {@url https://www.gnu.org/software/automake/manual/html_node/TEST-RESULTS.html}
 */
export enum TRS {
    NONE = 0, /* test result n/a */
    XPASS = 1,
    PASS = 2,
    SKIP = 3,
    ERROR = 4,
    FAIL = 5,
    XFAIL = 6
}
export interface TestResult {
    // :global-test-result: outcome
    global: TRS;
    // :test-result: outcome
    current: TRS;
    // number of test-results found (one per environment)
    num: number;
};

export const TRS_Info: { [key: number]: vscode.FileDecoration } = {
    [TRS.NONE]:  { tooltip: 'n/a',   badge: '❔' },
    [TRS.XPASS]: { tooltip: 'XPASS', badge: '☑️' },
    [TRS.PASS]:  { tooltip: 'PASS',  badge: '✔️' },
    [TRS.SKIP]:  { tooltip: 'SKIP',  badge: '🔳' },
    [TRS.ERROR]: { tooltip: 'ERROR', badge: /* '⭕' */ '💣️'},
    [TRS.FAIL]:  { tooltip: 'FAIL',  badge: '❌' },
    [TRS.XFAIL]: { tooltip: 'XFAIL', badge: '🏳️' },
    [7]: { tooltip: 'THROW',   badge: '⁉️' },
  };

export function isSuspect(trs: TRS) : boolean
{
    return trs === TRS.ERROR || trs === TRS.XFAIL || trs === TRS.XPASS;
}

const noTRS : TestResult = { global: TRS.NONE, current: TRS.NONE, num: 0 };
/**
 * Read the test result for a the specified TestEnvironemnt from a TRS file.
 * Compatibility with manually run tests (make check from the commandline),
 * which use the default LOG_DRIVER (not test-environment aware): If the specified
 * TestEnvironemnt has no TESTS_ENVIRONMENT settings a :test-results: line without
 * an environemnt name is accepted as a match.
 *
 * @param b Build target (ie, directory and filename) of a TRS file
 * @param env TestEnvironemnt for which to fetch the result.
 * @param c Current build configuration.
 * @returns a {@linkcode make.TRS TRS enum value}
 */
export function readTRS(b: BuildTarget, env: TestEnvironment, c: MakefileConfiguration) : TestResult
{
    let trs = util.resolvePathToRoot(path.join(c.top_builddir, b.builddir, path.basename(b.goal, ".log") + ".trs"));
    let hasEnv : boolean = !!env.checkExecOptions?.env?.TESTS_ENVIRONMENT.length;
    let testResult : TestResult = { global: TRS.NONE, current: TRS.NONE, num: 0 };
    try {
        const fileContent = fs.readFileSync(trs, 'utf8');
        if (!fileContent)
            return noTRS;
        const lines = fileContent.split('\n');

        let localResult : string = "-";
        let globalResult : string = "NONE";

        for (const line of lines) {
            if (line.startsWith(':test-result:')) {
                const result = line.split(' ', 4);
                if (result[2] == env.name) {
                    localResult = result[1];
                } else if (!hasEnv && result.length == 2 && localResult == "-") {
                    localResult = result[1];
                }
                testResult.num++;
            } else if (line.startsWith(':global-test-result:')) {
                globalResult = line.split(' ', 2)[1];
            }
        }
        switch (localResult) {
            case "XPASS": testResult.current = TRS.XPASS; break;
            case "PASS":  testResult.current = TRS.PASS; break;
            case "SKIP":  testResult.current = TRS.SKIP; break;
            case "ERROR": testResult.current = TRS.ERROR; break;
            case "FAIL":  testResult.current = TRS.FAIL; break;
            case "XFAIL": testResult.current = TRS.XFAIL; break;
            case "NONE":  testResult.current = TRS.NONE; break;
            case "-":     testResult.current = TRS.NONE; break;
            default:      testResult.current = TRS.ERROR; break;
        }
        switch (globalResult) {
            case "XPASS": testResult.global = TRS.XPASS; break;
            case "PASS":  testResult.global = TRS.PASS; break;
            case "SKIP":  testResult.global = TRS.SKIP; break;
            case "ERROR": testResult.global = TRS.ERROR; break;
            case "FAIL":  testResult.global = TRS.FAIL; break;
            case "XFAIL": testResult.global = TRS.XFAIL; break;
            case "NONE":  testResult.global = TRS.NONE; break;
            default:      testResult.global = TRS.ERROR; break;
        }
    }
    catch (e) {
        return noTRS; // File does not exist
    }
    return testResult;
}
