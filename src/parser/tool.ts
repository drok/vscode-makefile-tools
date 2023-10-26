// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import * as cpp from 'vscode-cpptools';
import * as ext from '../extension';
import * as logger from '../logger';
import * as make from '../make';
import * as path from 'path';
import * as util from '../util';
import * as vscode from 'vscode';
import * as shellParser from './shell';
import {parseLineAsTool, ToolInvocation} from './shell';
import { Parser, ParserDisp, EmptyLine } from '../parser';
import { Executing } from './shell';

// List of compiler tools plus the most common aliases cc and c++
// ++ needs to be escaped for the regular expression in parseLineAsTool.
// Versioning and cross compilers naming variations dont' need to be included in this list,
// they will be considered in the regular expression.
// If one compiler name is a substring of another, include it after in this list.
// todo: any other scenarios of aliases and symlinks
// that would make parseLineAsTool to not match the regular expression,
// therefore wrongly skipping over compilation lines?
const compilers: string[] = ["ccache", "clang\\+\\+", "clang-cl", "clang-cpp", "clang", "gcc", "gpp", "cpp", "icc", "cc", "icl", "cl", "g\\+\\+", "c\\+\\+"];
const linkers: string[] = ["ccache", "ilink", "link", "ld", "ccld", "gcc", "clang\\+\\+", "clang", "cc", "g\\+\\+", "c\\+\\+"];
// Language detection based on file extension (from GCC manpage)
// https://gcc.gnu.org/onlinedocs/gcc/Overall-Options.html
// Include only those extension which must be preprocessed. Those that should
// not be processed must not have defines interpreted by Intellisense.
const sourceFileExtensions_c: string[] = [".c", ".h"];
const sourceFileExtensions_cpp: string[] = [".cc", ".cpp", ".cxx", ".cpp", ".CPP", ".c++", ".C",
            ".hh", ".H", ".hp", ".hxx", ".hpp", ".HPP", ".h++", ".tcc"];

const chunkSize: number = 100;


