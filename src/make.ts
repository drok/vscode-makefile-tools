// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Support for make operations

import * as configuration from './configuration';
import { FolderConfig, MakefileConfiguration } from './configuration';
import * as cpp from 'vscode-cpptools';
import * as cpptools from './cpptools';
import {extension, telemetry} from './extension';
import { Attributes, SpanStatusCode } from './tele';
import { Span } from '@opentelemetry/api';
import * as fs from 'fs';
import * as logger from './logger';
import {Executing} from './parser/shell';
import {Making} from './parser/tool';
import {CompileCommand} from './parser/tool';
import {MakeContext, Make, Goal, Variable, Database} from './parser/gnumake';
import {Parser, ParserDisp} from './parser';
import * as path from 'path';
import * as util from './util';
import * as vscode from 'vscode';
import { WorkspaceFolder } from 'vscode';
import * as ui from './ui';
import { quote } from '@mergesium/shell-quote';
import * as diag from './diag';

import * as nls from 'vscode-nls';
import { log } from 'console';
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
    describedError = 2,
    outOfDate = 1,
    notFound = -3,
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
    amUpdate = "Makefile.am updated",
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
    tarname: string;
    automake: string;
    maint?: string;
    ac_config_files_line: number;
}
function fixupPackageURLs(theinfo: pkgInfo) : void {
    if (!theinfo.url && theinfo.tarname && theinfo.name.startsWith('GNU '))
        theinfo.url = `https://www.gnu.org/software/${theinfo.tarname}/`;
    if (theinfo.bugreport) {
        let url = vscode.Uri.parse(theinfo.bugreport);
        if (!url.scheme || url.scheme == 'file')
            theinfo.bugreport = `mailto:${theinfo.bugreport}`;
    }
}
export async function getPackageJSON(fc: FolderConfig): Promise<pkgInfo | undefined> {
    return new Promise<pkgInfo|undefined>(async (resolve, reject) => {
        let c = fc.config;
        let theinfo : pkgInfo = {
            name: 'unk',
            version: 'unk',
            bugreport: 'unk',
            tarname: '',
            url: '',
            automake: 'unk',
            ac_config_files_line: 0,
        };

        if (fc.isConfigured) {
            try {
                let info : string | undefined;
                const result: util.SpawnProcessResult = await util.spawnChildProcess(
                    path.join(fc.abs_top_builddir, "config.status"), ["--file=-:-"],
                    fc.folder.uri.path,
                    true, true,
                    '{ "name": "@PACKAGE_NAME@", "version": "@PACKAGE_VERSION@", "tarname": "@PACKAGE_TARNAME@", "bugreport": "@PACKAGE_BUGREPORT@", "url": "@PACKAGE_URL@", "automake": "@AUTOMAKE@", "maint": "@MAINTAINER_MODE_FALSE@" }',
                    (x) => {info = x}, undefined).catch<util.SpawnProcessResult>((r) => Promise.resolve({ returnCode: 33, signal: "ERR" }));
                if (result.returnCode !== 0) return resolve(undefined);
                if (info === undefined) return resolve(undefined);
                    theinfo = JSON.parse(info || "");
                if (theinfo) {
                    fixupPackageURLs(theinfo);

                    const result: util.SpawnProcessResult = await util.spawnChildProcess(
                        "autoconf", ['--trace=AC_CONFIG_FILES:\\$f%%%\\$l%%%\\$n%%%'],
                        fc.folder.uri.path,
                        true, true,
                        undefined,
                        (x) => {
                            var ac_init = x.trimEnd().split('%%%');
                            if (ac_init[2] == 'AC_CONFIG_FILES') {
                                theinfo.ac_config_files_line = Number(ac_init[1]);
                            }
                        }, undefined);

                    return resolve(theinfo);
                }
                else resolve(undefined);
            } catch (e) {
                return resolve(undefined);
            }
        } else {
            const result: util.SpawnProcessResult = await util.spawnChildProcess(
                "autoconf", ["--trace=AC_INIT:\\$f%%%\\$l%%%\\$n%%%\\${%%%}%", '--trace=AC_CONFIG_FILES:\\$f%%%\\$l%%%\\$n%%%'],
                fc.folder.uri.path,
                true, true,
                undefined,
                (x) => {
                    var ac_init = x.trimEnd().split('%%%');
                    if (ac_init && ac_init.length > 4 && ac_init[0] == "configure.ac" && ac_init[2] == "AC_INIT") {
                        theinfo.name = ac_init[3];
                        theinfo.version = ac_init[4] ?? '',
                        theinfo.bugreport = ac_init[5] ?? '',
                        theinfo.tarname = ac_init[6] ?? '',
                        theinfo.url = ac_init.slice(7).join(':') ?? '',
                        theinfo.automake =  "unk",
                        fixupPackageURLs(theinfo);
                    } else
                    if (ac_init[2] == 'AC_CONFIG_FILES') {
                        theinfo.ac_config_files_line = Number(ac_init[1]);
                    }
                }, undefined);
            if (result.returnCode !== 0) resolve(undefined);
            if (theinfo) return resolve(theinfo);
        }

        return reject();
    });
}

