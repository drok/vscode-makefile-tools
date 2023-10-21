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
    Copyright, /* # GNU make 4.1 ... */
    Database, /* --print-data-base dump */
    Trace, /* Execution trace */
}
const EnteringRE = /^# make(?:\[\d+\])?: (Entering|Leaving) directory '(.*)'$/;
const DatabaseRE = /^# Make data base, printed on (.*)$/;
export class Make implements Parser {
    constructor(dir: string)
    {
        this.dir = dir;
    }
    ingest (line: string) : [ParserDisp, Parser] {
        let entering = EnteringRE.exec(line);
        if (entering) {
            if (entering[1] == "Entering")
                return [ParserDisp.Enter, new Make(entering[2])];
            else
                return [ParserDisp.Leave, this];
        }

        let database = DatabaseRE.exec(line);
        if (database)
            return [ParserDisp.Enter, new EmptyLine(new Database())];

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
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in Make ${sub}`);
    }
    dir: string;
    goals: Goal[] = [];
    submake: Make[] = [];
}

const FilesRE = /^# Files$/;
export class Database implements Parser {
    // constructor() { this.goals = []; }
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
const GoalRecipeRe = /^recipe to execute \(from '(.*)', line (\d+)\):/;
const GoalsEndRe = /^# files hash-table stats:$/;
export class Goal implements Parser {
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
                                    return [ParserDisp.Enter, new Recipe()];
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
}

export class Recipe implements Parser {
    // constructor(goal: string) { this.goal = goal; }
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "")
            return [ParserDisp.Leave, this];
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
    // goal: string;
}