const ObjectFileRE = /^.+\.(?:o|obj)$/;
export class Making implements Parser {
    static makeArgs(): string[] { return [
        // Nothing
    ];};
    constructor(tool : ToolInvocation, caller: Executing) {
        /* FIXME: this isCompiler() functionality is a placeholder */
        if(ObjectFileRE.test(caller.currentTarget)) {
            if (compilers.includes(path.basename(tool.fullPath)))
                 this.handleCompilerCommand(tool, caller.currentDir).then(() => {});
        } else {
            if (linkers.includes(path.basename(tool.fullPath)))
                this.handleLinkerCommand(tool, caller.currentDir).then(() => {});
        }
    }
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "")
            return [ParserDisp.Leave, this];
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
    done() : boolean { return true; }


    async handleCompilerCommand(compilerTool : ToolInvocation, currentPath : string): Promise<void> {
        // If ccache wraps the compiler, parse again the remaining command line and we should obtain
        // the real compiler name.
        //if (compilerTool && path.parse(compilerTool.pathInMakefile).name.endsWith("ccache")) {
        //    compilerTool = await shellParser.parseLineAsTool(line, compilers, currentPath);
        //}
        logger.message(`Found compiler command: ${compilerTool}`, "Verbose");


        // Compiler path is either what the makefile provides or found in the PATH environment variable or empty
        let compilerFullPath: string = compilerTool.fullPath || "";
        if (!compilerTool.found) {
            let toolBaseName: string = path.basename(compilerFullPath);
            compilerFullPath = path.join(util.toolPathInEnv(toolBaseName) || "", toolBaseName);
        }

        // Exclude switches that are being processed separately (I, FI, include, D, std)
        // and switches that don't affect IntelliSense but are causing errors.
        let compilerArgs = compilerTool.filterArgsExcluding(["I", "FI", "include", "D", "std", "MF"]);

        // Parse and log the includes, forced includes and the defines
        let includes = compilerTool.filterArgs('I');
        includes = await util.makeFullPaths(includes, currentPath);
        let forcedIncludes = compilerTool.filterArgs('FI');
        forcedIncludes = forcedIncludes.concat(compilerTool.filterArgs('include'));
        forcedIncludes = await util.makeFullPaths(forcedIncludes, currentPath);

        let defines = compilerTool.filterArgs('D');

        // Parse the IntelliSense mode
        // how to deal with aliases and symlinks (CC, C++), which can point to any toolsets
        let targetArchitecture: util.TargetArchitecture = getTargetArchitecture(compilerTool);
        let intelliSenseMode: util.IntelliSenseMode = getIntelliSenseMode(ext.extension.getCppToolsVersion(), compilerFullPath, targetArchitecture);

        // For windows, parse the sdk version
        let windowsSDKVersion: string | undefined = "";
        if (process.platform === "win32") {
            windowsSDKVersion = process.env["WindowsSDKVersion"];
        }

        // Parse the source files
        let file: string = compilerTool.argv[compilerTool.argv.length-1];
        file = await util.makeFullPath(file, currentPath);

        // The language represented by this compilation command (-x is for GCC)
        let xlanguage = compilerTool.filterArgs("x");
        let language: util.Language;
        if (xlanguage.length > 0) {
            switch (xlanguage[0]) {
                case "c":
                case "c-header":
                    language = "c";
                    break;
                case "c++":
                case "c++-header":
                    language = "cpp";
                    break;
            }
        // /TP and /TC (for cl.exe only) overwrite the meaning of the source files extensions
        } else if (compilerTool.hasArg(['TP'])) {
            language = "cpp";
        } else if (compilerTool.hasArg(['TC'])) {
            language = "c";
        } else {
            let ext = path.extname(file);
            if (sourceFileExtensions_c.includes(ext))
                language = "c";
            else if (sourceFileExtensions_cpp.includes(ext))
                language = "cpp";
        }

        // Parse the C/C++ standard as given in the compiler command line
        let standardStr: string | undefined = compilerTool.getArg("std");

        // If the command is compiling the same extension or uses -TC/-TP, send all the source files in one batch.
        if (language) {
                // More standard validation and defaults, in the context of the whole command.
            let standard: util.StandardVersion | undefined = parseStandard(ext.extension.getCppToolsVersion(), standardStr, language);

            ext.extension.buildCustomConfigurationProvider(
                { defines, includes, forcedIncludes, standard,
                    intelliSenseMode, compilerFullPath, compilerArgs, files: [file], windowsSDKVersion, currentPath,
                    line: compilerTool.argv.join(" ") });
        }
    } // handleCompilerCommand function

    async handleLinkerCommand(tool : ToolInvocation, currentPath : string): Promise<void> {

        // A target binary is usually produced by the linker with the /out or /o switch,
        // but there are several scenarios (for win32 Microsoft cl.exe)
        // when the compiler is producing an output binary directly (via the /Fe switch)
        // or indirectly (based on some naming default rules in the absence of /Fe)
        let linkerTargetBinary: string | undefined;
        let compilerTargetBinary: string | undefined;

        if (process.platform === "win32") {
            // If a cl.exe is not performing only an obj compilation, deduce the output executable if possible
            // Note: no need to worry about the DLL case that this extension doesn't support yet
            // since a compiler can produce implicitly only an executable.

            if (path.basename(tool.fullPath).startsWith("cl")) {
                if (!tool.hasArg(["c", "P", "E", "EP"])) {
                    logger.message("Found compiler command:\n" + tool, "Verbose");

                    // First read the value of the /Fe switch (for cl.exe)
                    compilerTargetBinary = tool.getArg("Fe");

                    // Then assume first object file base name (defined with /Fo) + exe
                    // The binary is produced in the same folder where the compiling operation takes place,
                    // and not in an eventual different obj path.
                    // Note: /Fo is not allowed on multiple sources compilations so there will be only one if found
                    // TODO: does autotools have this behaviour?
                    if (!compilerTargetBinary) {
                        let objFile: string | undefined = tool.getArg("Fo");
                        if (objFile) {
                            let parsedObjPath: path.ParsedPath = path.parse(objFile);
                            compilerTargetBinary = parsedObjPath.name + ".exe";
                            logger.message("The compiler command is not producing a target binary explicitly. Assuming " +
                                compilerTargetBinary + " from the first object passed in with /Fo", "Verbose");
                        }
                    } else {
                        logger.message("Producing target binary with /Fe: " + compilerTargetBinary, "Verbose");
                    }

                    // Then assume first source file base name + exe.
                    // The binary is produced in the same folder where the compiling operation takes place,
                    // and not in an eventual different source path.
                    // TODO: does autotools have this behaviour?
                    // if (!compilerTargetBinary) {
                    //     let srcFiles: string[] | undefined = parseFilesFromToolArguments(compilerTool.arguments, sourceFileExtensions);
                    //     if (srcFiles.length >= 1) {
                    //         let parsedSourcePath: path.ParsedPath = path.parse(srcFiles[0]);
                    //         compilerTargetBinary = parsedSourcePath.name + ".exe";
                    //         logger.message("The compiler command is not producing a target binary explicitly. Assuming " +
                    //             compilerTargetBinary + " from the first source file passed in", "Verbose");
                    //     }
                    // }
                }

                if (compilerTargetBinary) {
                    compilerTargetBinary = await util.makeFullPath(compilerTargetBinary, currentPath);
                }
            }
        }

        // TODO: implement launch support for DLLs and LIBs, besides executables.
        if (!tool.hasArg(["dll", "lib", "shared"])) {
            // Gcc/Clang tools can also perform linking so don't parse any output binary
            // if there are switches passed in to cause early stop of compilation: -c, -E, -S
            // (-o will not point to an executable)
            // Also, the ld switches -r and -Ur do not produce executables.
            if (!tool.hasArg(["c", "E", "S", "r", "Ur"])) {
                linkerTargetBinary = tool.getArg("o") ||
                    tool.getArg("out");
                logger.message("Found linker command: " + tool, "Verbose");

                if (!linkerTargetBinary) {
                    // For Microsoft link.exe, the default output binary takes the base name
                    // of the first file (obj, lib, etc...) that is passed to the linker.
                    // The binary is produced in the same folder where the linking operation takes place,
                    // and not in an eventual different obj/lib path.
                    if (process.platform === "win32" && path.basename(tool.fullPath).startsWith("link")) {
                        // TODO: does autotools include more than one obj/lib as output?
                        let file = tool.getArg("obj") || tool.getArg("lib");
                        if (file) {
                            let parsedPath: path.ParsedPath = path.parse(file);
                            let targetBinaryFromFirstObjLib: string = parsedPath.name + ".exe";
                            logger.message("The link command is not producing a target binary explicitly. Assuming " +
                                targetBinaryFromFirstObjLib + " based on first object passed in", "Verbose");
                            linkerTargetBinary = targetBinaryFromFirstObjLib;
                        }
                    } else {
                        // The default output binary from a linking operation is usually a.out on linux/mac,
                        // produced in the same folder where the toolset is run.
                        logger.message("The link command is not producing a target binary explicitly. Assuming a.out", "Verbose");
                        linkerTargetBinary = "a.out";
                    }
                }
            }

            if (linkerTargetBinary) {
                // Until we implement a more robust link target analysis
                // (like query-ing for the executable attributes),
                // we can safely assume that a ".la" file produced by libtool
                // is a library and not an executable binary.
                if (linkerTargetBinary.endsWith(".la")/* && dryRunOutputLines[index - 1] === "LIBTOOL_PATTERN"*/) {
                    linkerTargetBinary = undefined;
                } else {
                    linkerTargetBinary = util.removeSurroundingQuotes(linkerTargetBinary);
                    logger.message("Producing target binary: " + linkerTargetBinary, "Verbose");
                    linkerTargetBinary = await util.makeFullPath(linkerTargetBinary, currentPath);
                }
            }
        }

        // It is not possible to have compilerTargetBinary and linkerTargetBinary both defined,
        // because a dry-run output line cannot be a compilation and an explicit link at the same time.
        // (cl.exe with /link switch is split into two lines - cl.exe and link.exe - during dry-run preprocessing).
        // Also for gcc/clang, -o switch or the default output will be a .o in the presence of -c and an executable otherwise.
        let targetBinary: string | undefined = linkerTargetBinary || compilerTargetBinary;

        // Some "$" (without following open paranthesis) are still left in the preprocessed output,
        // because the configuraion provider parser may lose valid compilation lines otherwise.
        // Additionally, for linker commands, ignore any dollar if present in the target binary name.
        // We need to ignore the $ anywhere else in the linker command line so that we don't lose
        // valid target binaries.
        if (targetBinary && !targetBinary.includes("$")) {
            this.targetBinaries.push(targetBinary);

            // Include limited launch configuration, when only the binary is known,
            // in which case the execution path is defaulting to binary containing folder.
            // It is more likely that an invocation would succeed from that location
            // as opposed from any other (like the root) because of eventual dependencies
            // that very likely to be built in the same place.
            // and there are no args.
            let launchConfiguration: configuration.LaunchConfiguration = {
                binaryPath: targetBinary,
                cwd: path.parse(targetBinary).dir,
                binaryArgs: []
            };

            logger.message("Adding launch configuration:\n" + configuration.launchConfigurationToString(launchConfiguration), "Verbose");
            configuration.getLaunchConfigurations().push(launchConfiguration);
        }
    }; // handleLinkerCommand function

    targetBinaries: string[] = [];
}

