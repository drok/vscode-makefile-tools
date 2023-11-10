// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import * as logger from '../logger';
import * as make from '../make';
import * as util from '../util';
import * as vscode from 'vscode';
// import {CustomConfigProviderItem} from '../cpptools';
import {Parser, ParserDisp, EmptyLine } from '../parser';
import { Executing } from './shell';

const chunkSize: number = 100;

export async function parseTargets(cancel: vscode.CancellationToken, verboseLog: string,
                                   statusCallback: (message: string) => void,
                                   foundTargetCallback: (target: string) => void): Promise<number> {
    if (cancel.isCancellationRequested) {
        return make.ConfigureBuildReturnCodeTypes.cancelled;
    }

    // Extract the text between "# Files" and "# Finished Make data base" lines
    // There can be more than one matching section.
    let regexpExtract: RegExp = /(# Files\n*)([\s\S]*?)(\n# Finished Make data base)/mg;
    let result: RegExpExecArray | null;
    let extractedLog: string = "";

    let matches: string[] = [];
    let match: string[] | null;
    result = await util.scheduleTask(() => regexpExtract.exec(verboseLog));

    while (result) {
        extractedLog = result[2];

        // Skip lines starting with {#,.} or preceeded by "# Not a target" and extract the target.
        // Additionally, if makefile.phonyOnlyTargets is true, include only targets
        // succeeded by "#  Phony target (prerequisite of .PHONY).".
        let regexpTargetStr: string = "^(?!\\n?[#\\.])(?<!^\\n?# Not a target:\\s*)\\s*(\\S*[^:]):\\s+";
        if (configuration.getPhonyOnlyTargets()) {
         regexpTargetStr += ".*\\s+(?=#  Phony target \\(prerequisite of \\.PHONY\\)\\.)";
        }
        let regexpTarget: RegExp = RegExp(regexpTargetStr, "mg");

        match = regexpTarget.exec(extractedLog);

        if (match) {
            let done: boolean = false;
            let doParsingChunk: (() => void) = () => {
                let chunkIndex: number = 0;

                while (match && chunkIndex <= chunkSize) {
                    // Make sure we don't insert duplicates.
                    // They can be caused by the makefile syntax of defining variables for a target.
                    // That creates multiple lines with the same target name followed by :,
                    // which is the pattern parsed here.
                    if (!matches.includes(match[1])) {
                        matches.push(match[1]);
                        foundTargetCallback(match[1]);
                    }

                    statusCallback("Parsing build targets...");
                    match = regexpTarget.exec(extractedLog);

                    if (!match) {
                        done = true;
                    }

                    chunkIndex++;
                }
            };
            while (!done) {
                if (cancel.isCancellationRequested) {
                    return make.ConfigureBuildReturnCodeTypes.cancelled;
                }

                await util.scheduleTask(doParsingChunk);
            }
        } // if match

        result = await util.scheduleTask(() => regexpExtract.exec(verboseLog));
    } // while result

    return cancel.isCancellationRequested ? make.ConfigureBuildReturnCodeTypes.cancelled : make.ConfigureBuildReturnCodeTypes.success;
}

enum MakeSection {
    Starting, /* pre Entering directory */
    Making, /* update target... */
    Copyright, /* # GNU make 4.1 ... */
    Database, /* --print-data-base dump */
    Padding, /* Extra output I don't care about */
}
const EnteringRE = /^# make(?:\[\d+\])?: Entering directory '(.*)'$/;
const LeavingRE = /^# make(?:\[\d+\])?: Leaving directory '(.*)'$/;
const NothingRE = /^make(?:\[\d+\])?: Nothing to be done for '(.*)'\.$/;
const ExecutingRE = /^(.+):(\d+): (?:update target '(.*)' due to: (?:.*)|target '(.*)' does not exist)$/;
const UptodateRE = /^make(?:\[\d+\])?: '(.*)' is up to date\.$/;
const CopyrightRE = /^# GNU Make/;
const RecursingRE = /^Making (.*) in (.*)$/;
/**
 * Parse the stdout of a GNU make run, and expect a Dumped database,
 * directory entry/leaving trace messages, and expanded shell fragments would
 * be run when building the targets.
 * Calls Database, Executing parser to extract info about the current makefile,
 * and Make to parse submake output.
 */
export class Make implements Parser {
    constructor(dir: string)
    {
        this.dir = dir;
        this.section = dir ? MakeSection.Making : MakeSection.Starting;
    }
    static makeArgs(): string[] { return [
        // take precedence over other parallel executions
        // specified in makefiles
        "-j1", "--output-sync=recurse",
        "--print-directory",
        // automake makefiles don't rely on builtin rules, so this makes the evaluation
        // a little faster, but the user could force custom rules which do rely on
        // builtin rules. If this is the case, the build be evaluated unexpectedly.
        // Relying on builtin rules would make the config non-portable, as it would need
        // GNU make.
        // TODO: How to tell the user his config is non-portable? Maybe allow a setting
        // "Allow non-portable config" ?
        "--no-builtin-rules",
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        switch (this.section) {
            case MakeSection.Database:
                this.section = MakeSection.Padding;
                /* intentional fall-through, allows leaving immediately past Database */
            case MakeSection.Padding:
                let leaving = LeavingRE.test(line);
                if (leaving) {
                    return [ParserDisp.Leave, this];
                }
                break;
            case MakeSection.Making:
                // --assume-old targets are reported as nothing to be done.
                let nothing = NothingRE.test(line);
                if (nothing) {
                    return [ParserDisp.Continue, this];
                }
                let copyright = CopyrightRE.test(line);
                if (copyright) {
                    this.section = MakeSection.Copyright;
                    return [ParserDisp.Continue, this];
                }
                let executing = ExecutingRE.exec(line);
                if (executing) {
                    this.file = executing[3] || executing[4];
                    if (this.file == "config.status") {
                        // For some reason, reconfig was triggerred, meaning
                        // --dry-run was not respected. Abort. this is a bug.
                        throw new Error(`Unexpected reconfig in Make ${this.dir}. This is a bug.`);
                    }
                    return [ParserDisp.Enter, new Executing(this)];
                }
                let uptodate = UptodateRE.exec(line);
                if (uptodate)
                    return [ParserDisp.Continue, this];
                /* intentional fall-through, allows recursing subdirs */
            case MakeSection.Starting:
                let entering = EnteringRE.exec(line);
                if (entering) {
                    this.section = MakeSection.Making;
                    return [ParserDisp.Enter, new Make(entering[1])];
                }
                // this is for the 2nd and later script lines for a target
                if (this.section == MakeSection.Making) {
                    /* echo "Making $target in $subdir" is a script snippet of automake
                     * used to recurse into a subdir. The snipped is executed even in
                     * --dry-run mode. It's not make's output, but a shell command's stdout.
                     * Simply skip it and don't parse it as a shell execution line.
                     * No need to capture the target and directory (relative subdir), because
                     * the next "Entering" line will contain the full dir (make's output)
                     * the target name is an automake auxiliary target, and this hint could be
                     * used to exclude it from the subdir's target list
                     */
                    let recursing = RecursingRE.exec(line);
                    if (recursing)
                        return [ParserDisp.Continue, this];
                    let nextcmd = new Executing(this);
                    let [disp,next] = nextcmd.ingest(line);
                    if (disp == ParserDisp.Leave)
                        // The command is done. Look for more in the same make run.
                        return [ParserDisp.Continue, this];
                    return [disp, next];
                }
                break;
            case MakeSection.Copyright:
                let database = DatabaseRE.test(line);
                if (database) {
                    this.section = MakeSection.Database;
                    return [ParserDisp.Enter, new EmptyLine(new Database())];
                }
                break;
        }
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) : Parser | undefined {
        if (sub instanceof Database) {
            let targets = configuration.getAllBuildTargets();
            if (!targets.has(this.dir)) {
            //    let goals = new Set<string>(
            //        sub.goals.filter(g => g.goal).map<string>(g => g.goal || "")
            //    );
                targets.set(this.dir, sub.goals);
            }
            this.goals = sub.goals;
            return this;
        } else if (sub instanceof Make) {
            if (this == sub)
                throw new Error(`Unexpected push in Make ${sub}`);
            this.submake.push(sub);
            return this;
        } else if (sub instanceof Executing) {
            if (sub.makes.length) {
                // Do something about the collected command lines?
            }
            return this; // continue looking for more Executes
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in Make ${sub}`);
    }
    public getFile(): string | undefined {
        return this.file;
    }
    public getDir(): string {
        return this.dir;
    }
    dir: string;
    section: MakeSection;
    file: string | undefined;
    goals: Goal[] = [];
    submake: Make[] = [];
}

const DatabaseRE = /^# Make data base, printed on (.*)$/;
const FilesRE = /^# Files$/;
/**
 * Parse a GNU make database dump to extract the list of build goals (targets)
 */
export class Database implements Parser {
    // constructor() { this.goals = []; }
    static makeArgs(): string[] { return [
        "--print-data-base",
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        let files = FilesRE.exec(line);
        if (files)
            return [ParserDisp.Enter, new EmptyLine(new Goal())];
        return [ParserDisp.Continue, this];
            // throw new Error(`Unexpected line ${line}`);
    }
    push(sub: Parser) {
        if (sub instanceof Goal) {
            if (!sub.goal) { /* End-of-goals, at # files hash-table stats */
                return undefined;
            } else {
                /* Don't store automake auxiliary targets, they are thus
                 * unavailable for target selection */
                if (!(sub.flags & Goal.Flags.Automake_auxiliary))
                    this.goals.push(sub);
                return new Goal(); /* look for more Goals */
            }
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in ${sub}`);
    }
    goals : Goal[] = [];
}

const GoalInfoRe = /^#  (.*)$/;
// Lines which have variable content, but I don't need them
const GoalAckInfoRe = /^(?:Implicit\/static pattern stem:|Last modified)/;
const GoalVarsRe = /^# (?:automatic|. :=|variable set hash-table stats:|Load=)/;
const GoalFlagsRe = /^# (.*):$/;
const GoalRe = /^(.*):/;
const AutomakePrimaryRe = /^(?:all|check|distcheck|install)$/;
const GNUMakeAuxiliaryRe = new RegExp('^\.(?:' +
    '(PHONY|SUFFIXES|PRECIOUS|NOEXPORT|MAKE)' +
    ')$');
/* Auxiliary goals are internally used by automake. They are dropped by the parser */
const AutomakeAuxRe = /(?:-recursive|-am|config.status|Makefile|stamp-h1|am--refresh|^\.deps\/.*|^\.DEFAULT|^\.obj|^\.c|^\.o|depcomp|compile|missing|install-sh|Makefile.am)$/;
/* Noise targets are those a user most likely never wants to build from a gui */
const AutomakeNoiseRe = new RegExp('^(' +
    'ID|GTAGS|TAGS|CTAGS|tags|ctags|cscope|cscope\.files|cscopelist|' +
    'installdirs|distcleancheck|distuninstallcheck|distdir' +
    'mostlyclean|maintainer-clean-generic|mostlyclean-generic|clean-cscope|clean|' +
    'dist.*|uninstall-.*|install-.*|maintainer-.*|distclean-.*|' +
    'Makefile.in)$');
const GoalRecipeRe = /^recipe to execute \(from '(.*)', line (\d+)\):/;
const GoalsEndRe = /^# files hash-table stats:$/;
/**
 * Parse information about a single goal, differentiating phony targets,
 * and expandable to handle other flags that Make keeps about each target
 * (eg, whether it is up-to-date). Calls the Recipe to parse the build recipe
 * if any.
 */
export class Goal implements Parser {
    public static readonly Flags = {
        None: 0,
        /* Flags gathered from Make (phony, etc) */
        Not_a_target: 1,

        /* Well-known automake targets */
        Automake_primary: 2,
        Automake_auxiliary: 4,
        Automake_noise: 8,


        /* Flags gathered from automake (recipe hints like $(LINK) */
        Linked_binary: 256,
        Static_library: 512,
    };
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.goal)
                throw new Error("Unexpected end of goal");
            return [ParserDisp.Leave, this];
        } else {
            if (!this.goal) {
                let flags = GoalFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "Not a target":
                            this.flags |= Goal.Flags.Not_a_target;
                            return [ParserDisp.Continue, this];
                        default:
                            if (GoalsEndRe.test(line))
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected Goal Flags ${flags[1]}`);
                        }
                }
            } else {
                let info = GoalInfoRe.exec(line);
                if (info) {
                    switch (info[1]) {
                        case "Command line target.":
                        case "File does not exist.":
                        case "File has been updated.":
                        case "File has not been updated.":
                        case "File is very old.":
                        case "Implicit rule search has been done.":
                        case "Implicit rule search has not been done.":
                        case "Modification time never checked.":
                        case "Phony target (prerequisite of .PHONY).":
                        case "Precious file (prerequisite of .PRECIOUS).":
                        case "Successfully updated.":
                            return [ParserDisp.Continue, this];
                        default:
                            if(GoalAckInfoRe.test(info[1]))
                                return [ParserDisp.Continue, this];

                            let recipe = GoalRecipeRe.exec(info[1]);
                            if (recipe) {
                                if (this.goal)
                                    return [ParserDisp.Enter, new Recipe(this)];
                                else
                                    throw new Error(`Unexpected Recipe in ${recipe[1]}:${recipe[2]} before goal name`);
                            }
                            throw new Error(`Unexpected Goal Info ${info[1]}`);
                        }
                } else {
                    if(GoalVarsRe.test(line))
                        return [ParserDisp.Continue, this];
                }
            }
            let goal = GoalRe.exec(line);
            if (goal) {
                if (this.goal)
                    throw new Error("Unexpected multiple goals per Goal section");
                if (AutomakeAuxRe.test(goal[1]) || GNUMakeAuxiliaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_auxiliary;
                else if (AutomakePrimaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_primary;
                else if (AutomakeNoiseRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_noise;
                this.goal = goal[1];
                return [ParserDisp.Continue, this];
            }
        }
        throw new Error(`Unexpected Goal line ${line}`);
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    goal: string | undefined = undefined;
    flags: number = Goal.Flags.None;
}

const LinkerRe = /\$\(LINK\)\s/;
const RanlibRe = /\$\(RANLIB\)\s/;
/**
 * Parse an unexpanded build recipe for a target.
 * Currently no information is captured, but it could be used to learn
 * what kind of target it is (eg, if `@ref $(LINK)` or `$(COMPILE)` is referenced
 */
export class Recipe implements Parser {
    constructor(goal: Goal) { this.goal = goal; }
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "")
            return [ParserDisp.Leave, this];
        if (LinkerRe.test(line))
            this.goal.flags |= Goal.Flags.Linked_binary;
        if (RanlibRe.test(line))
            this.goal.flags |= Goal.Flags.Static_library;
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
    goal: Goal;
}
