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
import { parse, quote } from '@mergesium/shell-quote';
// import  from '../extension';
import { extension, telemetry } from '../extension';
import { Making } from './tool';
import { Make, EnteringRE, CopyrightRE, ExecutingRE } from './gnumake';
import { SpanStatusCode } from '@opentelemetry/api';

export interface PreprocessDryRunOutputReturnType {
    retc: number;
    elapsed: number;
    result?: string;
}

export interface ToolInvocation {
    // how the makefile invokes the tool:
    // relative -to the makefile location- path, full path, explicit current directory or no path
    // also including the file name, with or without extension
    pathInMakefile: string;

    // a full path formed from the given current path and the path in makefile
    // plus the file name, with the extension appended (for windows)
    fullPath: string;

    // Libtool mode (compile, link)
    ltmode: string | undefined;

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

    toString() : string;
}

export class Tool implements ToolInvocation {
    constructor(pathInMakefile : string, fullPath: string, ltmode: string | undefined, found: boolean, argv: string[]) {
        this.pathInMakefile = pathInMakefile;
        this.fullPath = fullPath;
        this.ltmode = ltmode;
        this.found = found;
        this.argv = argv;
    }
    pathInMakefile: string;
    fullPath: string;
    ltmode: string | undefined; // libtool mode (compile, link)
    found: boolean;
    argv: string[];

    filterArgsExcluding(unwanted: string[]): string[] {
        let removedOptArg : boolean = true;
        // TODO: Avoid this song and dance with removing optargs by having Intellisense ignore the args it doesn't care about
        return this.argv
            .filter(a => !unwanted.find(excluded => {
                // Expect options with required parts have the optarg either attached to the opt
                // or the next word. For excluded opts, remove the opt and the optarg
                if (!removedOptArg) {
                    // if the optarg was not attached, this next word is it. remove it outright
                    removedOptArg = true;
                    return true;
                }
                removedOptArg = !((a == ("-" + excluded) || (a == "--" + excluded)));
                if (!removedOptArg)
                    return true;
                removedOptArg = a.startsWith("-" + excluded) || a.startsWith("--" + excluded + "=");
                if (removedOptArg)
                    return true;
                removedOptArg = !(a.startsWith("-" + excluded) || a.startsWith("--" + excluded));
                return !removedOptArg;
            }));
    }

    filterArgs(wanted: string): string[] {
        let isOptArg : boolean = false;
        return this.argv
            .map(a => {
                // Expect options with required parts have the optarg either attached to the opt
                // or the next word. For excluded opts, remove the opt and the optarg
                if (isOptArg) {
                    // if the optarg was not attached, this next word is it. remove it outright
                    isOptArg = false;
                    return a;
                }
                isOptArg = ((a == ("-" + wanted) || (a == "--" + wanted)));
                if (isOptArg)
                    return "";
                if (a.startsWith("-" + wanted)) return a.slice(wanted.length + 1);
                if (a.startsWith("--" + wanted + "=")) return a.slice(wanted.length + 3);
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
    toString(): string {
        return quote([this.fullPath, ...this.argv]);
    }
}

/**
 * Parse shell grammar (see Manpage bash "SHELL GRAMMAR") to obtain the arguments of a tool invocation,
 * eg the -D or -I options of a compiler.
 */
let failureReported : number = 0;
const failToParseTool : Tool = new Tool(
    "",
    ":", // toolFullPath,
    undefined,
    true, // toolFound,
    ["unknown-tool", "unknown-arg"]
);
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
        let entering = EnteringRE.exec(line);
        if (entering)
            return [ParserDisp.Enter, new Make(entering[1], this.make.root)];
        let copyright = CopyrightRE.test(line);
        if (copyright) {
            this.make.finish();
            return [ParserDisp.Leave, this];
        }

        let executing = ExecutingRE.exec(line);
        if (executing) {
            this.make.startExecuting(executing);
            return [ParserDisp.Leave, this];
        }
        // FIXME: line could be emitted by a script snippet, and it could throw the parser. try Catch here.
        try {
            let makes = new Making(parseToolCmd(line), this);
            if (makes.done())
                this.makes.push(makes);
        } catch (e) {
            if (failureReported < 6) {
                telemetry.logEvent("ParseFailed", {proj: extension.pkginfo?.name});
                telemetry.setSpanStatus(SpanStatusCode.ERROR, "ParseFailed");
                logger.message(`ERROR: Failed to parse recipe for '${this.make.file}'`, "Normal");
                if (!failureReported) logger.message('KB: ' + extension.kbUrlStatic.toString(true) + '#' + util.slugify(`config-parse-fail-${this.make.file}`), "Normal");
                this.makes.push(new Making([failToParseTool], this));
                failureReported++;
            }
        }
        return [ParserDisp.Leave, this];
    }
    push(sub: Parser) {
        if (sub instanceof Make) {
            // push the submakes to the parent make.
            //this.makes.forEach(m => this.make.push(m));
            this.make.push(sub);
        }
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

const LibtoolRE = /^[^\s]+ [^\s]+\/libtool .* (?:--mode=(\w+)) (.*)\s*$/;
const TickRe = /`[^`]*`/g;
// Parse a command line, removing comments, compound statements (||, &&)
// redirections, and unescaping shell escape sequences
function parseToolCmd(line: string) : Tool[] {
    line = line.replace(TickRe,'');
    let libtool_cmd = LibtoolRE.exec(line);
    let ltmode : string | undefined;
    if (libtool_cmd) {
        /* If this is is libtool, remove the VPATH test and everything before --mode=compile */
        line = libtool_cmd[2];
        ltmode = libtool_cmd[1];
        /* TODO : Use libtool_cmd[1] = compile | link */
    }
    let parsedCmdLine = parse(line);
    let tools : Tool[] = [];
    do {
        // FIXME:
        // "echo 9.4.114-6ec1f > .version-t && mv .version-t .version"
        // In this case, '.version-t' is considered a tool invocation
        // incorrectly
        let cmd = parsedCmdLine;
        let numArgs: number = parsedCmdLine.findIndex(v => typeof v !== "string");
        if (numArgs != -1)
            cmd = parsedCmdLine.slice(0, numArgs);
        parsedCmdLine = parsedCmdLine.slice(cmd.length+1);

        let tool = new Tool(
            // don't use join and neither paths/filenames processed above if we want to keep the exact text in the makefile
            // match[1] + match[2],
            "",
            "", // toolFullPath,
            ltmode,
            true, // toolFound,
            cmd as string[]
        );
        tool.fullPath = tool.argv.shift() || "";
        tools.push(tool);
    } while (parsedCmdLine.length)
    return tools;
}