// Helper that identifies system commands (cd, cd -, pushd, popd) and make.exe change directory switch (-C)
// to calculate the effect on the current path, also remembering the transition in the history stack.
// The current path is always the last one into the history.
async function currentPathAfterCommand(line: string, currentPathHistory: string[]): Promise<string[]> {
    line = line.trimLeft();
    line = line.trimRight();

    let lastCurrentPath: string = (currentPathHistory.length > 0) ? currentPathHistory[currentPathHistory.length - 1] : "";
    let newCurrentPath: string = "";

    if (line.startsWith('cd -') && !configuration.getIgnoreDirectoryCommands()) {
        // Swap the last two current paths in the history.
        if (lastCurrentPath) {
            currentPathHistory.pop();
        }

        let lastCurrentPath2: string = (currentPathHistory.length > 0) ? currentPathHistory.pop() || "" : lastCurrentPath;

        logger.message("Analyzing line: " + line, "Verbose");
        logger.message("CD- command: leaving directory " + lastCurrentPath + " and entering directory " + lastCurrentPath2, "Verbose");
        currentPathHistory.push(lastCurrentPath);
        currentPathHistory.push(lastCurrentPath2);
    } else if ((line.startsWith('popd') && !configuration.getIgnoreDirectoryCommands()) ||
               line.includes('Leaving directory')) {
        let lastCurrentPath: string = (currentPathHistory.length > 0) ? currentPathHistory[currentPathHistory.length - 1] : "";
        currentPathHistory.pop();
        let lastCurrentPath2: string = (currentPathHistory.length > 0) ? currentPathHistory[currentPathHistory.length - 1] : "";
        logger.message("Analyzing line: " + line, "Verbose");
        logger.message("POPD command or end of MAKE -C: leaving directory " + lastCurrentPath + " and entering directory " + lastCurrentPath2, "Verbose");
    } else if (line.startsWith('cd') && !configuration.getIgnoreDirectoryCommands()) {
        newCurrentPath = await util.makeFullPath(line.slice(3), lastCurrentPath);

        // For "cd-" (which toggles between the last 2 current paths),
        // we must always keep one previous current path in the history.
        // Don't pop if the history has only one path as of now,
        // even if this wasn't a pushd.
        if (currentPathHistory.length > 1) {
            currentPathHistory = [];
            currentPathHistory.push(lastCurrentPath);
        }

        currentPathHistory.push(newCurrentPath);
        logger.message("Analyzing line: " + line, "Verbose");
        logger.message("CD command: entering directory " + newCurrentPath, "Verbose");
    } else if (line.startsWith('pushd') && !configuration.getIgnoreDirectoryCommands()) {
        newCurrentPath = await util.makeFullPath(line.slice(6), lastCurrentPath);
        currentPathHistory.push(newCurrentPath);
        logger.message("Analyzing line: " + line, "Verbose");
        logger.message("PUSHD command: entering directory " + newCurrentPath, "Verbose");
    } else if (line.includes('Entering directory')) { // equivalent to pushd
        // The make switch print-directory wraps the folder in various ways.
        let match: RegExpMatchArray | null = line.match("(.*)(Entering directory ['`\"])(.*)['`\"]");
        if (match) {
            newCurrentPath = await util.makeFullPath(match[3], lastCurrentPath) || "";
        } else {
            newCurrentPath = "Could not parse directory";
        }

        logger.message("Analyzing line: " + line, "Verbose");
        logger.message("MAKE -C: entering directory " + newCurrentPath, "Verbose");
        currentPathHistory.push(newCurrentPath);
    }

    return currentPathHistory;
}

// Structure used to describe a compilation command. Reference documentation is
// hosted here https://clang.llvm.org/docs/JSONCompilationDatabase.html
export interface CompileCommand {
    directory: string;
    file: string;
    command: string;
    arguments?: string[];
    output?: string;
}