export var builtin_targets : Set<string> = new Set();
// Targets need to parse a dryrun make invocation that does not include a target name
// (other than default empty "" or the standard "all"), otherwise it would produce
// a subset of all the targets involved in the makefile (only the ones triggered
// by building the current target).
export async function generateParseContent(span: Span, fc: FolderConfig): Promise<ConfigureSubphaseStatus> {
    let startTime: number = Date.now();

    let c = fc.buildConfig;

    // Continue with the make dryrun invocation
    let makeArgs: string[] = [];

    let topMakefile = fc.topMakefile;
    if (topMakefile) {
        // FIXME: this refers to the configuration makefile, not the target's makefile
        makeArgs.push(...["-f", topMakefile]);
    }

    fc.clearBuildTargets(span);
    let build_tree = fc.build_tree;

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
//    makeArgs.push("'--assume-old=\\$(top_srcdir)/configure'",
//        "'--assume-old=\\$(top_builddir)/config.status'");
//    if (!fc.buildConfig.top_builddir)
//        makeArgs.push("--assume-old=configure"); // Only works in-tree

    makeArgs.push(
        /* Don't stop for errors like "No rule to make ..." because those say
         * what can be done. Dry running is concerned with what *should* be done.
         */
        "--keep-going",

        "GMOFILES=", // Avoid po and pot files being built with msgmerge
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
        let dryrunFile : string = "all.dryrun.log";
        let dryRunPath = fc.dryRunPath;
        if (dryRunPath) {
            dryrunFile = path.join(dryRunPath, dryrunFile);
            logger.message(`Writing the dry-run output: ${dryrunFile}`);
            let quoted_cmd = quote([extension.dryRunner].concat(makeArgs));
            util.writeFile(dryrunFile, `${quoted_cmd}${lineEnding}`);
        }
        let completeErr: string = "";
        let heartBeat: number = Date.now();
        let parserStack: Parser[] = [build_tree];
        build_tree.ctx.parserStack = parserStack;
        let linenumber: number = 0;
        let lineBuffer: string = "";
        let parseFailedAt: number = 0;

        // Clear the existing Intellisense config from cache or previous parsing
        // fc.resetCppToolsProvider();

        let stdout: any = (result: string): void => {
            // FIXME: should end look after caught exception
            if (dryRunPath)
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
            if (parserStack.length) // avoid throwing repeatedly after a bug that depletes the stack
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
                            let next = parserStack[parserStack.length - 1].push(parser, parserStack);
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
                                        next = parserStack[parserStack.length - 1].push(parser, parserStack);
                                    }
                                };
                                if (next && next != parserStack[parserStack.length - 1]) {
                                    // After a subsection is complete, this allows the parent to continue
                                    // with a new subsection.
                                    parserStack.push(next);
                                // } else {
                                    //logger.message(' '.repeat(parserStack.length *2) + `/ ${linenumber}: ${s}`, "Debug");
                                } // else parent continues
                            }
                        }
                    } else {
                        throw new Error(`Parser stack empty @ line ${linenumber}`);
                    }
                });
            } catch (e) {
                logger.message(`ERROR: Parser error (dryrun line ${linenumber}):` + e);
                parseFailedAt = linenumber;
                parserStack = [];
                telemetry.logException(e, span);
                throw new Error("Quit parse" + e);
            }

            heartBeat = Date.now();
        };

        var kbUrl : vscode.Uri = await fc.kbUrl();
        let stderr: any = (result: string): void => {
            // Sometimes there is useful information coming via the stderr
            // (one example is even a bug of the make tool, because it reports
            // "Entering directory" on stderr instead of stdout causing various issues).
            completeErr += result;


            if (dryRunPath) {
                logger.message(`ERROR in ${dryrunFile}:${linenumber}:`, 'Normal');
            }
            let mi = util.findLastIndex(parserStack, p => p instanceof Make);
            if (mi >= 0) {
                let m = parserStack[mi] as Make;
                logger.message(`In ${path.join(m.dir,'Makefile')} > ${m.file}`, 'Normal');
            }

            let msg = result
                .replace(/^/, "    ")
                .replace(/^\s*(.* No rule to make target.*)$/gm, "WARNING: $&\nWARNING: This leads to debugging out-of-date programs.")
                .replace(/^\s*(.* overriding recipe for target*)$/gm, `WARNING: $&\nWARNING: Discovered test tasks will not run as the maintainers expect.\nKB: ${kbUrl.toString(true)}#overrides-check-target`);
            logger.message(msg, 'Normal');

        };

        const heartBeatTimeout: number = 300; // half minute. TODO: make this a setting
        let timeout: NodeJS.Timeout = setInterval(function (): void {
            let elapsedHeartBit: number = util.elapsedTimeSince(heartBeat);
            if (elapsedHeartBit > heartBeatTimeout) {
                vscode.window.showWarningMessage("Dryrun timeout. See Autotools Output Channel for details.");
                logger.message(`Dryrun timeout. See ${kbUrl.toString(true)}#dry-run-timeout`, "Normal");
                if (dryRunPath) {
                    logger.message(`Double check the dryrun output log: ${dryrunFile}`);
                }

                // It's enough to show this warning popup once.
                clearInterval(timeout);
            }
        }, 5 * 1000);

        // The dry-run analysis should operate on english.
        const result: util.SpawnProcessResult = await util.spawnChildProcess(
                extension.dryRunner,
                makeArgs, fc.abs_top_builddir, true, true, undefined, stdout, stderr);
        builtin_targets.clear();
        if (dryRunPath && completeErr) {
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

        parseFile = dryRunPath ? dryrunFile : (dryrunFile + " (not saved)");

        // The error codes returned by the targets invocation (make -pRrq) mean something else
        // (for example if targets are out of date). We can ignore the return code for this
        // because it "can't fail". It represents only display of database and no targets are actually run.
        // try syntax error
        if (result.returnCode !== ConfigureBuildReturnCodeTypes.success) {
            if (result.returnCode == ConfigureBuildReturnCodeTypes.describedError) {
                if (fc.buildTargets.size != 0) {
                    logger.message("Exporting project config was partially successful.");
                } else {
                    logger.message("Exporting project config failed.");
                }
            } else if (result.returnCode == ConfigureBuildReturnCodeTypes.outOfDate) {
                logger.message("Exporting project config from Makefiles failed.");
            } else {
                telemetry.setAttributes(span, {exitCode: result.returnCode});
                telemetry.setSpanStatus(span, SpanStatusCode.ERROR, "dryFail");
            }
            telemetry.setAttributes(span, {exitCode: result.returnCode});
            telemetry.setSpanStatus(span, SpanStatusCode.ERROR, "dryFail");

            if (result.returnCode == ConfigureBuildReturnCodeTypes.describedError) {
                logger.message('KB: ' + kbUrl.toString(true) + '#dry-run-warnings', "Normal");
            } else {
                await util.reportDryRunError(fc, dryrunFile);
            }
            // FIXME: Since dry-running failed, also unlink the configCache file
        } else {
            telemetry.setAttributes(span, {numLines: linenumber});
            if (parseFailedAt) {
                /* Partial parse ... something in the make output could not be parsed */
                telemetry.setAttributes(span, {failAtLine: parseFailedAt});
                var kbUrl : vscode.Uri = await fc.kbUrl();
                logger.message('KB: ' + kbUrl.toString(true) + '#config-parse-fail', "Normal");
            } else
                telemetry.setSpanStatus(span, SpanStatusCode.OK);
        }
        /* Now decide whether to import (partial) data or reset Intellisense */
        if (result.returnCode !== ConfigureBuildReturnCodeTypes.success &&
            result.returnCode != ConfigureBuildReturnCodeTypes.outOfDate &&
            result.returnCode != ConfigureBuildReturnCodeTypes.describedError) {
            /* Reset, to make it obvious that something very wrong happened */
            fc.resetCppToolsProvider();
        } else {
            fc.accountForTraits();
            fc.updateBuildTree();
            fc.updateWatchers();
        }
        let attrs : Attributes = {
            lines: linenumber,
            stats: [
                build_tree.stats.programs,
                build_tree.stats.sharedlibs,
                build_tree.stats.tests,
                build_tree.stats.testbins,
                build_tree.stats.checks,
            ],
        };
        // separate because it is a measure of added value
        if (build_tree.stats.missingRules) attrs.mRules = build_tree.stats.missingRules;
        if (build_tree.stats.localRules) attrs.lRules = build_tree.stats.localRules;
        telemetry.setAttributes(span, attrs);
        ui.getUI().setStatus(result.returnCode !== ConfigureBuildReturnCodeTypes.success ? ui.UIStatus.ERR : ui.UIStatus.OK, build_tree.ctx.fc);

        // Update the projname because the dry-run may have updated config.status
        // TODO - this can be done by reading PACKAGE var at dry-run, avoid the extra exec
        await fc.readPkgInfo();

        curPID = -1;
        return {
            retc: result.returnCode,
            elapsed: elapsedTime
        };
    } catch (error) {
//        if (error instanceof Error)
//            logger.message('Parsing the configuration failed due to: ' + error.toString() + '\n' + error.stack);
//        else
            logger.message('Parsing the configuration failed due to: ' + error.toString(true));
        telemetry.logException(error, span);
        telemetry.setSpanStatus(span, SpanStatusCode.ERROR, "exception");
        ui.getUI().setStatus(ui.UIStatus.RUNTIME, build_tree.ctx.fc);
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
export async function configure(parentSpan: Span, triggeredBy: TriggeredBy, fc: FolderConfig): Promise<number> {
  // Mark that this workspace had at least one attempt at configuring, before any chance of early return,
  // to accurately identify whether this project configured successfully out of the box or not.
  let ranConfigureInCodebaseLifetime: boolean =
    fc.state.ranConfigureInCodebaseLifetime;
  fc.state.ranConfigureInCodebaseLifetime = true;

  let span = telemetry.startSpan("conf", parentSpan);
  // Same start time for configure and an eventual pre-configure.
  let configureStartTime: number = Date.now();

  // Identify for telemetry whether this configure will read configuration constructs from cache.
  let configurationCache: string = fc.cachePath ?
        path.join(fc.cachePath, "all.cache") : '';
  let readCache: boolean = configurationCache ?
    util.checkFileExistsSync(configurationCache) : false;

  // Start with the success assumption until later analysis.
  let retc: number = ConfigureBuildReturnCodeTypes.success;
  let subphaseStats: ConfigureSubphasesStatus = {};

  await fc.autotoolsTask.waitToTouchMakefiles();
  try {
    ui.getUI().setLoading(ui.UIStatus.LOADING, fc);
    subphaseStats = await doConfigure(readCache, configurationCache, false, span, fc);
    fc.autotoolsTask.autotoolsDoneNoResult();

    // If not cancelled already, analyze all doConfigure subphases
    // to decide how we should look at the final configure outcome.
    // retc is set to cancel in onCancellationRequested
    // and we don't need to look which subphase cancelled.
    retc = analyzeConfigureSubphases(subphaseStats);
    ui.getUI().setLoading(!retc ? ui.UIStatus.OK : ui.UIStatus.ERR, fc);

    fc.state.configureDirty = !(retc === ConfigureBuildReturnCodeTypes.success);

    if (retc === ConfigureBuildReturnCodeTypes.success) {
        let fileIndex = fc.cppConfigurationProvider.getCustomConfigurationProvider().fileIndex;

        let sample = Array.from(fileIndex.keys()).slice(0, 3)
                .concat("...")
                .map(f => path.basename(f));
    // FIXME: not true. it gets here if --dry-run parsing throws
      if (extension.getCppToolsVersion()) {
        logger.message(localize("autotools.log.config.exported",
            "Exported to Intellisense: build configuration for {0} source files like {1}",
                fileIndex.size, sample.join(", ")));
      } else {
        logger.message(localize("autotools.log.config.available",
            "Intellisense data available, but not used, for {0} source files like {1}",
                fileIndex.size, sample.join(", ")));
      }
      let stats = fc.build_tree.stats;
      logger.message(localize("autotools.log.config.exported2",
            "Generated tasks: {0} build tasks and {1} test tasks in {2} check suites (see Run Task... command)",
            stats.programs, stats.tests, stats.checks));
    } else {
        if (retc == 1) {/* ie, Intellisense API not available */
            var kbUrl : vscode.Uri = await fc.kbUrl();
            logger.message('Export to Intellisense failed. Review the OUTPUT tab of C++ for cause.', "Normal");
            logger.message('Exporting can be re-attempted with "Autotools: Export Configuration to Intellisense"', "Normal");
            logger.message('KB: ' + kbUrl.toString(true) + '#intellisense-export-fail', "Normal");
        } else if (retc == 2) { /* Makefile is broken */
            if (triggeredBy == TriggeredBy.cleanConfigure) {
                logger.message('Trying to recover by re-checking the configuration (config.status)', "Normal");
                await fc.autotoolsTask.recheck(telemetry.startSpan("recover", span));
            }
        }
    }

    return retc;
  } catch (e) {
    logger.message(
      `Exception thrown during the configure process: ${e.message}`
    );
    telemetry.logException(e, span);
    telemetry.endSpanWithStatus(span, SpanStatusCode.ERROR, e.message);
    retc = ConfigureBuildReturnCodeTypes.other;
    return e.errno;
  } finally {
    let provider: cpptools.CustomConfigurationProvider = fc
      .cppConfigurationProvider
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
      if (
        configurationCache
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

    extension.setCompletedConfigureInSession(true);

    let attrs : Attributes = {
        numFiles: provider.fileIndex.size,
    };
    if (fc.numConfigs > 1) attrs.numConfigs = fc.numConfigs;
    if (!ranConfigureInCodebaseLifetime) attrs.firstTime = !ranConfigureInCodebaseLifetime;
    if (readCache) attrs.readCache = readCache;
    if (fc.errorCodes.size) attrs.errors = Array.from(fc.errorCodes.keys());
    telemetry.endSpanWithStatus(span,
        retc == ConfigureBuildReturnCodeTypes.success ?
            SpanStatusCode.OK : SpanStatusCode.ERROR, "confmsg", attrs);

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
async function loadConfigurationFromCache(fc: FolderConfig, cacheFile: string, parentSpan: Span): Promise<ConfigureSubphaseStatus> {

    let span = telemetry.startSpan("lc", parentSpan);
    let startTime: number = Date.now();
    let elapsedTime: number;

    let content: string | undefined = util.readFile(cacheFile);
    if (content) {
        try {
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

            // Deserialize object.
            // configurationCache.customConfigurationProvider.fileIndex.uri is converted to vscode.Uri objects
            // buildTargets is converted to Map
            configurationCache.customConfigurationProvider.fileIndex.forEach(i => {
                i[1].uri = vscode.Uri.file(i[0]);
            });

            // The configurations saved in the cache are read directly into the final file index.
            fc.cppConfigurationProvider.setCustomConfigurationProvider({
                workspaceBrowse: configurationCache.customConfigurationProvider.workspaceBrowse,
                // Trick to read a map from json
                fileIndex: new Map<string, cpptools.SourceFileConfigurationItem>(configurationCache.customConfigurationProvider.fileIndex)
            });

            telemetry.endSpanWithStatus(span, SpanStatusCode.OK, undefined, {
                lcstats: [
                    configurationCache.customConfigurationProvider.workspaceBrowse.browsePath.length,
                    configurationCache.customConfigurationProvider.fileIndex.length,
                ]});
        } catch (e) {
            telemetry.logException(e, span);
            logger.message("An error occured while parsing the configuration cache.");
            telemetry.endSpanWithStatus(span, SpanStatusCode.ERROR, "parsing");
        }
        elapsedTime = util.elapsedTimeSince(startTime);
        logger.message(`Load configuration from cache elapsed time: ${elapsedTime}`, "Verbose");

        extension.updateCppToolsProvider();

        // Log all the files read from cache after elapsed time is calculated.
        // IntelliSense should be available by now for all files.
        // Don't await for this logging step. This may produce some interleaved output
        // but it will still be readable.
        fc.cppConfigurationProvider.logConfigurationProviderComplete();
    } else {
        telemetry.endSpanWithStatus(span, SpanStatusCode.ERROR, "nodata");
        return {
            retc: ConfigureBuildReturnCodeTypes.notFound,
            elapsed: 0
        };
    }

    return {
        retc: ConfigureBuildReturnCodeTypes.success,
        elapsed: elapsedTime
    };
}

// Update IntelliSense and launch targets with information parsed from a user given build log,
// the dryrun cache or make dryrun output if the cache is not present.
// Sometimes the targets do not need an update (for example, when there has been
// a change in the current build target), as requested through the boolean.
// This saves unnecessary parsing which may be signifficant for very big code bases.
export async function doConfigure(readCache: boolean, cacheFile: string, recursiveDoConfigure: boolean = false, span: Span, fc: FolderConfig): Promise<ConfigureSubphasesStatus> {
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
        subphaseStats.loadFromCache = await loadConfigurationFromCache(fc, cacheFile, span);
    } else {
        logger.message("Loading configurations from cache is not necessary.", "Verbose");
    }

    telemetry.setAttributes(span, {
            proj: fc.pkginfo?.name ?? fc.folder.name,
            ver: fc.pkginfo?.version,
            am: fc.pkginfo?.automake.split("-").slice(-1)[0],
        });
    // This generates the dryrun output (saving it on disk) or reads an alternative build log.
    // Timings for this sub-phase happen inside.
    subphaseStats.generateParseContent = await generateParseContent(span, fc);

    switch (subphaseStats.generateParseContent.retc) {
        case ConfigureBuildReturnCodeTypes.success:
            telemetry.setSpanStatus(span, SpanStatusCode.OK); break;
        default: // Status and explanation should have been set in generateParseContent
            ;
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
    results: Map<number, TRS>;
    global: TRS;
};

export const TRS_Info: { [key: number]: vscode.FileDecoration } = {
    [TRS.NONE]:  { tooltip: 'n/a',   badge: '❔' },
    [TRS.XPASS]: { tooltip: 'XPASS', badge: '☑️' },
    [TRS.PASS]:  { tooltip: 'PASS',  badge: '✔️' },
    [TRS.SKIP]:  { tooltip: 'SKIP',  badge: '⤵️' },
    [TRS.ERROR]: { tooltip: 'ERROR', badge: '🔺' /* '⚠' */},
    [TRS.FAIL]:  { tooltip: 'FAIL',  badge: '❌' },
    [TRS.XFAIL]: { tooltip: 'XFAIL', badge: '🏳️' },
    [7]: { tooltip: 'THROW',   badge: '⁉️' },
  };

export const TRSLookup : Map<string,TRS> = new Map([
    ["PASS", TRS.PASS],
    ["SKIP", TRS.SKIP],
    ["FAIL", TRS.FAIL],
    ["XFAIL", TRS.XFAIL],
    ["XPASS", TRS.XPASS],
    ["ERROR", TRS.ERROR],
    ["NONE", TRS.NONE],
]);
export function emptyRunStats() : number[] { return [0,0,0,0,0,0,0]; }
export function isSuspect(trs: TRS) : boolean
{
    return trs === TRS.ERROR || trs === TRS.XFAIL;
}

const noTRS : TestResult = { global: TRS.NONE, results: new Map<number, TRS>() };
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
export function readTRS(b: BuildTarget, fc: FolderConfig) : TestResult
{
    let te = fc.testEnvironments;
    let trs = path.join(fc.abs_top_builddir, b.builddir, path.basename(b.goal, ".log") + ".trs");
    let testResult: TestResult = { global: TRS.NONE, results: new Map<number, TRS>() };
    try {
        const fileContent = fs.readFileSync(trs, 'utf8');
        if (!fileContent)
            return noTRS;
        const lines = fileContent.split('\n');

        for (const line of lines) {
            if (line.startsWith(':test-result:')) {
                const result = line.split(' ', 4);
                if (result.length >= 3) {
                    let envid = parseInt(result[2],36);
                    if(te.some(e => e.hashCode == envid && (!e.dirs || e.dirs.includes(b.builddir))))
                        testResult.results.set(envid, TRSLookup.get(result[1]) || TRS.NONE);
                } else if (result.length == 2 && te.length == 1) {
                    /* If test environements are not in use, use the untagged result
                     * as the default environment's result
                     */
                    testResult.results.set(fc.currentTestEnvironment.hashCode, TRSLookup.get(result[1]) || TRS.NONE);
                }
            } else if (line.startsWith(':global-test-result:')) {
                testResult.global = TRSLookup.get(line.split(' ', 2)[1]) || TRS.NONE;
            }
        }
    }
    catch (e) {
        return noTRS; // File does not exist
    }
    return testResult;
}
