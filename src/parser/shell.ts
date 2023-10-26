// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import * as logger from '../logger';
import * as make from '../make';
import * as path from 'path';
import * as util from '../util';
import * as vscode from 'vscode';
import {Parser, ParserDisp} from '../parser';
import {parse} from 'shell-quote';
// import  from '../extension';
import { extension } from '../extension';
import { Making } from './tool';
import { Make } from './gnumake';

export interface PreprocessDryRunOutputReturnType {
    retc: number;
    elapsed: number;
    result?: string;
}

// Make various preprocessing transformations on the dry-run output
// TODO: "cmd -c", "start cmd", "exit"
export async function preprocessDryRunOutput(cancel: vscode.CancellationToken, dryRunOutputStr: string,
                                             statusCallback: (message: string) => void): Promise<PreprocessDryRunOutputReturnType> {
    let preprocessedDryRunOutputStr: string = dryRunOutputStr;

    if (cancel.isCancellationRequested) {
        return {
            retc: make.ConfigureBuildReturnCodeTypes.cancelled,
            elapsed: 0
        };
    }

    let startTime: number = Date.now();
    statusCallback("Preprocessing the dry-run output");

    // Array of tasks required to be executed during the preprocess configure phase
    let preprocessTasks: (() => void)[] = [];

    // Expand {REPO:VSCODE-MAKEFILE-TOOLS} to the full path of the root of the extension
    // This is used for the pre-created dry-run logs consumed by the tests,
    // in order to be able to have source files and includes for the test repro
    // within the test subfolder of the extension repo, while still exercising full paths for parsing
    // and not generating a different output with every new location where Makefile Tools is enlisted.
    // A real user scenario wouldn't need this construct.
    preprocessTasks.push(function (): void {
        if (process.env['MAKEFILE_TOOLS_TESTING'] === '1') {
            let extensionRootPath: string = path.resolve(__dirname, "../../");
            preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(/{REPO:VSCODE-MAKEFILE-TOOLS}/mg, extensionRootPath);
        }
    });

    // Some compiler/linker commands are split on multiple lines.
    // At the end of every intermediate line is at least a space, then a \ and end of line.
    // Concatenate all these lines to see clearly each command on one line.
    let regexp: RegExp = /\s+\\$\n/mg;
    preprocessTasks.push(function (): void {
        preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(regexp, " ");
    });

    // In case we parse a build log (as opposed to a dryrun log) for a project using libtool,
    // capture the compiler commands reported by the libtool output.
    // They may be redundant with the corresponding line from the dryrun (which is present in the build log as well)
    // but in case of $ variables and commands invoked on the fly, the second time all are resolved/expanded
    // and we can actually send good IntelliSense information for a good source code URL.
    // For such a case, look at MONO (git clone https://github.com/mono/mono.git), for source code cordxtra.c
    // Line with the original command, containing a 'test' command to determine on the fly the source code path.
    // This line is present in the dryrun and also in the build log. Can't easily parse the correct source code path.
    // /bin/bash ./libtool  --tag=CC   --mode=compile gcc -DHAVE_CONFIG_H   -I./include -I./include  -DGC_PTHREAD_START_STANDALONE    -fexceptions -Wall -Wextra -Wpedantic -Wno-long-long -g -O2 -fno-strict-aliasing  -MT cord/libcord_la-cordxtra.lo -MD -MP -MF cord/.deps/libcord_la-cordxtra.Tpo -c -o cord/libcord_la-cordxtra.lo `test -f 'cord/cordxtra.c' || echo './'`cord/cordxtra.c
    // Line with the resolved command, from which the extension can parse a valid source code path.
    // This line is present only in the build log, immediately following the above line.
    // libtool: compile:  gcc -DHAVE_CONFIG_H -I./include -I./include -DGC_PTHREAD_START_STANDALONE -fexceptions -Wall -Wextra -Wpedantic -Wno-long-long -g -O2 -fno-strict-aliasing -MT cord/libcord_la-cordxtra.lo -MD -MP -MF cord/.deps/libcord_la-cordxtra.Tpo -c cord/cordxtra.c  -fPIC -DPIC -o cord/.libs/libcord_la-cordxtra.o
    preprocessTasks.push(function (): void {
        regexp = /libtool: compile:|libtool: link:/mg;
        preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(regexp, "\nLIBTOOL_PATTERN\n");
    });

    // Process some more makefile output weirdness
    // When --mode=compile or --mode=link are present in a line, we can ignore anything that is before
    // and all that is after is a normal complete compiler or link command.
    // Replace these patterns with end of line so that the parser will see only the right half.
    preprocessTasks.push(function (): void {
        regexp = /--mode=compile|--mode=link/mg;
        preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(regexp, "\nLIBTOOL_PATTERN\n");
    });

    // Remove lines with $() since they come from unexpanded yet variables. The extension can't do anything yet
    // about them anyway and also there will be a correspondent line in the dryrun with these variables expanded.
    // Don't remove lines with $ without paranthesis, there are valid compilation lines that would be ignored otherwise.
    preprocessTasks.push(function (): void {
      regexp = /.*\$\(.*/mg;
      preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(regexp, "");
    });

    // Extract the link command
    // Keep the /link switch to the cl command because otherwise we will see compiling without /c
    // and we will deduce some other output binary based on its /Fe or /Fo or first source given,
    // instead of the output binary defined via the link operation (which will be parsed on the next line).
    // TODO: address more accurately the overriding scenarios between output files defined via cl.exe
    // and output files defined via cl.exe /link.
    // For example, "cl.exe source.cpp /Fetest.exe /link /debug" still produces test.exe
    // but cl.exe source.cpp /Fetest.exe /link /out:test2.exe produces only test2.exe.
    // For now, ignore any output binary rules of cl while having the /link switch.
    preprocessTasks.push(function (): void {
        if (process.platform === "win32") {
            preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(/ \/link /g, "/link \n link.exe ");
        }
    });

    // The splitting of multiple commands is better to be done at the end.
    // Oherwise, this scenario interferes with the line ending '\' in some cases
    // (see MAKE repo, ar.c compiler command, for example).
    // Split multiple commands concatenated by '&&'
    preprocessTasks.push(function (): void {
        preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(/ && /g, "\n");
    });

    // Split multiple commands concatenated by ";"
    preprocessTasks.push(function (): void {
        preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(/;/g, "\n");
    });

    // Replace multiple "-" sequence because it hangs the regular expression engine.
    // Strings with this pattern do not contain useful information to parse, they are safe to replace
    // in our internal representation of the dryrun or build log.
    // Replace with "- " instead of remove since this pattern does not cause hang or slow processing
    // and so that we have a similar view of the preprocessed text.
    preprocessTasks.push(function (): void {
      regexp = /------/mg;
      preprocessedDryRunOutputStr = preprocessedDryRunOutputStr.replace(regexp, "- - - - - - ");
  });

  // Loop through all the configure preprocess tasks, checking for cancel.
    for (const func of preprocessTasks) {
        await util.scheduleTask(func);

        if (cancel.isCancellationRequested) {
            return {
                retc: make.ConfigureBuildReturnCodeTypes.cancelled,
                elapsed: util.elapsedTimeSince(startTime)
            };
        }
    }

    return {
        retc: make.ConfigureBuildReturnCodeTypes.success,
        elapsed: util.elapsedTimeSince(startTime),
        result: preprocessedDryRunOutputStr
    };

    // TODO: Insert preprocessed files content

    // TODO: Wrappers (example: cl.cmd)
}

export interface ToolInvocation {
    // how the makefile invokes the tool:
    // relative -to the makefile location- path, full path, explicit current directory or no path
    // also including the file name, with or without extension
    pathInMakefile: string;

    // a full path formed from the given current path and the path in makefile
    // plus the file name, with the extension appended (for windows)
    fullPath: string;

    // if found at the full path resolved above
    found: boolean;

    // Array of parsed arguments, separated and unescaped from shell escaping
    argv: string[];

    // constructor(pathInMakefile : string, fullPath: string, found: boolean, argv: string[]) : ToolInvocation;

    // Helper to identify anything that looks like a compiler switch in the given command string.
    // The result is passed to IntelliSense custom configuration provider as compilerArgs.
    // excludeArgs helps with narrowing down the search, when we know for sure that we're not
    // interested in some switches. For example, -D, -I, -FI, -include, -std are treated separately.
    // Once we identified what looks to be the switches in the given command line, for each region
    // between two consecutive switches we let the shell parse it into arguments via a script invocation
    // (instead of us using other parser helpers in this module) to be in sync with how CppTools
    // expects the compiler arguments to be passed in.
    filterArgsExcluding(unwanted: string[]): string[];

    // Filter the argv list, keeping only the optargs of the wanted options
    // eg, if argv = -Ione/dir -Iother/dir -DBLAH
    // calling this filter with "I" would return [one/dir, other/dir]
    // ie, just the values of the named arguments.
    filterArgs(wanted: string): string[];

    // Helper that answers whether a particular switch is passed to the tool.
    // When calling this helper, we are not interested in obtaining the
    // (or there is no) value passed in via the switch.
    // There must be at least one space/tab before the switch,
    // so that we don't match a path by mistake.
    // Same after the switch, in case the given name is a substring
    // of another switch name. Or have the switch be the last in the command line.
    // Examples: we call this helper for /c compiler switch or /dll linker switch.
    // TODO: detect sets of switches that cancel each other to return a more
    // accurate result in case of override (example: /TC and /TP)
    hasArg(switches: string[]): boolean;

    // Find a named option argument, return its value
    getArg(wanted: string): string | undefined;
}

export class Tool implements ToolInvocation {
    constructor(pathInMakefile : string, fullPath: string, found: boolean, argv: string[]) {
        this.pathInMakefile = pathInMakefile;
        this.fullPath = fullPath;
        this.found = found;
        this.argv = argv;
    }
    pathInMakefile: string;
    fullPath: string;
    found: boolean;
    argv: string[];

    filterArgsExcluding(unwanted: string[]): string[] {
        let removedOptArg : boolean = true;
        // TODO: Avoid this song and dance with removing optargs by having Intellisense ignore the args it doesn't care about
        return this.argv
            .filter(arg => !unwanted.find(excluded => {
                // Expect options with required parts have the optarg either attached to the opt
                // or the next word. For excluded opts, remove the opt and the optarg
                if (!removedOptArg) {
                    // if the optarg was not attached, this next word is it. remove it outright
                    removedOptArg = true;
                    return true;
                }
                removedOptArg = !((arg == ("-" + excluded) || (arg == "--" + excluded)));
                if (!removedOptArg)
                    return true;
                removedOptArg = arg.startsWith("-" + excluded) || arg.startsWith("--" + excluded + "=");
                if (removedOptArg)
                    return true;
                removedOptArg = !(arg.startsWith("-" + excluded) || arg.startsWith("--" + excluded));
                return !removedOptArg;
            }));
    }

    filterArgs(wanted: string): string[] {
        let isOptArg : boolean = false;
        return this.argv
            .map(arg => {
                // Expect options with required parts have the optarg either attached to the opt
                // or the next word. For excluded opts, remove the opt and the optarg
                if (isOptArg) {
                    // if the optarg was not attached, this next word is it. remove it outright
                    isOptArg = false;
                    return arg;
                }
                isOptArg = ((arg == ("-" + wanted) || (arg == "--" + wanted)));
                if (isOptArg)
                    return "";
                if (arg.startsWith("-" + wanted)) return arg.slice(wanted.length + 1);
                if (arg.startsWith("--" + wanted + "=")) return arg.slice(wanted.length + 3);
                return "";
            })
            .filter(v => v !== "");
    }

    hasArg(switches: string[]): boolean {
        // - '-' or '/' or '--' as switch prefix
        // - one or more spaces/tabs after
        return this.argv.
            some(arg =>
                switches.some(sw => arg == "/" + sw || arg == "-" + sw || arg == "--" + sw));
    }

    getArg(wanted: string): string | undefined {
        let index = this.argv.findIndex(arg => arg == ("-" + wanted) || arg == ("--" + wanted));
        if (index >= 0 && this.argv.length > index + 1) {
            return this.argv[index + 1];
        }
        return undefined;
    }
}

// Helper that parses the given line as a tool invocation.
// The full path that is returned is calculated with the following logic:
//     - make a full path out of the one given in the makefile
//       and the current path that is calculated as of now
//     - if the tool is not found at the full path above and if requested,
//       it will be searched in all the paths of the PATH environment variable
//       and the first one found will be returned
// TODO: handle the following corner cases:
//     - quotes only around directory (file name outside quotes)
//     - path containing "toolName(no extension) " in the middle
export async function parseLineAsTool(
    line: string,
    toolNames: string[],
    currentPath: string,
    isCompilerOrLinker: boolean = true
): Promise<ToolInvocation | undefined> {
    // To avoid hard-coding (and ever maintaining) in the tools list
    // the various compilers/linkers that can have versions, prefixes or suffixes
    // in their names, include a crafted regex around each tool name.
    // Any number of prefix or suffix text, separated by '-'.
    let versionedToolNames: string[] = [];
    const prefixRegex: string = isCompilerOrLinker ? "(([a-zA-Z0-9-_.]*-)*" : "";
    const suffixRegex: string = isCompilerOrLinker ? "(-[a-zA-Z0-9-_.]*)*)" : "";
    toolNames.forEach(tool => {
        // Check if the user defined this tool as to be excluded
        if (!configuration.getExcludeCompilerNames()?.includes(tool)) {
            versionedToolNames.push(`${prefixRegex}${tool}${suffixRegex}`);
        }
    });

    // Add any additional tools specified by the user
    // when we are looking at compilers or linkers,
    // not when we parse for binary targets.
    if (isCompilerOrLinker) {
        configuration.getAdditionalCompilerNames()?.forEach(compiler => {
            if (!toolNames.includes(compiler)) {
                versionedToolNames.push(`${prefixRegex}${compiler}${suffixRegex}`);
            }
        });
    }

    // - any spaces/tabs before the tool invocation
    // - with or without path (relative -to the makefile location- or full)
    // - with or without extension (windows only)
    // - with or without quotes
    // - must have at least one space or tab after the tool invocation
    let regexpStr: string = '^[\\s\\"]*(.*?)(';
    if (process.platform === "win32") {
        regexpStr += versionedToolNames.join('\\.exe|');

        // ensure to append the extension for the last tool in the array since join didn't.
        if (versionedToolNames.length > 0) {
            regexpStr += ('\\.exe');
        }

        regexpStr += '|';
    }

    regexpStr += versionedToolNames.join('|') + ')(\\s|\\"\\s)(.*)$';

    let regexp: RegExp = RegExp(regexpStr, "mg");
    let match: RegExpExecArray | null = regexp.exec(line);

    if (!match) {
        return undefined;
    }

    let toolPathInMakefile: string = match[1];
    let toolNameInMakefile: string = match[2];
    if (process.platform === "win32" && !path.extname(toolNameInMakefile)) {
        toolNameInMakefile += ".exe";
    }

    // Quotes are not needed either for the compiler path or the current path.
    // checkFileExists works just fine without quotes,
    // but makeFullPath gets confused sometimes for some quotes scenarios.
    currentPath = util.removeQuotes(currentPath);
    toolPathInMakefile = toolPathInMakefile.trimLeft();
    toolPathInMakefile = util.removeQuotes(toolPathInMakefile);

    let toolFullPath: string = await util.makeFullPath(toolPathInMakefile + toolNameInMakefile, currentPath);
    let toolFound: boolean = util.checkFileExistsSync(toolFullPath);

    // Reject a regexp match that doesn't have a real path before the tool invocation,
    // like for example link.exe /out:cl.exe being mistakenly parsed as a compiler command.
    // Basically, only spaces and/or tabs and/or a valid path are allowed before the compiler name.
    // There is no other easy way to eliminate that case via the regexp
    // (it must accept a string before the tool).
    // For now, we consider a path as valid if it can be found on disk.
    // TODO: be able to recognize a string as a valid path even if it doesn't exist on disk,
    // in case the project has a setup phase that is copying/installing stuff (like the toolset)
    // and it does not have yet a build in place, therefore a path or file is not yet found on disk,
    // even if it is valid.
    // In other words, we allow the tool to not be found only if the makefile invokes it without any path,
    // which opens the possibility of searching the tool through all the paths in the PATH environment variable.
    // Note: when searching for execution targets in the makefile, if a binary was not previously built,
    // the extension will not detect it for a launch configuration because of this following return.
    if (toolPathInMakefile !== "" && !toolFound) {
        return undefined;
    }

    return new Tool(
        // don't use join and neither paths/filenames processed above if we want to keep the exact text in the makefile
        match[1] + match[2],
        toolFullPath,
        toolFound,
        parseToolArguments(match[match.length - 1])
    );
}


export class Executing implements Parser {
    // constructor(goal: string) { this.goal = goal; }
    static makeArgs(): string[] { return [
        // Automake uses the V variable to tell whether commands are output as
        // executed. See am__v_CC_ definition in Makefiles.
        // The default value can be set on the configure command line with V={0,1}
        // or in configure.ac with "AM_SILENT_RULES([yes])"
        // override whatever the default is.
        "V=1",
        // --trace does two things:
        // - outputs a preamble like "Makefile:388: update target 'main.o' due to: /hom..."
        //   before shell commands that are executed
        "--trace",
    ];};
    constructor(making: Make) {
        this.make = making;
    }
    ingest (line: string) : [ParserDisp, Parser] {

        if (line.endsWith("\\")) {
            this.linebuf += line.slice(0, -1);
            return [ParserDisp.Continue, this];
        } else if (this.linebuf) {
            line = this.linebuf + line;
            this.linebuf = "";
        }
        let makes = new Making(parseToolCmd(line), this);
        if (makes.done())
            this.makes.push(makes);
        return [ParserDisp.Leave, this];
    }
    push(sub: Parser) {
        return undefined;
    }
    // currentdir getter
    get currentDir(): string { return this.make.getDir(); }
    get currentTarget(): string { return this.make.getFile() || ""; }

    // goal: string;
    make: Make;
    makes: Making[] = [];
    // Line buffer for re-joining lines split with backslash
    linebuf : string = "";
}

function parseToolCmd(line: string) : Tool {
    let tool = new Tool(
        // don't use join and neither paths/filenames processed above if we want to keep the exact text in the makefile
        // match[1] + match[2],
        "",
        "", // toolFullPath,
        true, // toolFound,
        parseToolArguments(line)
    );
    tool.fullPath = tool.argv.shift() || "";
    return tool;
}
// Parse a command line, removing comments, compound statements (||, &&)
// redirections, and unescaping shell escape sequences
function parseToolArguments(args: string): string[] {
    let parsedCmdLine = parse(args);
    let numArgs: number = parsedCmdLine.findIndex(v => typeof v !== "string");
    numArgs = numArgs == -1 ? parsedCmdLine.length : numArgs + 1;
    let removedOptArg : boolean = true;
    // TODO: Avoid this song and dance with removing optargs by having Intellisense ignore the args it doesn't care about
    return (parsedCmdLine.slice(0, numArgs) as string[]);
}