export interface CustomConfigProviderItem {
    defines: string[];
    includes: string[];
    forcedIncludes: string[];
    standard?: util.StandardVersion;
    intelliSenseMode?: util.IntelliSenseMode;
    compilerFullPath: string;
    compilerArgs: string[];
    files: string[];
    windowsSDKVersion?: string;
    currentPath: string;
    line: string;
}

// Parse the output of the make dry-run command in order to provide CppTools
// with information about includes, defines, compiler path....etc...
// as needed by CustomConfigurationProvider. In addition generate a
// CompileCommand entry for every file with a compiler invocation to build
// a compile_commands.json file.
export async function parseCustomConfigProvider(cancel: vscode.CancellationToken, dryRunOutputStr: string,
                                                statusCallback: (message: string) => void,
                                                onFoundCustomConfigProviderItem: (customConfigProviderItem: CustomConfigProviderItem) => void): Promise<number> {
    if (cancel.isCancellationRequested) {
        return make.ConfigureBuildReturnCodeTypes.cancelled;
    }

    logger.message('Parsing dry-run output for CppTools Custom Configuration Provider.', "Normal");

    // Current path starts with workspace root and can be modified
    // with prompt commands like cd, cd-, pushd/popd or with -C make switch
    let currentPath: string = util.getWorkspaceRoot();
    let currentPathHistory: string[] = [currentPath];

    // Read the dry-run output line by line, searching for compilers and directory changing commands
    // to construct information for the CppTools custom configuration
    let dryRunOutputLines: string[] = dryRunOutputStr.split("\n");
    let numberOfLines: number = dryRunOutputLines.length;
    let index: number = 0;
    let done: boolean = false;

    async function doParsingChunk(): Promise<void> {
        let chunkIndex: number = 0;
        while (index < numberOfLines && chunkIndex <= chunkSize) {
            if (cancel.isCancellationRequested) {
                break;
            }

            let line: string = dryRunOutputLines[index];

            statusCallback("Parsing for IntelliSense");
            currentPathHistory = await currentPathAfterCommand(line, currentPathHistory);
            currentPath = currentPathHistory[currentPathHistory.length - 1];

            let compilerTool: shellParser.ToolInvocation | undefined = await shellParser.parseLineAsTool(line, compilers, currentPath);

            // If ccache wraps the compiler, parse again the remaining command line and we should obtain
            // the real compiler name.
            if (compilerTool && path.parse(compilerTool.pathInMakefile).name.endsWith("ccache")) {
               line = line.replace(`${compilerTool.pathInMakefile}`, "");
               compilerTool = await shellParser.parseLineAsTool(line, compilers, currentPath);
            }

            if (compilerTool) {
                logger.message("Found compiler command: " + line, "Verbose");

                // Compiler path is either what the makefile provides or found in the PATH environment variable or empty
                let compilerFullPath: string = compilerTool.fullPath || "";
                if (!compilerTool.found) {
                    let toolBaseName: string = path.basename(compilerFullPath);
                    compilerFullPath = path.join(util.toolPathInEnv(toolBaseName) || "", toolBaseName);
                }

                // Exclude switches that are being processed separately (I, FI, include, D, std)
                // and switches that don't affect IntelliSense but are causing errors.
                let compilerArgs = compilerTool.filterArgsExcluding(["I", "FI", "include", "D", "std", "MF"]);

                // Parse and log the includes, forced includes and the defines
                let includes = compilerTool.filterArgs('I');
                includes = await util.makeFullPaths(includes, currentPath);
                let forcedIncludes = compilerTool.filterArgs('FI');
                forcedIncludes = forcedIncludes.concat(compilerTool.filterArgs('include'));
                forcedIncludes = await util.makeFullPaths(forcedIncludes, currentPath);

                let defines = compilerTool.filterArgs('D');

                // Parse the IntelliSense mode
                // how to deal with aliases and symlinks (CC, C++), which can point to any toolsets
                let targetArchitecture: util.TargetArchitecture = getTargetArchitecture(compilerTool);
                let intelliSenseMode: util.IntelliSenseMode = getIntelliSenseMode(ext.extension.getCppToolsVersion(), compilerFullPath, targetArchitecture);

                // For windows, parse the sdk version
                let windowsSDKVersion: string | undefined = "";
                if (process.platform === "win32") {
                    windowsSDKVersion = process.env["WindowsSDKVersion"];
                }

                // Parse the source files
                let file: string = compilerTool.argv[compilerTool.argv.length-1];
                file = await util.makeFullPath(file, currentPath);

                // The language represented by this compilation command (-x is for GCC)
                let xlanguage = compilerTool.filterArgs("x");
                let language: util.Language;
                if (xlanguage.length > 0) {
                    switch (xlanguage[0]) {
                        case "c":
                        case "c-header":
                            language = "c";
                            break;
                        case "c++":
                        case "c++-header":
                            language = "cpp";
                            break;
                    }
                // /TP and /TC (for cl.exe only) overwrite the meaning of the source files extensions
                } else if (compilerTool.hasArg(['TP'])) {
                    language = "cpp";
                } else if (compilerTool.hasArg(['TC'])) {
                    language = "c";
                } else {
                    let ext = path.extname(file);
                    if (sourceFileExtensions_c.includes(ext))
                        language = "c";
                    else if (sourceFileExtensions_cpp.includes(ext))
                        language = "cpp";
                }

                // Parse the C/C++ standard as given in the compiler command line
                let standardStr: string | undefined = compilerTool.getArg("std");

                // If the command is compiling the same extension or uses -TC/-TP, send all the source files in one batch.
                if (language) {
                        // More standard validation and defaults, in the context of the whole command.
                    let standard: util.StandardVersion | undefined = parseStandard(ext.extension.getCppToolsVersion(), standardStr, language);

                    if (ext.extension) {
                        onFoundCustomConfigProviderItem({ defines, includes, forcedIncludes, standard, intelliSenseMode, compilerFullPath, compilerArgs, files: [file], windowsSDKVersion, currentPath, line });
                    }
                }
            } // if (compilerTool) {

            index++;
            if (index === numberOfLines) {
                done = true;
            }

            chunkIndex++;
        } // while loop
    } // doParsingChunk function

    while (!done) {
        if (cancel.isCancellationRequested) {
            break;
        }

        await util.scheduleAsyncTask(doParsingChunk);
    }

    return cancel.isCancellationRequested ? make.ConfigureBuildReturnCodeTypes.cancelled : make.ConfigureBuildReturnCodeTypes.success;
}

