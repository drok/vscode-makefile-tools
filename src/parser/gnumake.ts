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
import * as path from 'path';
import {Parser, ParserDisp, EmptyLine } from '../parser';
import { Executing } from './shell';
import { Node } from '../tree';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const chunkSize: number = 100;

enum MakeSection {
    Starting, /* pre Entering directory */
    Making, /* update target... */
    Copyright, /* # GNU make 4.1 ... */
    Database, /* --print-data-base dump */
    Padding, /* Extra output I don't care about */
}
export const EnteringRE = /^# make(?:\[\d+\])?: Entering directory '(.*)'$/;
const LeavingRE = /^# make(?:\[\d+\])?: Leaving directory '(.*)'$/;
const NothingRE = /^make(?:\[\d+\])?: Nothing to be done for '(.*)'\.$/;
export const ExecutingRE = /^(<builtin>|(.+):(\d+)): (?:update target '(.*)' due to: (?:.*)|target '(.*)' does not exist)$/;
const UptodateRE = /^make(?:\[\d+\])?: '(.*)' is up to date\.$/;
export const CopyrightRE = /^# GNU Make/;
const RecursingRE = /^Making (.*) in (.*)$/;
/**
 * Parse the stdout of a GNU make run, and expect a Dumped database,
 * directory entry/leaving trace messages, and expanded shell fragments would
 * be run when building the targets.
 * Calls Database, Executing parser to extract info about the current makefile,
 * and Make to parse submake output.
 */