// Parse the output of the make dry-run command in order to provide VS Code debugger
// with information about binaries, their execution paths and arguments
export async function parseLaunchConfigurations(cancel: vscode.CancellationToken, dryRunOutputStr: string,
                                                statusCallback: (message: string) => void,
                                                onFoundLaunchConfiguration: (launchConfiguration: configuration.LaunchConfiguration) => void): Promise<number> {
    if (cancel.isCancellationRequested) {
        return make.ConfigureBuildReturnCodeTypes.cancelled;
    }

    // Current path starts with workspace root and can be modified
    // with prompt commands like cd, cd-, pushd/popd or with -C make switch
    let currentPath: string = util.getWorkspaceRoot();
    let currentPathHistory: string[] = [currentPath];

    // array of full path executables built by this makefile
    let targetBinaries: string[] = [];

    // The first pass of reading the dry-run output, line by line
    // searching for compilers, linkers and directory changing commands
    // to construct information for the launch configuration
    let dryRunOutputLines: string[] = dryRunOutputStr.split("\n");
    let numberOfLines: number = dryRunOutputLines.length;
    let index: number = 0;
    let done: boolean = false;
    let doLinkCommandsParsingChunk: (() => Promise<void>) = async () => {
        let chunkIndex: number = 0;
        while (index < numberOfLines && chunkIndex <= chunkSize) {
            if (cancel.isCancellationRequested) {
                break;
            }

            let line: string = dryRunOutputLines[index];

            statusCallback("Parsing for launch targets: inspecting for link commands");
            currentPathHistory = await currentPathAfterCommand(line, currentPathHistory);
            currentPath = currentPathHistory[currentPathHistory.length - 1];

            // A target binary is usually produced by the linker with the /out or /o switch,
            // but there are several scenarios (for win32 Microsoft cl.exe)
            // when the compiler is producing an output binary directly (via the /Fe switch)
            // or indirectly (based on some naming default rules in the absence of /Fe)
            let linkerTargetBinary: string | undefined;
            let compilerTargetBinary: string | undefined;

            if (process.platform === "win32") {
                let compilerTool: shellParser.ToolInvocation | undefined = await shellParser.parseLineAsTool(line, compilers, currentPath);
                if (compilerTool) {
                    // If a cl.exe is not performing only an obj compilation, deduce the output executable if possible
                    // Note: no need to worry about the DLL case that this extension doesn't support yet
                    // since a compiler can produce implicitly only an executable.

                    if (path.basename(compilerTool.fullPath).startsWith("cl")) {
                        if (!compilerTool.hasArg(["c", "P", "E", "EP"])) {
                            logger.message("Found compiler command:\n" + line, "Verbose");

                            // First read the value of the /Fe switch (for cl.exe)
                            compilerTargetBinary = compilerTool.getArg("Fe");

                            // Then assume first object file base name (defined with /Fo) + exe
                            // The binary is produced in the same folder where the compiling operation takes place,
                            // and not in an eventual different obj path.
                            // Note: /Fo is not allowed on multiple sources compilations so there will be only one if found
                            // TODO: does autotools have this behaviour?
                            if (!compilerTargetBinary) {
                                let objFile: string | undefined = compilerTool.getArg("Fo");
                                if (objFile) {
                                    let parsedObjPath: path.ParsedPath = path.parse(objFile);
                                    compilerTargetBinary = parsedObjPath.name + ".exe";
                                    logger.message("The compiler command is not producing a target binary explicitly. Assuming " +
                                        compilerTargetBinary + " from the first object passed in with /Fo", "Verbose");
                                }
                            } else {
                                logger.message("Producing target binary with /Fe: " + compilerTargetBinary, "Verbose");
                            }

                            // Then assume first source file base name + exe.
                            // The binary is produced in the same folder where the compiling operation takes place,
                            // and not in an eventual different source path.
                            // TODO: does autotools have this behaviour?
                            // if (!compilerTargetBinary) {
                            //     let srcFiles: string[] | undefined = parseFilesFromToolArguments(compilerTool.arguments, sourceFileExtensions);
                            //     if (srcFiles.length >= 1) {
                            //         let parsedSourcePath: path.ParsedPath = path.parse(srcFiles[0]);
                            //         compilerTargetBinary = parsedSourcePath.name + ".exe";
                            //         logger.message("The compiler command is not producing a target binary explicitly. Assuming " +
                            //             compilerTargetBinary + " from the first source file passed in", "Verbose");
                            //     }
                            // }
                        }
                    }

                    if (compilerTargetBinary) {
                        compilerTargetBinary = await util.makeFullPath(compilerTargetBinary, currentPath);
                    }
                }
            }

            let linkerTool: shellParser.ToolInvocation | undefined = await shellParser.parseLineAsTool(line, linkers, currentPath);
            if (linkerTool) {
                // TODO: implement launch support for DLLs and LIBs, besides executables.
                if (!linkerTool.hasArg(["dll", "lib", "shared"])) {
                    // Gcc/Clang tools can also perform linking so don't parse any output binary
                    // if there are switches passed in to cause early stop of compilation: -c, -E, -S
                    // (-o will not point to an executable)
                    // Also, the ld switches -r and -Ur do not produce executables.
                    if (!linkerTool.hasArg(["c", "E", "S", "r", "Ur"])) {
                        linkerTargetBinary = linkerTool.getArg("o") ||
                            linkerTool.getArg("out");
                        logger.message("Found linker command: " + line, "Verbose");

                        if (!linkerTargetBinary) {
                            // For Microsoft link.exe, the default output binary takes the base name
                            // of the first file (obj, lib, etc...) that is passed to the linker.
                            // The binary is produced in the same folder where the linking operation takes place,
                            // and not in an eventual different obj/lib path.
                            if (process.platform === "win32" && path.basename(linkerTool.fullPath).startsWith("link")) {
                                // TODO: does autotools include more than one obj/lib as output?
                                let file = linkerTool.getArg("obj") || linkerTool.getArg("lib");
                                if (file) {
                                    let parsedPath: path.ParsedPath = path.parse(file);
                                    let targetBinaryFromFirstObjLib: string = parsedPath.name + ".exe";
                                    logger.message("The link command is not producing a target binary explicitly. Assuming " +
                                        targetBinaryFromFirstObjLib + " based on first object passed in", "Verbose");
                                    linkerTargetBinary = targetBinaryFromFirstObjLib;
                                }
                            } else {
                                // The default output binary from a linking operation is usually a.out on linux/mac,
                                // produced in the same folder where the toolset is run.
                                logger.message("The link command is not producing a target binary explicitly. Assuming a.out", "Verbose");
                                linkerTargetBinary = "a.out";
                            }
                        }
                    }

                    if (linkerTargetBinary) {
                        // Until we implement a more robust link target analysis
                        // (like query-ing for the executable attributes),
                        // we can safely assume that a ".la" file produced by libtool
                        // is a library and not an executable binary.
                        if (linkerTargetBinary.endsWith(".la") && dryRunOutputLines[index - 1] === "LIBTOOL_PATTERN") {
                            linkerTargetBinary = undefined;
                        } else {
                            linkerTargetBinary = util.removeSurroundingQuotes(linkerTargetBinary);
                            logger.message("Producing target binary: " + linkerTargetBinary, "Verbose");
                            linkerTargetBinary = await util.makeFullPath(linkerTargetBinary, currentPath);
                        }
                    }
                }
            }

            // It is not possible to have compilerTargetBinary and linkerTargetBinary both defined,
            // because a dry-run output line cannot be a compilation and an explicit link at the same time.
            // (cl.exe with /link switch is split into two lines - cl.exe and link.exe - during dry-run preprocessing).
            // Also for gcc/clang, -o switch or the default output will be a .o in the presence of -c and an executable otherwise.
            let targetBinary: string | undefined = linkerTargetBinary || compilerTargetBinary;

            // Some "$" (without following open paranthesis) are still left in the preprocessed output,
            // because the configuraion provider parser may lose valid compilation lines otherwise.
            // Additionally, for linker commands, ignore any dollar if present in the target binary name.
            // We need to ignore the $ anywhere else in the linker command line so that we don't lose
            // valid target binaries.
            if (targetBinary && !targetBinary.includes("$")) {
                targetBinaries.push(targetBinary);

                // Include limited launch configuration, when only the binary is known,
                // in which case the execution path is defaulting to binary containing folder.
                // It is more likely that an invocation would succeed from that location
                // as opposed from any other (like the root) because of eventual dependencies
                // that very likely to be built in the same place.
                // and there are no args.
                let launchConfiguration: configuration.LaunchConfiguration = {
                    binaryPath: targetBinary,
                    cwd: path.parse(targetBinary).dir,
                    binaryArgs: []
                };

                logger.message("Adding launch configuration:\n" + configuration.launchConfigurationToString(launchConfiguration), "Verbose");
                configuration.getLaunchConfigurations().push(launchConfiguration);
                onFoundLaunchConfiguration(launchConfiguration);
            }

            index++;
            if (index === numberOfLines) {
                done = true;
            }

            chunkIndex++;
        } // while loop
    }; // doLinkCommandsParsingChunk function

    while (!done) {
        if (cancel.isCancellationRequested) {
            return make.ConfigureBuildReturnCodeTypes.cancelled;
        }

        await util.scheduleAsyncTask(doLinkCommandsParsingChunk);
    }

    // If no binaries are found to be built, there is no point in parsing for invoking targets
    if (targetBinaries.length === 0) {
        return cancel.isCancellationRequested ? make.ConfigureBuildReturnCodeTypes.cancelled : make.ConfigureBuildReturnCodeTypes.success;
    }

    // For each of the built binaries identified in the dry-run pass above,
    // search the makefile for possible targets that are invoking them,
    // to update the launch configuration with their name, full path, execution path and args.
    // If a built binary is not having an execution target defined in the makefile,
    // the launch configuration will be limited to the version having only with their name and path,
    // workspace folder instead of another execution path and zero args.
    // If this is not sufficient, the user can at any time write an execution target
    // in the makefile or write a launch configuration in the settings json.

    // TODO: investigate the scenario when the binary is run relying on path environment variable
    // and attention to on the fly environment changes made by make.

    // Reset the current path since we are going to analyze path transitions again
    // with this second pass through the dry-run output lines,
    // while building the launch custom provider data.
    currentPath = util.getWorkspaceRoot();
    currentPathHistory = [currentPath];

    // Since an executable can be called without its extension,
    // on Windows only and only for extensions 'exe',
    // create a new array with target binaries names
    // to ensure we parse right these binaries invocation right.
    let targetBinariesNames: string[] = [];
    targetBinaries.forEach(target => {
        let parsedPath: path.ParsedPath = path.parse(target);
        if (!targetBinariesNames.includes(parsedPath.name)) {
            if (process.platform === "win32" && parsedPath.ext === "exe") {
                targetBinariesNames.push(util.escapeString(parsedPath.name));
            } else {
                targetBinariesNames.push(util.escapeString(parsedPath.base));
            }
        }
    });

    index = 0;
    done = false;
    let doBinaryInvocationsParsingChunk: (() => Promise<void>) = async () => {
        let chunkIndex: number = 0;
        while (index < numberOfLines && chunkIndex <= chunkSize) {
            if (cancel.isCancellationRequested) {
                break;
            }

            let line: string = dryRunOutputLines[index];
            // Some "$" (without following open paranthesis) are still left in the preprocessed output,
            // because the configuraion provider parser may lose valid compilation lines otherwise.
            // But the binary invocations parser should ignore any dollar because the extension can't resolve
            // these anyway, wherever they are (current folder, binary name or arguments).
            if (!line.includes("$")) {
                statusCallback("Parsing for launch targets: inspecting built binary invocations");
                currentPathHistory = await currentPathAfterCommand(line, currentPathHistory);
                currentPath = currentPathHistory[currentPathHistory.length - 1];

                // Currently, the target binary invocation will not be identified if the line does not start with it,
                // because we need to be able to reject matches like "link.exe /out:mybinary.exe".
                // See comment in parseLineAsTool about not understanding well what it is that prepends
                // the target binary tool, unless we treat it as a path and verify its location on disk.
                // Because of this limitation, the extension might not present to the user
                // all the scenarios of arguments defined in the makefile for this target binary.
                // TODO: identify and parse properly all the valid scenarios of invoking a taget binary in a makefile:
                //       - @if (not) exist binary binary arg1 arg2 arg3
                //         (because an "@if exist" is not resolved by the dry-run and appears in the output)
                //       - cmd /c binary arg1 arg2 arg3
                //       - start binary
                let targetBinaryTool: shellParser.ToolInvocation | undefined = await shellParser.parseLineAsTool(line, targetBinariesNames, currentPath);

                // If the found target binary invocation does not happen from a location
                // where it was built previously, don't include it as a launch target.
                // We can debug only what was built. Also, it's quite common to run
                // tools from the path during the build and we shouldn't launch those.
                if (targetBinaryTool) {
                    let foundTargetBinary: boolean = false;
                    targetBinaries.forEach(target => {
                        if (target === targetBinaryTool?.fullPath) {
                            foundTargetBinary = true;
                        }
                    });

                    if (!foundTargetBinary) {
                        targetBinaryTool = undefined;
                    }
                }

                if (targetBinaryTool) {
                    logger.message("Found binary execution command: " + line, "Verbose");
                    let launchConfiguration: configuration.LaunchConfiguration = {
                        binaryPath: targetBinaryTool.fullPath,
                        cwd: currentPath,
                        binaryArgs: targetBinaryTool.argv
                    };

                    logger.message("Adding launch configuration:\n" + configuration.launchConfigurationToString(launchConfiguration), "Verbose");
                    onFoundLaunchConfiguration(launchConfiguration);
                }
            }

            index++;
            if (index === numberOfLines) {
                done = true;
            }

            chunkIndex++;
        } // while loop
    }; // doBinaryInvocationsParsingChunk function

    while (!done) {
        if (cancel.isCancellationRequested) {
            break;
        }

        await util.scheduleAsyncTask(doBinaryInvocationsParsingChunk);
    }

    return cancel.isCancellationRequested ? make.ConfigureBuildReturnCodeTypes.cancelled : make.ConfigureBuildReturnCodeTypes.success;
}

/**
 * Determine the IntelliSenseMode based on hints from compiler path
 * and target architecture parsed from compiler flags.
 */
function getIntelliSenseMode(cppVersion: cpp.Version | undefined, compilerPath: string, targetArch: util.TargetArchitecture): util.IntelliSenseMode {
    if (cppVersion && cppVersion >= cpp.Version.v5 && targetArch === undefined) {
        // IntelliSenseMode is optional for CppTools v5+ and is determined by CppTools.
        return undefined;
    }

    const canUseArm: boolean = (cppVersion !== undefined && cppVersion >= cpp.Version.v4);
    const compilerName: string = path.basename(compilerPath || "").toLocaleLowerCase();
    if (compilerName === 'cl.exe') {
        const clArch: string = path.basename(path.dirname(compilerPath)).toLocaleLowerCase();
        switch (clArch) {
            case 'arm64':
                return canUseArm ? 'msvc-arm64' : 'msvc-x64';
            case 'arm':
                return canUseArm ? 'msvc-arm' : 'msvc-x86';
            case 'x86':
                return 'msvc-x86';
            case 'x64':
            default:
                return 'msvc-x64';
        }
    } else if (compilerName.indexOf('armclang') >= 0) {
        switch (targetArch) {
            case 'arm64':
                return canUseArm ? 'clang-arm64' : 'clang-x64';
            case 'arm':
            default:
                return canUseArm ? 'clang-arm' : 'clang-x86';
        }
    } else if (compilerName.indexOf('clang') >= 0) {
        switch (targetArch) {
            case 'arm64':
                return canUseArm ? 'clang-arm64' : 'clang-x64';
            case 'arm':
                return canUseArm ? 'clang-arm' : 'clang-x86';
            case 'x86':
                return 'clang-x86';
            case 'x64':
            default:
                return 'clang-x64';
        }
    } else if (compilerName.indexOf('aarch64') >= 0) {
        // Compiler with 'aarch64' in its name may also have 'arm', so check for
        // aarch64 compilers before checking for ARM specific compilers.
        return canUseArm ? 'gcc-arm64' : 'gcc-x64';
    } else if (compilerName.indexOf('arm') >= 0) {
        return canUseArm ? 'gcc-arm' : 'gcc-x86';
    } else if (compilerName.indexOf('gcc') >= 0 || compilerName.indexOf('g++') >= 0) {
        switch (targetArch) {
            case 'x86':
                return 'gcc-x86';
            case 'x64':
            default:
                return 'gcc-x64';
        }
    } else {
        // unknown compiler; pick platform defaults.
        if (process.platform === 'win32') {
            return 'msvc-x64';
        } else if (process.platform === 'darwin') {
            return 'clang-x64';
        } else {
            return 'gcc-x64';
        }
    }
}