export class Make implements Parser {
    constructor(dir: string, public root: string)
    {
        this.dir = path.relative(root, dir);
        this.section = MakeSection.Starting;
        let foundGoals = configuration.getAllBuildTargets().get(this.dir);
        if (foundGoals) {
            this.goals = foundGoals;
        } else {
            this.goals = new Map<string, Goal>();
            configuration.getAllBuildTargets().set(this.dir, this.goals);
        }
    }
    static makeArgs(): string[] { return [
        // take precedence over other parallel executions
        // specified in makefiles
        "-j1", "--output-sync=none",
        "--print-directory",
        // automake makefiles don't rely on builtin rules, so this makes the evaluation
        // a little faster, but the user could force custom rules which do rely on
        // builtin rules. If this is the case, the build be evaluated unexpectedly.
        // Relying on builtin rules would make the config non-portable, as it would need
        // GNU make.
        // TODO: How to tell the user his config is non-portable? Maybe allow a setting
        // "Allow non-portable config" ?
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        switch (this.section) {
            case MakeSection.Database:
                this.section = MakeSection.Padding;
                /* intentional fall-through, allows leaving immediately past Database */
            case MakeSection.Padding:
                let finished = DatabaseFinishedRE.test(line);
                if (finished) {
                    this.section = MakeSection.Making;
                    return [ParserDisp.Continue, this];
                }
            break;
            case MakeSection.Starting:
                this.section = MakeSection.Making;
                /* intentional fall-through */
            case MakeSection.Making:
                let leaving = LeavingRE.test(line);
                if (leaving) {
                    return [ParserDisp.Leave, this];
                }
                let executing = ExecutingRE.exec(line);
                if (executing) {
//                    if (this.file == "config.status" && false) { // FIXME: implement recursive detection. a single refresh is ok if configure.ac is newer
//                        // For some reason, reconfig was triggerred, meaning
//                        // --dry-run was not respected. Abort. this is a bug.
//                        throw new Error(`Unexpected reconfig in Make ${this.dir}. This is a bug.`);
//                    }
                    this.startExecuting(executing);
                    return [ParserDisp.Enter, new Executing(this)];
                }
                let uptodate = UptodateRE.exec(line);
                if (uptodate)
                    return [ParserDisp.Continue, this];
                let nothing = NothingRE.test(line);
                if (nothing)
                    return [ParserDisp.Continue, this];
                let entering = EnteringRE.exec(line);
                if (entering) { // This should only happen once at the top of the stack
                    // this.section = MakeSection.Making;
                    return [ParserDisp.Enter, new Make(entering[1], this.root)];
                }
                let copyright = CopyrightRE.test(line);
                if (copyright) {
                    this.section = MakeSection.Copyright;
                    return [ParserDisp.Continue, this];
                }
                break;
            case MakeSection.Copyright:
                let database = DatabaseRE.test(line);
                if (database) {
                    this.section = MakeSection.Database;
                    return [ParserDisp.Enter, new EmptyLine(new Database(this))];
                }
                break;
        }
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) : Parser | undefined {
        if (sub instanceof Database) {
            let targets = configuration.getAllBuildTargets();
            // FIXME: GNU make enters several times the same directory during --dry-run
            // Can the work of parsing additional enterings be avoided?
            // only save data for the all-recursive target
            if (!targets.has(this.dir) || true) {
                targets.set(this.dir, sub.goals);
                this.goals = sub.goals;
                this.test_suite = sub.test_suite;
                sub.variables.some((v) => {
                    switch (v.variable?.name) {
                        case "CONFIG_HEADER":
                            // Targets with spaces in their names are not supported
                            // because make doesn't support them, at least not without
                            // significant song and dance. If you need to support
                            // tests with spaces in their names, please send PR.
                            this.config_header = new Set(v.variable?.value.split(' '));
                            return true;
                    }
                    return false;
                });
                /* Copy the Bin_test flag for logs that are generated by built tests
                 * and attach the built test as a depend, so it can be run under the debugger
                 */
                if (this.test_suite && this.test_suite.depends) {
                    this.test_suite.depends = this.test_suite.depends.map((d) => {
                        if (!d.goal) return d;
                        let n = this.goals.get(d.goal);
                        return n || d;
                    });
                }

                // Replace the test programs with build targets if known
                for (let g of this.goals.values()) {
                    if ((g.flags & Goal.Flags.Test_Log) && g.depends && g.depends[0].goal) {
                        let d = this.goals.get(g.depends[0].goal);
                        if (d) {
                            g.depends=[d];
                        }
                    }
                }
            }
            return this;
        } else if (sub instanceof Make) {
            if (this == sub)
                throw new Error(`Unexpected push in Make ${sub}`);
            if (sub.dir == this.dir) {
                // Submakes in the same directory are removed, but parsed info merged into
                // this make.
                // config_header not merged because it's an automake Variable, should be
                // the same as automake does not do conditional headers.

                this.test_suite = this.test_suite || sub.test_suite;

                this.mergeSubmake(sub);
            } else
                this.submake.set(sub.dir, sub);
            return this;
        } else if (sub instanceof Executing) {
            if (this.section == MakeSection.Copyright) {
                // Do something about the collected command lines?
                // this.section == Copyright if Executing found the copyright. Ie,
                // Executions are complete.
                return this;
            }
            return new Executing(this);
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in Make ${sub}`);
    }

    // recursively merge a submake into my submake
    mergeSubmake(other: Make) {
        other.submake.forEach((submake,dir) => {
            var mysub = this.submake.get(dir);
            if (mysub) {
                mysub.mergeSubmake(submake);
            } else
                this.submake.set(dir, submake)
        })
        this.test_suite = other.test_suite;
    }
    public getFile(): string | undefined {
        return this.file;
    }
    public getDir(): string {
        return path.join(this.root, this.dir);
    }
    public finish(): void { this.section = MakeSection.Copyright; }
    public startExecuting(rea: RegExpExecArray) {
        if (rea[1] === "<builtin>" && !make.builtin_targets.has(this.dir + "/" + rea[4])) {
            logger.message(localize("gnumake.warn.builtin.rule",
                "WARN: Built-in rules used for {0} in {1}, potentially with unexpected/incomplete FLAGS. see https://autotools.mergesium.com/doc/builtin-rules",
                rea[4], this.dir));
            make.builtin_targets.add(this.dir + "/" + rea[4]);
        }
        this.file = rea[4] || rea[5];
    }
    dir: string = 'first';
    section: MakeSection;
    file: string | undefined;
    goals: Map<string,Goal>;
    config_header: Set<string> | undefined;
    submake: Map<string, Make> = new Map();
    /* builtins set prevents the same builtin warning to be printed multiple times */
    test_suite: Goal | undefined;
    stats: {
        tests: number;
        programs: number;
        subdirs: number;
        checks: number;
    } = {
        tests: 0,
        programs: 0,
        subdirs: 0,
        checks: 0
    };
}

const DatabaseRE = /^# Make data base, printed on (.*)$/;
const DatabaseFinishedRE = /^# Finished Make data base on (.*)$/;
const FilesRE = /^# Files$/;
const VariablesRE = /^# Variables$/;
/**
 * Parse a GNU make database dump to extract the list of build goals (targets)
 */
export class Database implements Parser {
    // constructor() { this.goals = []; }
    constructor (make: Make) {
        this.goals = make.goals;
    }
    static makeArgs(): string[] { return [
        "--print-data-base",
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (FilesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Goal())];
        if (VariablesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Variable())];
        return [ParserDisp.Continue, this];
            // throw new Error(`Unexpected line ${line}`);
    }
    push(sub: Parser) {
        if (sub instanceof Goal) {
            if (!sub.goal) { /* End-of-goals, at # files hash-table stats */
                return undefined;
            } else {
                /* Don't store automake auxiliary targets, they are thus
                 * unavailable for target selection
                 * Also skip noise targets because they are marginally useful, but
                 * nothing is implemented for them.
                 * Also skip not-targets (these are source files, not targets)
                 * Also skip targets without any flags
                 */
                if (sub.flags && !(sub.flags & (Goal.Flags.Automake_auxiliary |
                        Goal.Flags.Not_a_target |
                        Goal.Flags.Automake_noise
                        )))
                    this.goals.set(sub.goal, sub);

                if (sub.flags & Goal.Flags.Test_Suite) {
                    this.test_suite = sub;
                }
                // binaries that follow a test suite are always test programs
                // TODO: check automake source code. is this guaranteed?
                if (this.test_suite && (sub.flags & Goal.Flags.Linked_binary))
                    sub.flags |= Goal.Flags.Test_Program;
                return new Goal(); /* look for more Goals */
            }
        } else if (sub instanceof Variable) {
            if (!sub.flags) { /* End-of-variables */
                return sub;
            } else if (sub.variable) { /* gather only variables that were
                                        * interesting enough to collect */
                this.variables.push(sub);
            }
            return new Variable();
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in ${sub}`);
    }
    goals : Map<string,Goal>;
    variables : Variable[] = [];
    test_suite : Goal | undefined;
}

// Lines which have variable content, but I don't need them
// const VariableMakefileRe = /^# makefile \(from '(.*)', line (\d+)\)$/;
const VariableFlagsRe = /^# (makefile|environment|automatic|default|command|'override'|variable)/;
const VariableDefinitionRe = /^(.*) = (.*)$/;
/**
 * Parse information about a single variable, differentiating makefile,
 * environment, default (:=), command line, 'override' directives
 * and automatic variables.
 */
export class Variable implements Parser {
    public static readonly Flags = {
        None: 0,
        /* Variable maked as "makefile" */
        makefile: 1,

        /* other variables */
        other: 2,
    };
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.variable)
                throw new Error("Unexpected end of variable");
            return [ParserDisp.Leave, this];
        } else {
            if (!this.flags) {
                let flags = VariableFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "variable":
                            if (line == '# variable set hash-table stats:')
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected variable line '${line}'`);
                        case "makefile":
                            this.flags |= Variable.Flags.makefile;
                            break;
                        default:
                            this.flags |= Variable.Flags.other;
                            break;
                    }
                } else
                    throw new Error(`Unexpected variable line '${line}'`);
                return [ParserDisp.Continue, this];
            }
            if (this.flags & Variable.Flags.makefile) {
                let variable = VariableDefinitionRe.exec(line);
                if (variable) {
                    switch (variable[1]) {
                        case "TESTS": this.variable = { name: variable[1], value: variable[2] }; break;
                    }
                }
            }
        }
        return [ParserDisp.Leave, this];
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    variable: { name: string, value : string } | undefined;
    flags: number = Goal.Flags.None;
}

const GoalInfoRe = /^#  (.*)$/;
// Lines which have variable content, but I don't need them
const GoalAckInfoRe = /^(?:Implicit\/static pattern stem:|Last modified)/;
const GoalVarsRe = /^# (?:automatic|. :=|variable set hash-table stats:|Load=)/;
const GoalFlagsRe = /^# (.*):$/;
const GoalRe = /^(.*): ?(.*)$/;
const AutomakePrimaryRe = /^(?:all|check|distcheck|install)$/;
const GNUMakeAuxiliaryRe = new RegExp('^\.(?:' +
    '(PHONY|SUFFIXES|PRECIOUS|NOEXPORT|MAKE)' +
    ')$');
/* Auxiliary goals are internally used by automake. They are dropped by the parser */
const AutomakeAuxRe = /(?:-recursive|-am|config.status|Makefile|stamp-h1|^am--.*|^\.deps\/.*|^\.DEFAULT|^\.obj|^\.c|^\.o|^\.c\.o|^\.c\.obj|^\.trs|^\.log\.trs|.*\.trs|depcomp|compile|missing|install-sh|Makefile.am)$/;
/* Noise targets are those a user most likely never wants to build from a gui */
const AutomakeNoiseRe = new RegExp('^(' +
    'ID|GTAGS|TAGS|CTAGS|tags|ctags|cscope|cscope\\.files|cscopelist|' +
    'installdirs|distcleancheck|distuninstallcheck|distdir|' +
    'mostlyclean|maintainer-clean-generic|mostlyclean-generic|clean-cscope|clean|' +
    'dist.*|uninstall-.*|install-.*|maintainer-.*|distclean-.*|installcheck|check-TESTS|' +
    'ps|html|pdf|clean-.*|info|mostlyclean|dvi|' +
    '.*\\.o|.*\\.h|' +
    'Makefile.in)$');
const AutomakeTestLogRe = /^.*\.log$/;
const GoalRecipeRe = /^recipe to execute \((built-in|from '(.*)', line (\d+))\):/;
const GoalsEndRe = /^# files hash-table stats:$/;
/**
 * Parse information about a single goal, differentiating phony targets,
 * and expandable to handle other flags that Make keeps about each target
 * (eg, whether it is up-to-date). Calls the Recipe to parse the build recipe
 * if any.
 */
export class Goal extends Node implements Parser {
    public static readonly Flags = {
        None: 0,
        /* Test status, filled when task runs. 3-bits = make.TRS */
        Test_Result_Mask: 7,

        /* Flags gathered from Make (phony, etc) */
        Not_a_target: 8,

        /* Well-known automake targets */
        Automake_primary: 16,
        Automake_auxiliary: 32,
        Automake_noise: 64,


        /* Flags gathered from automake (recipe hints like $(LINK) */
        Linked_binary: 256,
        Static_library: 512,
        Test_Suite: 1024,
        Test_Program: 2048,
        Test_Log: 4096,
        Library: 8192,
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
                        case "Failed to be updated.":
                            /* FIXME: This should be handled */
                            return [ParserDisp.Continue, this];
                        case "Builtin rule":
                            /* FIXME: Should warn user of non-portable if builtins are used */
                            return [ParserDisp.Continue, this];
                        default:
                            if(GoalAckInfoRe.test(info[1]))
                                return [ParserDisp.Continue, this];

                            let recipe = GoalRecipeRe.exec(info[1]);
                            if (recipe) {
                                if (this.goal)
                                    return [ParserDisp.Enter, new Recipe(this)];
                                else
                                    throw new Error(`Unexpected Recipe in ${recipe[2]}:${recipe[3]} before goal name`);
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
                if (goal[2]) {
                    if (this.goal == "test-suite.log") {
                        this.flags |= Goal.Flags.Test_Suite;
                        this.depends = goal[2].split(' ')
                            .filter(s => s)
                            .map(s => new Goal(s, Goal.Flags.Test_Log));
                    } else if (AutomakeTestLogRe.test(goal[1])) {
                        this.flags |= Goal.Flags.Test_Log;
                        this.depends = goal[2].split(' ')
                            .map(s => new Goal(s, Goal.Flags.Test_Program));
                    }
                } else if (!this.flags) {
                    // .test.log: (ie, implicit rules)
                    this.flags |= Goal.Flags.Automake_noise;
                }
                return [ParserDisp.Continue, this];
            }
        }
        throw new Error(`Unexpected Goal line ${line}`);
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    getChildren(): Node[] {
        return [];
    }
    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this.goal || "unk");
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.tooltip = localize("automake.goal.tooltip", "FIXME: better tooltip");
        item.contextValue = [
            `nodeType=buildTarget`,
        ].join(',');
        return item;
    }
    logfile(): string | undefined {
        return undefined;
    }

    constructor(public goal: string | undefined = undefined,
        public flags: number = Goal.Flags.None) {
        super();
    }
    depends: Goal[] | undefined = undefined;
    task: vscode.Task | undefined;
    test: vscode.TestItem | undefined;
}

const LibraryRe = /\.(la|a|so|dll)$/;
const LinkerRe = /\$\(\w*LINK\)\s/;
const RanlibRe = /\$\(RANLIB\)\s/;
const TestRe = /\$\(AM_TESTS_FD_REDIRECT\)\s/;
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
        if (LinkerRe.test(line)) {
            if (this.goal.goal && LibraryRe.test(this.goal.goal))
                this.goal.flags |= Goal.Flags.Library;
            else
                this.goal.flags |= Goal.Flags.Linked_binary;
        } else if (RanlibRe.test(line)) {
            this.goal.flags |= Goal.Flags.Static_library;
        }
        if (TestRe.test(line))
            this.goal.flags |= Goal.Flags.Test_Log;
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
    goal: Goal;
}