/**
 * Determine the target architecture from the compiler flags present in the given compilation command.
 */
function getTargetArchitecture(compiler: shellParser.ToolInvocation): util.TargetArchitecture {
    // Go through all the possible target architecture switches.
    // For each switch, apply a set of rules to identify the target arch.
    // The last switch wins.
    // TODO: This ought to work if there are no conflicting switches. But what if there are?
    let targetArch: util.TargetArchitecture; // this starts as undefined

    if (compiler.hasArg(["m32"])) {
        targetArch = "x86";
    } else if (compiler.hasArg(["m64"])) {
        targetArch = "x64";
    } else {
        let arch = compiler.getArg("arch") || compiler.getArg("target") || compiler.getArg("march");

        if (arch === "m32") {
            targetArch = "x86";
        } else if (arch === "m64") {
            targetArch = "x64";
        } else if (arch === "i686") {
            targetArch = "x86";
        } else if (arch === "amd64" || arch === "x86_64") {
            targetArch = "x64";
        } else if (arch === "aarch64" || arch === "armv8-a" || arch === "armv8.") {
            targetArch = "arm64";
        } else if (arch === "arm" || arch === "armv8-r" || arch === "armv8-m") {
            targetArch = "arm";
        } else {
            // Check if ARM version is 7 or earlier.
            const verStr: string | undefined = arch?.substr(5, 1);
            if (verStr) {
                const verNum: number = +verStr;
                if (verNum <= 7) {
                    targetArch = "arm";
                }
            }
        }
    }
    return targetArch;
}

export function parseStandard(cppVersion: cpp.Version | undefined, std: string | undefined, language: util.Language): util.StandardVersion | undefined {
    let canUseGnu: boolean = (cppVersion !== undefined && cppVersion >= cpp.Version.v4);
    let canUseCxx23: boolean = (cppVersion !== undefined && cppVersion >= cpp.Version.v6);
    let standard: util.StandardVersion | undefined;
    if (cppVersion && cppVersion >= cpp.Version.v5 && std === undefined) {
        // C/C++ standard is optional for CppTools v5+ and is determined by CppTools.
        return undefined;
    }

    if (!std) {
        // Standard defaults when no std switch is given
        if (language === "c") {
            return "c11";
        } else if (language === "cpp") {
            return "c++17";
        }
    } else if (language === "cpp") {
        standard = parseCppStandard(std, canUseGnu, canUseCxx23);
        if (!standard) {
            logger.message(`Unknown C++ standard control flag: ${std}`, "Normal");
        }
    } else if (language === "c") {
        standard = parseCStandard(std, canUseGnu);
        if (!standard) {
            logger.message(`Unknown C standard control flag: ${std}`, "Normal");
        }
    } else if (language === undefined) {
        standard = parseCppStandard(std, canUseGnu, canUseCxx23);
        if (!standard) {
            standard = parseCStandard(std, canUseGnu);
        }
        if (!standard) {
            logger.message(`Unknown standard control flag: ${std}`, "Normal");
        }
    } else {
        logger.message("Unknown language", "Normal");
    }

    return standard;
}

function parseCppStandard(std: string, canUseGnu: boolean, canUseCxx23: boolean): util.StandardVersion | undefined {
    const isGnu: boolean = canUseGnu && std.startsWith('gnu');
    if (std.endsWith('++23') || std.endsWith('++2b') || std.endsWith('++latest')) {
        if (canUseCxx23) {
            return isGnu ? 'gnu++23' : 'c++23';
        } else {
            return isGnu ? 'gnu++20' : 'c++20';
        }
    } else if (std.endsWith('++2a') || std.endsWith('++20')) {
      return isGnu ? 'gnu++20' : 'c++20';
    } else if (std.endsWith('++17') || std.endsWith('++1z')) {
      return isGnu ? 'gnu++17' : 'c++17';
    } else if (std.endsWith('++14') || std.endsWith('++1y')) {
      return isGnu ? 'gnu++14' : 'c++14';
    } else if (std.endsWith('++11') || std.endsWith('++0x')) {
      return isGnu ? 'gnu++11' : 'c++11';
    } else if (std.endsWith('++03')) {
      return isGnu ? 'gnu++03' : 'c++03';
    } else if (std.endsWith('++98')) {
      return isGnu ? 'gnu++98' : 'c++98';
    } else {
      return undefined;
    }
  }

  function parseCStandard(std: string, canUseGnu: boolean): util.StandardVersion | undefined {
    // GNU options from: https://gcc.gnu.org/onlinedocs/gcc/C-Dialect-Options.html#C-Dialect-Options
    const isGnu: boolean = canUseGnu && std.startsWith('gnu');
    if (/(c|gnu)(90|89|iso9899:(1990|199409))/.test(std)) {
      return isGnu ? 'gnu89' : 'c89';
    } else if (/(c|gnu)(99|9x|iso9899:(1999|199x))/.test(std)) {
      return isGnu ? 'gnu99' : 'c99';
    } else if (/(c|gnu)(11|1x|iso9899:2011)/.test(std)) {
      return isGnu ? 'gnu11' : 'c11';
    } else if (/(c|gnu)(17|18|iso9899:(2017|2018))/.test(std)) {
      if (canUseGnu) {
        // cpptools supports 'c17' in same version it supports GNU std.
        return isGnu ? 'gnu17' : 'c17';
      } else {
        return 'c11';
      }
    } else {
      return undefined;
    }
  }

// Structure used to describe a compilation command. Reference documentation is
// hosted here https://clang.llvm.org/docs/JSONCompilationDatabase.html
export interface CompileCommand {
    directory: string;
    file: string;
    command: string;
    arguments?: string[];
    output?: string;
}
